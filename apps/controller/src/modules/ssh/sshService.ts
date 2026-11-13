import { createHash, randomBytes, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { SshCredentialSchema, SshHostSchema, SshHelperReportSchema, SshPolicySchema, SshSessionSchema, SshTakeoverPlanSchema, SSH_LOGIN_WINDOW_SECONDS, sshAccountName, type SshCredential, type SshPolicy, type SshPolicyInput, type SshSession } from "@stackpilot/contracts";
import type { Principal } from "../../identity/types.js";
import type { AuditRepository } from "../../audit/auditRepository.js";
import { ServiceError } from "../serviceError.js";

const unavailable = () => new ServiceError(503, "NOT_READY", "SSH 主机执行器及独立验证尚未就绪，不能接管或签发可用凭据");
const denied = () => new ServiceError(403, "FORBIDDEN", "SSH 授权无效或已撤销");
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
type PayloadRow = { payload: string };

/** Only trusted host adapters may call authentication/acknowledgement methods.
 * They are deliberately not exposed through the management HTTP router. */
export class SshService {
  constructor(private readonly db: Database.Database, private readonly audit: AuditRepository, private readonly clock = () => Date.now()) {}
  private now() { return new Date(this.clock()).toISOString(); }
  private record(actor: string, nodeId: string, action: string, targetId: string, parameters: unknown = {}, outcome = "success") {
    const helper = actor.startsWith("helper:");
    this.audit.append({ actorType: helper ? "ssh-helper" : "user", actorId: helper ? actor.slice(7) : actor, source: "ssh-service", targetType: "ssh", targetId, action: `ssh.${action}`, parameters: { nodeId, ...(parameters as object) }, outcome, authorization: helper ? "signed-node-helper" : "session+rbac+node-scope", requestId: randomUUID() });
  }
  private userAllowed(userId: string, nodeId: string) {
    return !!this.db.prepare(`SELECT 1 FROM users u WHERE u.id=? AND u.disabled_at IS NULL
      AND EXISTS(SELECT 1 FROM user_roles ur JOIN role_permissions rp ON rp.role_id=ur.role_id WHERE ur.user_id=u.id AND rp.permission_key='ssh:connect')
      AND (EXISTS(SELECT 1 FROM user_roles ur WHERE ur.user_id=u.id AND ur.role_id='administrator') OR EXISTS(SELECT 1 FROM user_node_scopes ns WHERE ns.user_id=u.id AND ns.node_id=?))`).get(userId, nodeId);
  }
  private nodeActive(nodeId: string) { return !!this.db.prepare("SELECT 1 FROM agent_nodes WHERE node_id=? AND revoked_at IS NULL").get(nodeId); }
  private policy(id: string): SshPolicy {
    const row = this.db.prepare("SELECT payload FROM ssh_policies WHERE id=?").get(id) as PayloadRow | undefined;
    if (!row) throw new ServiceError(404, "NOT_FOUND", "SSH 授权不存在");
    return SshPolicySchema.parse(JSON.parse(row.payload));
  }
  private ready(nodeId: string) {
    const row = this.db.prepare("SELECT payload,verification_id,helper_revoked_at FROM ssh_hosts WHERE node_id=?").get(nodeId) as (PayloadRow & { verification_id: string | null; helper_revoked_at: string | null }) | undefined;
    if (!row || !row.verification_id || row.helper_revoked_at || !this.nodeActive(nodeId)) throw unavailable();
    const host = SshHostSchema.parse(JSON.parse(row.payload));
    if (host.state !== "managed" || !host.available || !host.address.trim() || !host.fingerprints.length || !host.collectedAt || this.clock() - Date.parse(host.collectedAt) > 30_000 || Date.parse(host.collectedAt) > this.clock() + 5_000) throw unavailable();
    return host;
  }
  private writeCredential(value: SshCredential) { this.db.prepare("UPDATE ssh_credentials SET payload=? WHERE id=?").run(JSON.stringify(value), value.id); }
  private writeSession(value: SshSession) { this.db.prepare("UPDATE ssh_sessions SET payload=? WHERE id=?").run(JSON.stringify(value), value.id); }
  private invalidate(policyId: string) {
    const now = this.now();
    for (const row of this.db.prepare("SELECT payload FROM ssh_credentials WHERE policy_id=?").all(policyId) as PayloadRow[]) {
      const credential = SshCredentialSchema.parse(JSON.parse(row.payload));
      if (!credential.revokedAt) { credential.revokedAt = now; this.writeCredential(credential); }
      this.terminateCredentialSessions(credential.id, now);
    }
  }
  private terminateCredentialSessions(id: string, now: string) {
    for (const row of this.db.prepare("SELECT payload FROM ssh_sessions WHERE credential_id=?").all(id) as PayloadRow[]) {
      const session = SshSessionSchema.parse(JSON.parse(row.payload));
      if (!session.terminatedAt && !session.terminationRequestedAt) { session.terminationRequestedAt = now; this.writeSession(session); }
    }
  }
  reconcile() {
    this.db.transaction(() => {
      for (const row of this.db.prepare("SELECT payload FROM ssh_policies").all() as PayloadRow[]) {
        const policy = SshPolicySchema.parse(JSON.parse(row.payload));
        if (!policy.enabled || !this.userAllowed(policy.userId, policy.nodeId) || !this.nodeActive(policy.nodeId)) this.invalidate(policy.id);
      }
      for (const row of this.db.prepare("SELECT payload FROM ssh_sessions").all() as PayloadRow[]) {
        const session = SshSessionSchema.parse(JSON.parse(row.payload));
        if (!session.terminatedAt && !session.terminationRequestedAt && Date.parse(session.expiresAt) <= this.clock()) { session.terminationRequestedAt = this.now(); this.writeSession(session); }
      }
    }).immediate();
  }
  list(principal: Principal) {
    const allowed = (nodeId: string, userId?: string) => (principal.nodeScope === "all" || principal.nodeScope.includes(nodeId)) && (!userId || principal.permissions.has("ssh:manage") || userId === principal.userId);
    const policies = (this.db.prepare("SELECT payload FROM ssh_policies").all() as PayloadRow[]).map(row => SshPolicySchema.parse(JSON.parse(row.payload))).filter(value => allowed(value.nodeId, value.userId));
    const credentials = (this.db.prepare("SELECT payload FROM ssh_credentials").all() as PayloadRow[]).map(row => SshCredentialSchema.parse(JSON.parse(row.payload))).filter(value => allowed(value.nodeId, value.userId));
    const sessions = (this.db.prepare("SELECT payload FROM ssh_sessions").all() as PayloadRow[]).map(row => SshSessionSchema.parse(JSON.parse(row.payload))).filter(value => allowed(value.nodeId, value.userId));
    const hosts = (this.db.prepare("SELECT node_id FROM agent_nodes WHERE revoked_at IS NULL").all() as { node_id: string }[]).filter(row => allowed(row.node_id)).map(row => {
      const stored = this.db.prepare("SELECT payload FROM ssh_hosts WHERE node_id=?").get(row.node_id) as PayloadRow | undefined;
      const host = SshHostSchema.parse(stored ? JSON.parse(stored.payload) : { nodeId: row.node_id, state: "unmanaged", available: false, reason: "SSH 主机执行器尚未安装或未完成独立验证", address: "", port: 22, fingerprints: [], collectedAt: null });
      const helper = this.db.prepare("SELECT report FROM ssh_helper_credentials WHERE node_id=? AND revoked_at IS NULL").get(row.node_id) as { report: string | null } | undefined;
      const report = helper?.report ? SshHelperReportSchema.parse(JSON.parse(helper.report)) : null;
      host.helperRegistered = !!helper; host.supported = report?.supported ?? null; host.helperPlatform = report?.platform ?? null; host.helperCollectedAt = report?.collectedAt ?? null;
      if (report && !report.supported) { host.available = false; host.reason = report.reason; }
      try { this.ready(row.node_id); } catch { return { ...host, available: false, reason: host.state === "managed" && host.available ? "主机采集或独立验证已失效，暂停签发" : host.reason }; }
      return host;
    });
    return { hosts, policies, credentials, sessions, collectedAt: this.now(), viewer: principal.user };
  }
  upsertPolicy(principal: Principal, input: SshPolicyInput) {
    if (!this.nodeActive(input.nodeId) || !this.db.prepare("SELECT 1 FROM users WHERE id=? AND disabled_at IS NULL").get(input.userId)) throw new ServiceError(404, "NOT_FOUND", "节点或用户不存在");
    return this.db.transaction(() => {
      const previous = this.db.prepare("SELECT payload FROM ssh_policies WHERE node_id=? AND user_id=?").get(input.nodeId, input.userId) as PayloadRow | undefined;
      const old = previous ? SshPolicySchema.parse(JSON.parse(previous.payload)) : undefined;
      // Base36 retains the entire immutable UUID and fits Linux's account limit.
      // The host adapter must still refuse pre-existing accounts it does not own.
      const policy = SshPolicySchema.parse({ ...input, services: [...new Set(input.services)].sort(), id: old?.id ?? randomUUID(), account: old?.account ?? sshAccountName(input.userId), revision: (old?.revision ?? 0) + 1, appliedRevision: 0, updatedAt: this.now() });
      if (old) this.invalidate(old.id);
      this.db.prepare("INSERT INTO ssh_policies(id,node_id,user_id,payload) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload").run(policy.id, input.nodeId, input.userId, JSON.stringify(policy));
      this.record(principal.userId, input.nodeId, "policy.updated", policy.id, { userId: policy.userId, account: policy.account, profile: policy.profile, services: policy.services, sessionSeconds: policy.sessionSeconds, enabled: policy.enabled, revision: policy.revision, previousRevision: old?.revision ?? 0 });
      return policy;
    }).immediate();
  }
  issue(principal: Principal, input: { nodeId: string; purpose: string; sessionSeconds?: number }) {
    if (principal.type !== "session") throw denied();
    return this.db.transaction(() => {
      const host = this.ready(input.nodeId);
      if (!this.userAllowed(principal.userId, input.nodeId)) throw denied();
      const row = this.db.prepare("SELECT payload FROM ssh_policies WHERE node_id=? AND user_id=?").get(input.nodeId, principal.userId) as PayloadRow | undefined;
      if (!row) throw denied();
      const policy = SshPolicySchema.parse(JSON.parse(row.payload));
      if (!policy.enabled || policy.appliedRevision !== policy.revision) throw unavailable();
      const recent = this.db.prepare("SELECT count(*) AS n FROM ssh_credentials WHERE user_id=? AND json_extract(payload,'$.createdAt')>? AND coalesce(json_extract(payload,'$.kind'),'login')='login'").get(principal.userId, new Date(this.clock() - 60_000).toISOString()) as { n: number };
      if (recent.n >= 5) throw new ServiceError(429, "TOO_MANY_REQUESTS", "临时密码申请过于频繁，请稍后重试");
      const password = randomBytes(32).toString("base64url");
      const credential = SshCredentialSchema.parse({ id: randomUUID(), nodeId: input.nodeId, userId: principal.userId, policyId: policy.id, policyRevision: policy.revision, account: policy.account, purpose: input.purpose, createdAt: this.now(), loginExpiresAt: new Date(this.clock() + SSH_LOGIN_WINDOW_SECONDS * 1000).toISOString(), sessionSeconds: Math.min(input.sessionSeconds ?? policy.sessionSeconds, policy.sessionSeconds), consumedAt: null, revokedAt: null });
      this.db.prepare("INSERT INTO ssh_credentials(id,node_id,user_id,policy_id,digest,payload) VALUES(?,?,?,?,?,?)").run(credential.id, credential.nodeId, credential.userId, policy.id, digest(password), JSON.stringify(credential));
      this.record(principal.userId, input.nodeId, "credential.issued", credential.id);
      return { credential, password, address: host.address, port: host.port, fingerprints: host.fingerprints };
    }).immediate();
  }
  private verificationPolicy(planId: string) {
    const row = this.db.prepare("SELECT payload FROM ssh_takeover_plans WHERE id=?").get(planId) as PayloadRow | undefined;
    if (!row) throw denied();
    const plan = SshTakeoverPlanSchema.parse(JSON.parse(row.payload));
    const actor = plan.reverification?.requestedBy ?? plan.requestedBy;
    const live = plan.reverification ? plan.local?.state === "managed" && Date.parse(plan.reverification.expiresAt) > this.clock() : plan.local?.state === "awaiting-verification" && Date.parse(plan.local.rollbackAt) > this.clock();
    if (plan.state !== "awaiting-verification" || !live || !this.nodeActive(plan.nodeId) || !this.userAllowed(actor, plan.nodeId)) throw denied();
    if (!this.db.prepare("SELECT 1 FROM user_roles ur JOIN role_permissions rp ON rp.role_id=ur.role_id WHERE ur.user_id=? AND rp.permission_key='ssh:manage'").get(actor)) throw denied();
    const policyRow = this.db.prepare("SELECT payload FROM ssh_policies WHERE node_id=? AND user_id=?").get(plan.nodeId, actor) as PayloadRow | undefined;
    if (!policyRow) throw denied();
    const policy = SshPolicySchema.parse(JSON.parse(policyRow.payload));
    if (!policy.enabled || policy.appliedRevision !== policy.revision || policy.systemUid === null || !this.db.prepare("SELECT 1 FROM ssh_helper_credentials WHERE node_id=? AND revoked_at IS NULL").get(plan.nodeId)) throw denied();
    return { plan, policy };
  }
  /** Internal verifier only. No management route accepts this credential kind. */
  issueVerification(planId: string, negative?: "expired" | "revoked") {
    return this.db.transaction(() => {
      const { plan, policy } = this.verificationPolicy(planId), password = randomBytes(32).toString("base64url");
      const credential = SshCredentialSchema.parse({ id: randomUUID(), nodeId: plan.nodeId, userId: policy.userId, policyId: policy.id, policyRevision: policy.revision, account: policy.account, purpose: "SSH 接管独立验证", kind: "verification", planId, createdAt: this.now(), loginExpiresAt: new Date(this.clock() + (negative === "expired" ? -1 : 60_000)).toISOString(), sessionSeconds: 60, consumedAt: null, revokedAt: negative === "revoked" ? this.now() : null });
      this.db.prepare("INSERT INTO ssh_credentials(id,node_id,user_id,policy_id,digest,payload) VALUES(?,?,?,?,?,?)").run(credential.id, credential.nodeId, credential.userId, policy.id, digest(password), JSON.stringify(credential));
      this.record(policy.userId, plan.nodeId, "verification.credential-issued", credential.id);
      return { credential, password, policy };
    }).immediate();
  }
  verificationSession(credentialId: string) {
    const row = this.db.prepare("SELECT payload FROM ssh_sessions WHERE credential_id=?").get(credentialId) as PayloadRow | undefined;
    return row ? SshSessionSchema.parse(JSON.parse(row.payload)) : null;
  }
  revokeVerification(planId: string) {
    this.db.transaction(() => {
      for (const row of this.db.prepare("SELECT payload FROM ssh_credentials WHERE json_extract(payload,'$.planId')=? AND json_extract(payload,'$.kind')='verification'").all(planId) as PayloadRow[]) {
        const value = SshCredentialSchema.parse(JSON.parse(row.payload)); value.revokedAt ??= this.now(); this.writeCredential(value); this.terminateCredentialSessions(value.id, value.revokedAt);
      }
    }).immediate();
  }
  authenticate(nodeId: string, account: string, password: string, connectionId: string) {
    try {
      if (password.length !== 43 || !/^[A-Za-z0-9_-]+$/.test(password) || connectionId.length < 16 || connectionId.length > 256) throw denied();
      return this.db.transaction(() => {
      const row = this.db.prepare("SELECT payload FROM ssh_credentials WHERE digest=? AND node_id=?").get(digest(password), nodeId) as PayloadRow | undefined;
      if (!row) throw denied();
      const value = SshCredentialSchema.parse(JSON.parse(row.payload));
      if (value.kind === "verification") {
        if (!value.planId) throw denied();
        const allowed = this.verificationPolicy(value.planId); if (allowed.plan.nodeId !== nodeId || allowed.plan.requestedBy !== value.userId || allowed.policy.id !== value.policyId) throw denied();
      } else this.ready(nodeId);
      const policy = this.policy(value.policyId);
      if (value.account !== account || value.consumedAt || value.revokedAt || Date.parse(value.loginExpiresAt) <= this.clock() || !this.userAllowed(value.userId, nodeId) || !policy.enabled || policy.revision !== value.policyRevision || policy.appliedRevision !== policy.revision) throw denied();
      value.consumedAt = this.now(); this.writeCredential(value);
      const session = SshSessionSchema.parse({ id: randomUUID(), credentialId: value.id, nodeId, userId: value.userId, account, connectionId, startedAt: this.now(), expiresAt: new Date(this.clock() + value.sessionSeconds * 1000).toISOString(), terminationRequestedAt: null, terminatedAt: null });
      this.db.prepare("INSERT INTO ssh_sessions(id,node_id,user_id,credential_id,connection_id,payload) VALUES(?,?,?,?,?,?)").run(session.id, nodeId, value.userId, value.id, connectionId, JSON.stringify(session));
      this.record(value.userId, nodeId, "authentication.accepted", session.id);
      return session;
      }).immediate();
    } catch (error) {
      // Authentication failures are audited without retaining passwords or
      // guessing which credential/user was supplied by an untrusted host.
      this.record("unknown", nodeId, "authentication.denied", connectionId, { account }, "failure");
      throw error;
    }
  }
  revoke(principal: Principal, id: string) {
    return this.db.transaction(() => {
      const row = this.db.prepare("SELECT payload FROM ssh_credentials WHERE id=?").get(id) as PayloadRow | undefined;
      if (!row) throw new ServiceError(404, "NOT_FOUND", "SSH 凭据不存在");
      const value = SshCredentialSchema.parse(JSON.parse(row.payload)); this.assertOwner(principal, value.nodeId, value.userId);
      value.revokedAt ??= this.now(); this.writeCredential(value); this.terminateCredentialSessions(id, value.revokedAt);
      this.record(principal.userId, value.nodeId, "credential.revoked", id); return value;
    }).immediate();
  }
  terminate(principal: Principal, id: string) {
    return this.db.transaction(() => {
      const row = this.db.prepare("SELECT payload FROM ssh_sessions WHERE id=?").get(id) as PayloadRow | undefined;
      if (!row) throw new ServiceError(404, "NOT_FOUND", "SSH 会话不存在");
      const session = SshSessionSchema.parse(JSON.parse(row.payload)); this.assertOwner(principal, session.nodeId, session.userId);
      session.terminationRequestedAt ??= this.now(); this.writeSession(session);
      this.record(principal.userId, session.nodeId, "session.termination-requested", id); return session;
    }).immediate();
  }
  private assertOwner(principal: Principal, nodeId: string, userId: string) {
    if ((principal.nodeScope !== "all" && !principal.nodeScope.includes(nodeId)) || (principal.userId !== userId && !principal.permissions.has("ssh:manage"))) throw denied();
  }
  hostState(nodeId: string) {
    const sessions = (this.db.prepare("SELECT payload FROM ssh_sessions WHERE node_id=?").all(nodeId) as PayloadRow[]).map(row => SshSessionSchema.parse(JSON.parse(row.payload)));
    const policies = (this.db.prepare("SELECT payload FROM ssh_policies WHERE node_id=?").all(nodeId) as PayloadRow[]).map(row => SshPolicySchema.parse(JSON.parse(row.payload))).map(policy => ({ ...policy, enabled: policy.enabled && this.userAllowed(policy.userId, nodeId) && this.nodeActive(nodeId) }));
    return { controllerTime: this.now(), policies, sessions: sessions.filter(session => !session.terminatedAt).map(session => ({ id: session.id, connectionId: session.connectionId, terminate: !!session.terminationRequestedAt || Date.parse(session.expiresAt) <= this.clock() || !this.userAllowed(session.userId, nodeId) || !this.nodeActive(nodeId) })) };
  }
  acknowledgePolicy(nodeId: string, input: { policyId: string; revision: number; enabled: boolean; applied: boolean; systemUid: number | null }, actor = "helper:trusted-adapter") {
    return this.db.transaction(() => {
      const policy = this.policy(input.policyId);
      if (policy.nodeId !== nodeId || !this.nodeActive(nodeId)) throw denied();
      const enabled = policy.enabled && this.userAllowed(policy.userId, nodeId);
      if (policy.revision !== input.revision || enabled !== input.enabled || (input.applied && enabled && (!Number.isSafeInteger(input.systemUid) || input.systemUid! < 1000))) throw new ServiceError(409, "BAD_REQUEST", "SSH 策略已变更或系统身份未确认，请重新同步");
      const appliedRevision = input.applied ? input.revision : 0;
      const applyError = input.applied ? null : "POLICY_NOT_APPLIED";
      const systemUid = input.applied ? input.systemUid : null;
      if (policy.appliedRevision !== appliedRevision || policy.applyError !== applyError || policy.systemUid !== systemUid) {
        policy.appliedRevision = appliedRevision; policy.applyError = applyError; policy.lastAppliedAt = input.applied ? this.now() : null; policy.systemUid = systemUid;
        this.db.prepare("UPDATE ssh_policies SET payload=? WHERE id=?").run(JSON.stringify(policy), policy.id);
        this.record(actor, nodeId, input.applied ? "policy.applied" : "policy.apply-failed", policy.id, { revision: policy.revision }, input.applied ? "success" : "failure");
      }
      return { policyId: policy.id, appliedRevision };
    }).immediate();
  }
  acknowledgeTerminated(nodeId: string, sessionId: string, connectionId: string, actor = "helper:trusted-adapter") {
    return this.db.transaction(() => {
      const row = this.db.prepare("SELECT payload FROM ssh_sessions WHERE id=? AND node_id=?").get(sessionId, nodeId) as PayloadRow | undefined;
      if (!row) throw new ServiceError(404, "NOT_FOUND", "SSH 会话不存在");
      const session = SshSessionSchema.parse(JSON.parse(row.payload));
      if (session.connectionId !== connectionId) throw denied();
      if (!session.terminatedAt) { session.terminatedAt = this.now(); this.writeSession(session); this.record(actor, nodeId, "session.terminated", session.id); }
      return session;
    }).immediate();
  }
}
