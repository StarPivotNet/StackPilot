import { createHash, randomBytes, sign, verify } from "node:crypto";
import { AGENT_PROTOCOL_VERSION, AGENT_REQUEST_TIME_WINDOW_MS, agentSignaturePayload } from "@stackpilot/contracts";
import type { AgentIdentity } from "../identity/identityStore.js";

export const DATA_PLANE_AUTH_HEADERS = {
  nodeId: "x-stackpilot-node-id",
  credentialId: "x-stackpilot-credential-id",
  timestamp: "x-stackpilot-timestamp",
  nonce: "x-stackpilot-nonce",
  signature: "x-stackpilot-signature",
  protocol: "x-stackpilot-protocol",
} as const;

export type DataPlaneIdentity = Pick<AgentIdentity, "nodeId" | "credentialId" | "privateKey">;

export type DataPlaneAuthFailure =
  | "DATA_PLANE_AUTH_MISSING"
  | "DATA_PLANE_AUTH_VERSION"
  | "DATA_PLANE_AUTH_TIME"
  | "DATA_PLANE_AUTH_UNKNOWN_PEER"
  | "DATA_PLANE_AUTH_SIGNATURE"
  | "DATA_PLANE_AUTH_REPLAY";

export type DataPlaneHeaders = Record<string, string | string[] | undefined>;

const headerValue = (headers: DataPlaneHeaders, name: string) => {
  const value = headers[name];
  return typeof value === "string" ? value.trim() : "";
};

/** Same canonical payload as the Controller channel, so one signed request format covers both planes. */
export function signDataPlaneRequest(identity: DataPlaneIdentity, method: string, path: string, body: Buffer, now: Date = new Date()) {
  const timestamp = now.toISOString();
  const nonce = randomBytes(18).toString("base64url");
  const bodySha256 = createHash("sha256").update(body).digest("hex");
  const payload = agentSignaturePayload({ protocolVersion: AGENT_PROTOCOL_VERSION, nodeId: identity.nodeId, credentialId: identity.credentialId, method, path, timestamp, nonce, bodySha256 });
  const signature = sign(null, Buffer.from(payload), identity.privateKey).toString("base64url");
  return {
    protocol: AGENT_PROTOCOL_VERSION,
    nodeId: identity.nodeId,
    credentialId: identity.credentialId,
    timestamp,
    nonce,
    signature,
    bodySha256,
    headers: {
      [DATA_PLANE_AUTH_HEADERS.nodeId]: identity.nodeId,
      [DATA_PLANE_AUTH_HEADERS.credentialId]: identity.credentialId,
      [DATA_PLANE_AUTH_HEADERS.timestamp]: timestamp,
      [DATA_PLANE_AUTH_HEADERS.nonce]: nonce,
      [DATA_PLANE_AUTH_HEADERS.signature]: signature,
      [DATA_PLANE_AUTH_HEADERS.protocol]: AGENT_PROTOCOL_VERSION,
    } as Record<string, string>,
  };
}

/** Replay guard for the data plane; the Controller keeps its nonces in the repository, a peer keeps them here. */
export class DataPlaneNonceCache {
  private readonly seen = new Map<string, number>();
  constructor(private readonly now: () => number = Date.now, private readonly limit = 4_096) {}

  claim(nodeId: string, nonce: string, ttlMs = AGENT_REQUEST_TIME_WINDOW_MS) {
    const at = this.now();
    for (const [key, expiresAt] of this.seen) if (expiresAt <= at) this.seen.delete(key);
    const key = `${nodeId}\u0000${nonce}`;
    if (this.seen.has(key)) return false;
    if (this.seen.size >= this.limit) { const oldest = this.seen.keys().next(); if (!oldest.done) this.seen.delete(oldest.value); }
    this.seen.set(key, at + ttlMs);
    return true;
  }
}

export type DataPlaneVerification = { ok: true; nodeId: string; credentialId: string } | { ok: false; code: DataPlaneAuthFailure };

export function verifyDataPlaneRequest(input: {
  method: string;
  path: string;
  body: Buffer;
  headers: DataPlaneHeaders;
  resolvePublicKey: (nodeId: string) => string | null;
  nonces: DataPlaneNonceCache;
  now?: () => number;
}): DataPlaneVerification {
  const nodeId = headerValue(input.headers, DATA_PLANE_AUTH_HEADERS.nodeId);
  const credentialId = headerValue(input.headers, DATA_PLANE_AUTH_HEADERS.credentialId);
  const timestamp = headerValue(input.headers, DATA_PLANE_AUTH_HEADERS.timestamp);
  const nonce = headerValue(input.headers, DATA_PLANE_AUTH_HEADERS.nonce);
  const signature = headerValue(input.headers, DATA_PLANE_AUTH_HEADERS.signature);
  const protocolVersion = headerValue(input.headers, DATA_PLANE_AUTH_HEADERS.protocol);
  if (!nodeId || !credentialId || !timestamp || !nonce || !signature) return { ok: false, code: "DATA_PLANE_AUTH_MISSING" };
  if (protocolVersion !== AGENT_PROTOCOL_VERSION) return { ok: false, code: "DATA_PLANE_AUTH_VERSION" };
  const requestTime = Date.parse(timestamp);
  if (!Number.isFinite(requestTime) || Math.abs((input.now ?? Date.now)() - requestTime) > AGENT_REQUEST_TIME_WINDOW_MS) {
    return { ok: false, code: "DATA_PLANE_AUTH_TIME" };
  }
  const publicKey = input.resolvePublicKey(nodeId);
  if (!publicKey) return { ok: false, code: "DATA_PLANE_AUTH_UNKNOWN_PEER" };
  const payload = agentSignaturePayload({
    protocolVersion, nodeId, credentialId, method: input.method, path: input.path, timestamp, nonce,
    bodySha256: createHash("sha256").update(input.body).digest("hex"),
  });
  let valid = false;
  try { valid = verify(null, Buffer.from(payload), publicKey, Buffer.from(signature, "base64url")); } catch { valid = false; }
  if (!valid) return { ok: false, code: "DATA_PLANE_AUTH_SIGNATURE" };
  if (!input.nonces.claim(nodeId, nonce)) return { ok: false, code: "DATA_PLANE_AUTH_REPLAY" };
  return { ok: true, nodeId, credentialId };
}
