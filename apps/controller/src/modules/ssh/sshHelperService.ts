import { createPublicKey, randomUUID, verify } from "node:crypto";
import type Database from "better-sqlite3";
import { sshHelperSignaturePayload, type SshHelperAuth, SshHelperReportSchema, SshHostSchema, SshCredentialSchema, SshSessionSchema } from "@stackpilot/contracts";
import type { z } from "zod";
import type { AuditRepository } from "../../audit/auditRepository.js";
import { digest, randomToken } from "../../security/crypto.js";
import { ServiceError } from "../serviceError.js";

const unauthorized = () => new ServiceError(401, "UNAUTHORIZED", "SSH helper 身份无效");
export class SshHelperService {
  constructor(private readonly db: Database.Database, private readonly audit: AuditRepository, private readonly clock = () => Date.now()) {}
  private now() { return new Date(this.clock()).toISOString(); }
  private activeNode(id: string) { return !!this.db.prepare("SELECT 1 FROM agent_nodes WHERE node_id=? AND revoked_at IS NULL").get(id); }
  private event(nodeId: string, actorId: string, action: string, actorType: "user" | "ssh-helper" = "ssh-helper") {
    this.audit.append({ actorType, actorId, source: "ssh-helper-protocol", targetType: "node", targetId: nodeId, action: `ssh.helper.${action}`, parameters: { nodeId }, outcome: "success", authorization: actorType === "user" ? "session+rbac+node-scope+reauth" : "purpose-bound-node-identity", requestId: randomUUID() });
  }
  createEnrollment(nodeId: string, actorId: string) {
    return this.db.transaction(() => {
      if (!this.activeNode(nodeId)) throw new ServiceError(404, "NOT_FOUND", "节点不存在或已撤销");
      const token = randomToken(); const id = randomUUID(); const expiresAt = new Date(this.clock() + 300_000).toISOString();
      this.db.prepare("UPDATE ssh_helper_enrollments SET revoked_at=? WHERE node_id=? AND used_at IS NULL AND revoked_at IS NULL").run(this.now(), nodeId);
      this.db.prepare("INSERT INTO ssh_helper_enrollments(id,node_id,token_digest,expires_at) VALUES(?,?,?,?)").run(id, nodeId, digest(token), expiresAt);
      this.event(nodeId, actorId, "enrollment.created", "user"); return { id, nodeId, token, expiresAt };
    }).immediate();
  }
  enroll(token: string, publicKey: string) {
    let canonical: string;
    try { const key = createPublicKey(publicKey); if (key.asymmetricKeyType !== "ed25519") throw unauthorized(); canonical = key.export({ type: "spki", format: "pem" }).toString(); } catch { throw unauthorized(); }
    return this.db.transaction(() => {
      const row = this.db.prepare("SELECT id,node_id FROM ssh_helper_enrollments WHERE token_digest=? AND used_at IS NULL AND revoked_at IS NULL AND expires_at>?").get(digest(token), this.now()) as { id: string; node_id: string } | undefined;
      if (!row || !this.activeNode(row.node_id)) throw unauthorized();
      this.db.prepare("UPDATE ssh_helper_enrollments SET used_at=? WHERE id=?").run(this.now(), row.id);
      this.revokeNode(row.node_id);
      const credentialId = randomUUID();
      this.db.prepare("INSERT INTO ssh_helper_credentials(id,node_id,public_key,created_at) VALUES(?,?,?,?)").run(credentialId, row.node_id, canonical, this.now());
      this.event(row.node_id, credentialId, "enrolled");
      return { nodeId: row.node_id, credentialId, protocolVersion: "1" };
    }).immediate();
  }
  revokeNode(nodeId: string) {
    this.db.prepare("UPDATE ssh_helper_credentials SET revoked_at=? WHERE node_id=? AND revoked_at IS NULL").run(this.now(), nodeId);
    const row = this.db.prepare("SELECT payload FROM ssh_hosts WHERE node_id=?").get(nodeId) as { payload: string } | undefined;
    if (row) {
      const host = SshHostSchema.parse(JSON.parse(row.payload));
      host.available = false; host.reason = "SSH helper 身份变更，需要重新验证";
      this.db.prepare("UPDATE ssh_hosts SET helper_revoked_at=?,verification_id=NULL,payload=? WHERE node_id=?").run(this.now(), JSON.stringify(host), nodeId);
    }
    for (const entry of this.db.prepare("SELECT payload FROM ssh_credentials WHERE node_id=?").all(nodeId) as { payload: string }[]) {
      const value = SshCredentialSchema.parse(JSON.parse(entry.payload)); value.revokedAt ??= this.now();
      this.db.prepare("UPDATE ssh_credentials SET payload=? WHERE id=?").run(JSON.stringify(value), value.id);
    }
    for (const entry of this.db.prepare("SELECT payload FROM ssh_sessions WHERE node_id=?").all(nodeId) as { payload: string }[]) {
      const value = SshSessionSchema.parse(JSON.parse(entry.payload));
      if (!value.terminatedAt) value.terminationRequestedAt ??= this.now();
      this.db.prepare("UPDATE ssh_sessions SET payload=? WHERE id=?").run(JSON.stringify(value), value.id);
    }
  }
  revoke(nodeId: string, actorId: string) {
    this.db.transaction(() => { if (!this.activeNode(nodeId)) throw new ServiceError(404, "NOT_FOUND", "节点不存在"); this.revokeNode(nodeId); this.db.prepare("UPDATE ssh_helper_enrollments SET revoked_at=? WHERE node_id=? AND used_at IS NULL AND revoked_at IS NULL").run(this.now(), nodeId); this.event(nodeId, actorId, "revoked", "user"); }).immediate();
  }
  authenticate(auth: SshHelperAuth, request: { method: string; path: string; bodySha256: string }) {
    if (Math.abs(this.clock() - Date.parse(auth.timestamp)) > 300_000 || !Number.isFinite(Date.parse(auth.timestamp))) throw unauthorized();
    const row = this.db.prepare("SELECT public_key FROM ssh_helper_credentials WHERE id=? AND node_id=? AND revoked_at IS NULL").get(auth.credentialId, auth.nodeId) as { public_key: string } | undefined;
    if (!row || !this.activeNode(auth.nodeId)) throw unauthorized();
    try { if (!verify(null, Buffer.from(sshHelperSignaturePayload({ ...auth, ...request })), createPublicKey(row.public_key), Buffer.from(auth.signature, "base64url"))) throw unauthorized(); } catch { throw unauthorized(); }
    this.db.transaction(() => {
      const active = this.db.prepare("SELECT 1 FROM ssh_helper_credentials WHERE id=? AND revoked_at IS NULL").get(auth.credentialId);
      if (!active || !this.activeNode(auth.nodeId)) throw unauthorized();
      this.db.prepare("DELETE FROM ssh_helper_nonces WHERE expires_at<=?").run(this.now());
      if (this.db.prepare("SELECT 1 FROM ssh_helper_nonces WHERE credential_id=? AND nonce=?").get(auth.credentialId, auth.nonce)) throw new ServiceError(409, "BAD_REQUEST", "SSH helper 请求已使用");
      this.db.prepare("INSERT INTO ssh_helper_nonces(credential_id,nonce,expires_at) VALUES(?,?,?)").run(auth.credentialId, auth.nonce, new Date(Math.max(this.clock(), Date.parse(auth.timestamp)) + 300_001).toISOString());
    }).immediate();
    return { nodeId: auth.nodeId, credentialId: auth.credentialId };
  }
  report(identity: { nodeId: string; credentialId: string }, report: z.infer<typeof SshHelperReportSchema>) {
    if (Math.abs(this.clock() - Date.parse(report.collectedAt)) > 300_000) throw new ServiceError(400, "BAD_REQUEST", "SSH helper 采集时间无效");
    const result = this.db.prepare("UPDATE ssh_helper_credentials SET report=? WHERE id=? AND node_id=? AND revoked_at IS NULL").run(JSON.stringify(report), identity.credentialId, identity.nodeId);
    if (!result.changes || !this.activeNode(identity.nodeId)) throw unauthorized();
    // Readiness reports are observations, never independent SSH verification.
    return { accepted: true, controllerTime: this.now() };
  }
}
