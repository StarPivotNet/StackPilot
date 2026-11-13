import { createHash, randomBytes, sign, type KeyObject } from "node:crypto";
import { request } from "node:https";
import { sshHelperSignaturePayload, SshHelperEnrolledSchema, SshHelperStateSchema, SshSessionSchema, type SshSession, type SshPolicy, type SshHelperReport, type SshTakeoverReceipt } from "@stackpilot/contracts";

export type HelperIdentity = { nodeId: string; credentialId: string; privateKey: KeyObject };
export class ControllerError extends Error { constructor(readonly status: number) { super(`SSH Controller request failed (${status})`); } }
export class ControllerClient {
  private readonly base: URL;
  constructor(url: string, private readonly ca?: string) {
    this.base = new URL(url);
    if (this.base.protocol !== "https:" || this.base.username || this.base.password || this.base.hash || this.base.search || this.base.pathname !== "/") throw new Error("SSH Controller must be an HTTPS origin");
  }
  async call(path: string, method: "GET" | "POST", value?: unknown, identity?: HelperIdentity): Promise<unknown> {
    if (!path.startsWith("/api/ssh-helper/") || path.includes("..") || path.includes("#")) throw new Error("Invalid SSH helper endpoint");
    const raw = value === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(value));
    const headers: Record<string, string> = { "Content-Type": "application/json", "Content-Length": String(raw.length) };
    if (identity) {
      const auth = { nodeId: identity.nodeId, credentialId: identity.credentialId, timestamp: new Date().toISOString(), nonce: randomBytes(18).toString("base64url") };
      headers["X-StackPilot-Ssh-Protocol"] = "1"; headers["X-StackPilot-Ssh-Node"] = auth.nodeId; headers["X-StackPilot-Ssh-Credential"] = auth.credentialId; headers["X-StackPilot-Ssh-Time"] = auth.timestamp; headers["X-StackPilot-Ssh-Nonce"] = auth.nonce;
      headers["X-StackPilot-Ssh-Signature"] = sign(null, Buffer.from(sshHelperSignaturePayload({ ...auth, method, path, bodySha256: createHash("sha256").update(raw).digest("hex") })), identity.privateKey).toString("base64url");
    }
    return new Promise((resolve, reject) => {
      const call = request(new URL(path, this.base), { method, headers, ...(this.ca ? { ca: this.ca } : {}), signal: AbortSignal.timeout(5000) }, response => {
        const chunks: Buffer[] = []; let size = 0;
        response.on("error", reject); response.on("data", (chunk: Buffer) => { size += chunk.length; if (size > 1024 * 1024) response.destroy(new Error("SSH Controller response too large")); else chunks.push(chunk); });
        response.on("end", () => {
          if (response.statusCode !== 200 && response.statusCode !== 201) { reject(new ControllerError(response.statusCode ?? 503)); return; }
          try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { reject(new Error("Invalid SSH Controller response")); }
        });
      }); call.on("error", reject); call.end(raw);
    });
  }
  async enroll(token: string, publicKey: string) { return SshHelperEnrolledSchema.parse(await this.call("/api/ssh-helper/enroll", "POST", { enrollmentToken: token, publicKey })); }
  async authenticate(identity: HelperIdentity, account: string, password: string, connectionId: string) {
    const value = SshSessionSchema.parse(await this.call("/api/ssh-helper/authenticate", "POST", { account, password, connectionId }, identity));
    if (value.nodeId !== identity.nodeId || value.account !== account || value.connectionId !== connectionId || value.terminatedAt || value.terminationRequestedAt || Date.parse(value.expiresAt) <= Date.parse(value.startedAt) || Date.parse(value.expiresAt) - Date.parse(value.startedAt) > 28_800_000) throw new Error("Invalid SSH session binding");
    return value;
  }
  async state(identity: HelperIdentity) { return SshHelperStateSchema.parse(await this.call("/api/ssh-helper/state", "GET", undefined, identity)); }
  async acknowledge(identity: HelperIdentity, session: SshSession) { await this.call("/api/ssh-helper/sessions/ack", "POST", { sessionId: session.id, connectionId: session.connectionId }, identity); }
  async policyAck(identity: HelperIdentity, policy: SshPolicy, applied: boolean, systemUid: number | null = null) { await this.call("/api/ssh-helper/policies/ack", "POST", { policyId: policy.id, revision: policy.revision, enabled: policy.enabled, applied, systemUid }, identity); }
  async report(identity: HelperIdentity, report: SshHelperReport) { await this.call("/api/ssh-helper/report", "POST", report, identity); }
  async takeoverReceipt(identity: HelperIdentity, receipt: SshTakeoverReceipt) { await this.call("/api/ssh-helper/takeover-receipts", "POST", receipt, identity); }
}
