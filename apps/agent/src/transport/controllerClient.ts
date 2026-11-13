import { createHash, randomBytes, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { request } from "node:https";
import { AGENT_FEATURE_DATABASE_INVENTORY, AGENT_FEATURE_FIREWALL_DENY_SNAPSHOT, AGENT_FEATURE_PHYSICAL_HOST_IDENTITY, AGENT_FEATURE_SYSTEMD_SNAPSHOT, AGENT_PROTOCOL_VERSION, agentSignaturePayload, type AgentEnrollmentRequest } from "@stackpilot/contracts";
import type { AgentIdentity } from "../identity/identityStore.js";

class ControllerRequestError extends Error {
  constructor(readonly status: number) { super(`Controller request failed with status ${status}`); }
}

export class ControllerClient {
  private ca: Buffer | null = null;
  private agentFeatures = new Set<string>();
  constructor(private readonly baseUrl: string, private readonly caPath: string) {}
  private async trustedCa() { this.ca ??= await readFile(this.caPath); return this.ca; }
  async json<T>(path: string, body: unknown, identity?: AgentIdentity): Promise<T> {
    try { return await this.requestJson<T>(path, body, identity); }
    catch (error) {
      if (!(error instanceof ControllerRequestError) || error.status !== 400 || !identity || path !== "/api/agent/heartbeat" || !body || typeof body !== "object" || !("physicalHostId" in body)) throw error;
      const compatibleBody = { ...(body as Record<string, unknown>) }; delete compatibleBody.physicalHostId;
      return this.requestJson<T>(path, compatibleBody, identity);
    }
  }
  /** Signed GET for small control-plane reads; the Controller verifies the same canonical payload. */
  async get<T>(path: string, identity: AgentIdentity): Promise<T> { return this.requestJson<T>(path, undefined, identity, "GET"); }
  private async requestJson<T>(path: string, body: unknown, identity?: AgentIdentity, method: "POST" | "GET" = "POST"): Promise<T> {
    const raw = method === "GET" ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body), "utf8"); const url = new URL(path, this.baseUrl);
    const headers: Record<string, string> = { "Content-Type": "application/json", "Content-Length": String(raw.length), "X-StackPilot-Protocol": AGENT_PROTOCOL_VERSION };
    if (identity) {
      const timestamp = new Date().toISOString(); const nonce = randomBytes(18).toString("base64url"); const bodySha256 = createHash("sha256").update(raw).digest("hex");
      const payload = agentSignaturePayload({ protocolVersion: AGENT_PROTOCOL_VERSION, nodeId: identity.nodeId, credentialId: identity.credentialId, method, path: `${url.pathname}${url.search}`, timestamp, nonce, bodySha256 });
      Object.assign(headers, { "X-StackPilot-Node-Id": identity.nodeId, "X-StackPilot-Credential-Id": identity.credentialId, "X-StackPilot-Timestamp": timestamp, "X-StackPilot-Nonce": nonce, "X-StackPilot-Signature": sign(null, Buffer.from(payload), identity.privateKey).toString("base64url") });
    }
    const ca = await this.trustedCa();
    return new Promise<T>((resolvePromise, rejectPromise) => {
      const req = request(url, { method, ca, rejectUnauthorized: true, headers, timeout: 10_000 }, (response) => {
        const features = typeof response.headers["x-stackpilot-agent-features"] === "string" ? response.headers["x-stackpilot-agent-features"].split(",").map((feature) => feature.trim()).filter(Boolean) : [];
        this.agentFeatures = new Set(features);
        const chunks: Buffer[] = []; let size = 0;
        response.on("data", (chunk: Buffer) => { size += chunk.length; if (size <= 256 * 1024) chunks.push(chunk); else req.destroy(new Error("Controller 响应过大")); });
        response.on("end", () => { try { const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as T; if ((response.statusCode ?? 500) >= 400) rejectPromise(new ControllerRequestError(response.statusCode ?? 500)); else resolvePromise(parsed); } catch (error) { rejectPromise(error); } });
      });
      req.on("timeout", () => req.destroy(new Error("Controller 请求超时"))); req.on("error", rejectPromise); if (method === "GET") req.end(); else req.end(raw);
    });
  }
  supportsDatabaseInventory() { return this.agentFeatures.has(AGENT_FEATURE_DATABASE_INVENTORY); }
  supportsPhysicalHostIdentity() { return this.agentFeatures.has(AGENT_FEATURE_PHYSICAL_HOST_IDENTITY); }
  supportsSystemdSnapshot() { return this.agentFeatures.has(AGENT_FEATURE_SYSTEMD_SNAPSHOT); }
  supportsFirewallDenySnapshot() { return this.agentFeatures.has(AGENT_FEATURE_FIREWALL_DENY_SNAPSHOT); }
  enroll(input: AgentEnrollmentRequest) { return this.json("/api/agent/enroll", input); }
}
