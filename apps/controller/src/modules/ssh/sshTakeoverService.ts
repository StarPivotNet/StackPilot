import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import ssh2 from "ssh2";
import { SshHostSchema, SshPolicySchema, SshTakeoverPlanSchema, type SshTakeoverPlan, type SshTakeoverInput, type SshTakeoverCommand, type SshTakeoverReceipt, type SshPolicy, type SshInventory, type Permission } from "@stackpilot/contracts";
import type { AuditRepository } from "../../audit/auditRepository.js";
import type { Principal } from "../../identity/types.js";
import { ServiceError } from "../serviceError.js";
import type { SshService } from "./sshService.js";
import { connectSshProbe } from "./sshProbeClient.js";
import { completeSshEvidence } from "./sshVerificationChecks.js";
import { SshVerificationError } from "./sshTakeoverVerifier.js";

type Evidence = SshTakeoverPlan["evidence"];
export type TakeoverVerifier = (plan: SshTakeoverPlan, privateKey: string) => Promise<Evidence>;
const terminal = new Set(["managed", "rolled-back", "failed"]);
const deny = () => new ServiceError(403, "FORBIDDEN", "SSH 接管权限或主机范围已变更");
type Payload = { payload: string };
export class SshTakeoverService {
  private readonly keys = new Map<string, string>();
  private readonly running = new Set<string>();
  constructor(private readonly db: Database.Database, private readonly audit: AuditRepository, private readonly ssh: SshService, private readonly verify: TakeoverVerifier, private readonly clock = () => Date.now()) {}
  private now() { return new Date(this.clock()).toISOString(); }
  private can(userId: string, nodeId: string, permission: Permission) {
    return !!this.db.prepare(`SELECT 1 FROM users u WHERE u.id=? AND u.disabled_at IS NULL
      AND EXISTS(SELECT 1 FROM user_roles ur JOIN role_permissions rp ON rp.role_id=ur.role_id WHERE ur.user_id=u.id AND rp.permission_key=?)
      AND (EXISTS(SELECT 1 FROM user_roles ur WHERE ur.user_id=u.id AND ur.role_id='administrator') OR EXISTS(SELECT 1 FROM user_node_scopes ns WHERE ns.user_id=u.id AND ns.node_id=?))`).get(userId, permission, nodeId);
  }
  private node(nodeId: string) { return !!this.db.prepare("SELECT 1 FROM agent_nodes WHERE node_id=? AND revoked_at IS NULL").get(nodeId); }
  private ownPolicy(plan: Pick<SshTakeoverPlan, "nodeId" | "requestedBy">): SshPolicy {
    const row = this.db.prepare("SELECT payload FROM ssh_policies WHERE node_id=? AND user_id=?").get(plan.nodeId, plan.requestedBy) as Payload | undefined;
    if (!row) throw new ServiceError(409, "BAD_REQUEST", "接管前请为当前操作者配置明确的 SSH 授权");
    const policy = SshPolicySchema.parse(JSON.parse(row.payload));
    if (!policy.enabled || !this.can(plan.requestedBy, plan.nodeId, "ssh:connect")) throw deny(); return policy;
  }
  private authorized(plan: SshTakeoverPlan) {
    if (!this.node(plan.nodeId) || !this.can(plan.requestedBy, plan.nodeId, "ssh:manage")) return false;
    try { const policy = this.ownPolicy(plan); return !plan.binding || policy.id === plan.binding.policyId && policy.revision === plan.binding.revision && policy.appliedRevision === policy.revision && policy.systemUid === plan.binding.uid; } catch { return false; }
  }
  private user(principal: Principal, nodeId: string) {
    if (principal.type !== "session" || !principal.permissions.has("ssh:manage") || (principal.nodeScope !== "all" && !principal.nodeScope.includes(nodeId)) || !this.can(principal.userId, nodeId, "ssh:manage")) throw deny();
  }
  get(id: string) { const row = this.db.prepare("SELECT payload FROM ssh_takeover_plans WHERE id=?").get(id) as Payload | undefined; if (!row) throw new ServiceError(404, "NOT_FOUND", "接管计划不存在"); return SshTakeoverPlanSchema.parse(JSON.parse(row.payload)); }
  list(principal: Principal) {
    return (this.db.prepare("SELECT payload FROM ssh_takeover_plans ORDER BY created_at DESC").all() as Payload[]).map(row => SshTakeoverPlanSchema.parse(JSON.parse(row.payload))).filter(plan => (principal.nodeScope === "all" || principal.nodeScope.includes(plan.nodeId)) && (principal.permissions.has("ssh:manage") || plan.requestedBy === principal.userId));
  }
  private save(plan: SshTakeoverPlan) { plan.updatedAt = this.now(); this.db.prepare("UPDATE ssh_takeover_plans SET state=?,payload=? WHERE id=?").run(plan.state, JSON.stringify(SshTakeoverPlanSchema.parse(plan)), plan.id); }
  private event(plan: SshTakeoverPlan, actor: string, action: string) { this.audit.append({ actorType: actor.startsWith("helper:") ? "ssh-helper" : "user", actorId: actor.replace(/^helper:/, ""), source: "ssh-takeover", targetType: "ssh", targetId: plan.id, action: `ssh.takeover.${action}`, parameters: { nodeId: plan.nodeId, state: plan.state, error: plan.error }, outcome: plan.error ? "failure" : "success", authorization: actor.startsWith("helper:") ? "signed-node-helper" : "session+rbac+reauth", requestId: randomUUID() }); }
  private command(plan: SshTakeoverPlan, action: SshTakeoverCommand["action"]): SshTakeoverCommand {
    return { id: randomUUID(), planId: plan.id, action, baselineDigest: plan.inventory?.digest ?? null, account: plan.binding?.account ?? null, policyId: plan.binding?.policyId ?? null, policyRevision: plan.binding?.revision ?? null, probePublicKey: null, verificationId: null };
  }
  private host(plan: SshTakeoverPlan, state: "unmanaged" | "prechecked" | "applying" | "awaiting-verification" | "managed" | "rolling-back" | "rolled-back" | "manual-recovery-required" | "drifted", available = false) {
    const value = SshHostSchema.parse({ nodeId: plan.nodeId, state, available, reason: plan.error ?? (state === "managed" ? "SSH 接管及独立验证已完成" : "SSH 接管等待主机确认"), address: plan.address, port: plan.port, fingerprints: plan.inventory?.fingerprints ?? [], collectedAt: this.now(), planId: plan.id, configDigest: plan.local?.appliedDigest ?? null });
    this.db.prepare("INSERT INTO ssh_hosts(node_id,payload,verification_id,helper_revoked_at) VALUES(?,?,?,NULL) ON CONFLICT(node_id) DO UPDATE SET payload=excluded.payload,verification_id=excluded.verification_id,helper_revoked_at=NULL").run(plan.nodeId, JSON.stringify(value), state === "managed" ? plan.local?.verificationId ?? null : null);
  }
  create(principal: Principal, input: SshTakeoverInput) {
    this.user(principal, input.nodeId);
    return this.db.transaction(() => {
      const previous = this.db.prepare("SELECT payload FROM ssh_takeover_plans WHERE requested_by=? AND json_extract(payload,'$.requestId')=?").get(principal.userId, input.requestId) as Payload | undefined;
      if (previous) { const value = SshTakeoverPlanSchema.parse(JSON.parse(previous.payload)); if (value.nodeId !== input.nodeId || value.address !== input.address || value.port !== input.port) throw new ServiceError(409, "BAD_REQUEST", "幂等标识已用于其他接管参数"); return value; }
      if (!this.node(input.nodeId) || !this.db.prepare("SELECT 1 FROM ssh_helper_credentials WHERE node_id=? AND revoked_at IS NULL").get(input.nodeId)) throw new ServiceError(409, "NOT_READY", "请先在受支持的主机安装并注册独立 SSH helper");
      const active = this.db.prepare("SELECT 1 FROM ssh_takeover_plans WHERE node_id=? AND state NOT IN ('managed','rolled-back','failed')").get(input.nodeId);
      const existing = this.db.prepare("SELECT payload FROM ssh_hosts WHERE node_id=?").get(input.nodeId) as Payload | undefined;
      if (active || existing && ["managed", "drifted"].includes(SshHostSchema.parse(JSON.parse(existing.payload)).state)) throw new ServiceError(409, "BAD_REQUEST", "该主机已有接管或恢复任务，请先处理当前状态");
      this.ownPolicy({ nodeId: input.nodeId, requestedBy: principal.userId });
      const plan = SshTakeoverPlanSchema.parse({ ...input, id: randomUUID(), requestedBy: principal.userId, state: "prechecking", createdAt: this.now(), updatedAt: this.now(), inventory: null, local: null, command: null, error: null, evidence: [] });
      plan.command = this.command(plan, "preflight"); this.db.prepare("INSERT INTO ssh_takeover_plans(id,node_id,requested_by,state,created_at,payload) VALUES(?,?,?,?,?,?)").run(plan.id, plan.nodeId, plan.requestedBy, plan.state, plan.createdAt, JSON.stringify(plan)); this.host(plan, "unmanaged"); this.event(plan, principal.userId, "requested"); return plan;
    }).immediate();
  }
  apply(principal: Principal, id: string) {
    return this.db.transaction(() => {
      const plan = this.get(id); this.user(principal, plan.nodeId); if (principal.userId !== plan.requestedBy) throw deny();
      if (["applying", "awaiting-verification", "managed"].includes(plan.state)) return plan;
      if (plan.state !== "prechecked" || !plan.inventory) throw new ServiceError(409, "BAD_REQUEST", "预检尚未完成");
      const policy = this.ownPolicy(plan); if (policy.appliedRevision !== policy.revision || policy.systemUid === null) throw new ServiceError(409, "NOT_READY", "主机尚未确认当前操作者的账号与权限");
      const running = this.db.prepare("SELECT count(*) AS n FROM ssh_takeover_plans WHERE state IN ('applying','awaiting-verification','rolling-back')").get() as { n: number };
      if (running.n >= 4) throw new ServiceError(429, "TOO_MANY_REQUESTS", "已有接管正在执行，请稍后逐台操作");
      const key = generateKeyPairSync("rsa", { modulusLength: 3072 }).privateKey.export({ type: "pkcs1", format: "pem" }).toString(); const parsed = ssh2.utils.parseKey(key); if (parsed instanceof Error || Array.isArray(parsed)) throw new Error("Cannot generate SSH verification key");
      plan.binding = { policyId: policy.id, revision: policy.revision, account: policy.account, uid: policy.systemUid }; plan.state = "applying"; plan.command = { ...this.command(plan, "probe-key"), probePublicKey: `ssh-rsa ${parsed.getPublicSSH().toString("base64")}` }; this.keys.set(plan.id, key); this.save(plan); this.host(plan, "applying"); this.event(plan, principal.userId, "apply-requested"); return plan;
    }).immediate();
  }
  rollback(principal: Principal, id: string) { return this.db.transaction(() => { const plan = this.get(id); this.user(principal, plan.nodeId); if (terminal.has(plan.state)) return plan; this.cancel(plan, "操作者请求回滚"); this.event(plan, principal.userId, "rollback-requested"); return plan; }).immediate(); }
  private cancel(plan: SshTakeoverPlan, reason: string) { if (plan.state === "rolling-back" && plan.command?.action === "rollback") return; plan.error = reason; plan.state = "rolling-back"; plan.command = this.command(plan, "rollback"); this.ssh.revokeVerification(plan.id); this.keys.delete(plan.id); this.save(plan); this.host(plan, "rolling-back"); }
  private revokedCommand(plan: SshTakeoverPlan) {
    const command = this.command(plan, "rollback"), hash = createHash("sha256").update(`${plan.id}:${plan.command?.id ?? "idle"}:authorization-revoked`).digest("hex");
    command.id = `${hash.slice(0,8)}-${hash.slice(8,12)}-4${hash.slice(13,16)}-8${hash.slice(17,20)}-${hash.slice(20,32)}`; return command;
  }
  next(nodeId: string) {
    const rows = this.db.prepare("SELECT payload FROM ssh_takeover_plans WHERE node_id=? ORDER BY created_at DESC").all(nodeId) as Payload[];
    for (const row of rows) { const plan = SshTakeoverPlanSchema.parse(JSON.parse(row.payload)); if (!terminal.has(plan.state) && !this.authorized(plan)) return this.revokedCommand(plan); if (plan.command) return plan.command; }
    return null;
  }
  receive(nodeId: string, credentialId: string, receipt: SshTakeoverReceipt) {
    let run: "legacy" | "verify" | null = null;
    const result = this.db.transaction(() => {
      const plan = this.get(receipt.planId); if (plan.nodeId !== nodeId || !this.db.prepare("SELECT 1 FROM ssh_helper_credentials WHERE id=? AND node_id=? AND revoked_at IS NULL").get(credentialId, nodeId)) throw deny();
      if (plan.lastReceiptId === receipt.commandId) return plan;
      const expected = !terminal.has(plan.state) && !this.authorized(plan) ? this.revokedCommand(plan) : plan.command;
      if (!expected || expected.id !== receipt.commandId || receipt.local && receipt.local.planId !== plan.id) throw new ServiceError(409, "BAD_REQUEST", "主机回执不属于当前接管步骤");
      plan.lastReceiptId = receipt.commandId; plan.local = receipt.local ?? plan.local;
      if (!receipt.successful && expected.action === "remove-probe-key") { plan.error = "迁移探针公钥清理未完成，需要主机管理员处理"; plan.command = null; }
      else if (!receipt.successful) {
        plan.error = receipt.error ?? "主机步骤失败";
        if (receipt.local?.state === "manual-recovery-required") { plan.state = "manual-recovery-required"; plan.command = null; this.host(plan, "manual-recovery-required"); }
        else if (receipt.local?.state === "rolled-back") { plan.state = "rolled-back"; plan.command = plan.binding ? this.command(plan, "remove-probe-key") : null; this.host(plan, "rolled-back"); }
        else if (receipt.local && receipt.local.state !== "managed") this.cancel(plan, plan.error);
        else { plan.state = "failed"; plan.command = plan.binding ? this.command(plan, "remove-probe-key") : null; this.host(plan, "unmanaged"); }
      } else if (expected.action === "preflight") {
        if (!receipt.inventory || Math.abs(this.clock() - Date.parse(receipt.inventory.collectedAt)) > 30_000) throw new ServiceError(409, "BAD_REQUEST", "主机预检数据或采集时间无效");
        plan.inventory = receipt.inventory; plan.state = "prechecked"; plan.command = null; this.host(plan, "prechecked");
      } else if (expected.action === "probe-key") { plan.command = null; run = "legacy"; }
      else if (expected.action === "apply") {
        if (!receipt.local || receipt.local.state !== "awaiting-verification" || receipt.local.baselineDigest !== plan.inventory?.digest || receipt.inventory?.digest !== receipt.local.appliedDigest) throw new ServiceError(409, "BAD_REQUEST", "主机应用证据不完整");
        plan.state = "awaiting-verification"; plan.appliedInventory = receipt.inventory; plan.command = null; this.host(plan, "awaiting-verification"); run = "verify";
      } else if (expected.action === "commit" || expected.action === "rollback" && receipt.local?.state === "managed") {
        const proof = plan.verificationId;
        if (!proof || expected.action === "commit" && expected.verificationId !== proof || receipt.local?.state !== "managed" || !completeSshEvidence(plan.evidence) || receipt.local.verificationId !== proof || receipt.inventory?.digest !== receipt.local.appliedDigest) throw new ServiceError(409, "BAD_REQUEST", "提交缺少独立验证证据");
        plan.state = "managed"; plan.error = null; plan.command = this.command(plan, "remove-probe-key"); this.host(plan, "managed", true); this.keys.delete(plan.id); this.ssh.revokeVerification(plan.id);
      } else if (expected.action === "rollback") { plan.state = "rolled-back"; plan.command = plan.binding ? this.command(plan, "remove-probe-key") : null; this.host(plan, "rolled-back"); this.keys.delete(plan.id); }
      else if (expected.action === "remove-probe-key") plan.command = null;
      this.save(plan); this.event(plan, `helper:${credentialId}`, `step.${expected.action}`); return plan;
    }).immediate();
    if (run) void this.run(result.id, run).catch(() => undefined); return result;
  }
  private async run(id: string, phase: "legacy" | "verify") {
    const job = `${id}:${phase}`; if (this.running.has(job)) return; this.running.add(job);
    try {
      const plan = this.get(id), key = this.keys.get(id); if (!key || !plan.inventory || !plan.binding || !this.authorized(plan)) throw deny();
      let evidence: Evidence;
      if (phase === "legacy") { const client = await connectSshProbe({ address: plan.address, port: plan.port, account: plan.binding.account, fingerprints: plan.inventory.fingerprints }, { method: "publickey", privateKey: key }); client.close(); await client.closed; evidence = [{ check: "legacy-probe-key-accepted", passed: true, collectedAt: this.now() }]; }
      else { evidence = await this.verify(plan, key); if (!completeSshEvidence(evidence)) throw new Error("SSH verification evidence is incomplete"); }
      this.db.transaction(() => {
        const current = this.get(id); if (!this.authorized(current) || current.command || current.state !== (phase === "legacy" ? "applying" : "awaiting-verification")) throw deny();
        current.evidence.push(...evidence); current.command = this.command(current, phase === "legacy" ? "apply" : "commit"); if (phase === "verify") { current.verificationId = randomUUID(); current.command.verificationId = current.verificationId; } this.save(current); this.event(current, current.requestedBy, `verification.${phase}`);
      }).immediate();
    } catch (error) { this.db.transaction(() => { const plan = this.get(id); if (!terminal.has(plan.state)) { if (error instanceof SshVerificationError) plan.evidence.push(...error.evidence); this.cancel(plan, error instanceof SshVerificationError ? `独立验证失败（${error.code}，已通过 ${error.evidence.length} 项），正在恢复原配置` : "独立验证失败或授权已变更，正在恢复原配置"); } }).immediate(); }
    finally { this.running.delete(job); }
  }
  observe(nodeId: string, inventory: SshInventory | null) {
    const row = this.db.prepare("SELECT payload,verification_id FROM ssh_hosts WHERE node_id=?").get(nodeId) as (Payload & { verification_id: string | null }) | undefined;
    if (!row) return; const host = SshHostSchema.parse(JSON.parse(row.payload));
    if (host.state !== "managed" || !row.verification_id || !host.configDigest) return;
    if (!inventory || inventory.digest !== host.configDigest) { host.state = "drifted"; host.available = false; host.reason = "SSH 入口或配置已变化，暂停签发并等待重新核验"; this.db.prepare("UPDATE ssh_hosts SET payload=?,verification_id=NULL WHERE node_id=?").run(JSON.stringify(host), nodeId); }
    else { host.collectedAt = inventory.collectedAt; host.available = true; this.db.prepare("UPDATE ssh_hosts SET payload=? WHERE node_id=?").run(JSON.stringify(host), nodeId); }
  }
  recover() { this.db.transaction(() => { for (const row of this.db.prepare("SELECT payload FROM ssh_takeover_plans WHERE state NOT IN ('managed','rolled-back','failed')").all() as Payload[]) { const plan = SshTakeoverPlanSchema.parse(JSON.parse(row.payload)); this.cancel(plan, "Controller 重启，未提交的接管需要恢复"); } }).immediate(); }
}
