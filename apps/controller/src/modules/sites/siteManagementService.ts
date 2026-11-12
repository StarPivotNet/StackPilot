import { createHash, randomUUID } from "node:crypto";
import {
  CreateSitePlanRequestSchema, SiteLifecycleTaskResultSchema, SiteLogQueryTaskResultSchema, SiteOperationSchema,
  SitePlanActivateTaskResultSchema, SitePlanPrepareTaskResultSchema, SitePlanSchema,
  SiteRollbackTaskResultSchema,
  type ActivateSitePlanRequest, type CreateSiteCertificateRenewalRequest,
  type CreateSiteLogQueryRequest, type CreateSitePlanRequest, type CreateSiteRollbackRequest,
  type SiteOperation, type SiteOperationResult, type SitePlan, type SiteRuntimePayload, type UpdateSiteLifecycleRequest,
} from "@stackpilot/contracts";
import { ServiceError } from "../serviceError.js";
import type { CertificateRenewalService } from "./certificateRenewalService.js";
import type { SiteAccess, SiteMonitoringService } from "./siteMonitoringService.js";
import { publicSiteId } from "./siteMonitoringService.js";
import type { SiteManagementRepository } from "./siteManagementRepository.js";
import type { RemoteTaskService } from "../remote-tasks/remoteTaskService.js";
import { projectSiteRollbacks } from "./siteRollbackProjection.js";
export type SiteExecutionInstruction =
  | { type: "prepare"; planId: string }
  | { type: "activate"; planId: string; stagingId: string }
  | { type: "rollback"; siteId: string; targetPlanId: string; targetReleaseId: string; expectedVersion: number }
  | { type: "lifecycle"; siteId: string; action: UpdateSiteLifecycleRequest["action"]; expectedVersion: number }
  | { type: "log_query"; siteId: string; since: string | null; limit: number };
export type SiteExecutorResult = { status: SiteOperation["status"]; result: SiteOperationResult | null; errorCode: string | null; taskId?: string } | null;
export interface SiteExecutor {
  dispatch(operationId: string, nodeId: string, instruction: SiteExecutionInstruction): Promise<string>;
  reconcile(operation: SiteOperation): Promise<SiteExecutorResult>;
}
export class DeferredSiteExecutor implements SiteExecutor {
  async dispatch(): Promise<string> { throw new ServiceError(503, "INTERNAL_ERROR", "站点执行器尚未配置"); }
  async reconcile() { return null; }
}
const emptyResult = (overrides: Partial<SiteOperationResult> = {}): SiteOperationResult => ({
  message: null, siteId: null, releaseId: null, stagingId: null, desiredState: null,
  siteVersion: null, certificateRenewalBatchId: null, planPreview: null, logs: [], ...overrides,
});
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const terminal = new Set<SiteOperation["status"]>(["succeeded", "failed", "cancelled"]);
function managedSiteId(nodeId: string, primaryDomain: string) {
  return publicSiteId(nodeId, `site_${sha256(`${nodeId}\0${primaryDomain.toLowerCase()}`).slice(0, 32)}`);
}
function operation(input: Pick<SiteOperation, "type" | "nodeId" | "siteId" | "planId">): SiteOperation {
  const now = new Date().toISOString();
  return SiteOperationSchema.parse({ ...input, operationId: randomUUID(), taskId: null, status: "queued", stage: "awaiting_executor", progressPercent: 0, result: null, errorCode: null, createdAt: now, updatedAt: now });
}
function planDigest(input: CreateSitePlanRequest) {
  return sha256(JSON.stringify({
    nodeId: input.nodeId, deploymentEnvironment: input.deploymentEnvironment,
    domains: input.domains, repositoryUrl: input.repositoryUrl,
    repositoryRef: input.repositoryRef, certificateEnvironment: input.certificateEnvironment,
    certificateEmailDigest: sha256(input.certificateEmail),
    environment: input.environmentVariables.map((entry) => ({ name: entry.name, valueDigest: sha256(entry.value) })),
  }));
}
export class SiteManagementService {
  private reconciliationTimer: NodeJS.Timeout | undefined;
  private reconciliationRun: Promise<void> | undefined;
  private reconciliationActive = false;
  private readonly operationReconciliations = new Map<string, Promise<SiteOperation>>();
  constructor(
    private readonly repository: SiteManagementRepository,
    private readonly monitoring: SiteMonitoringService,
    private readonly renewals: CertificateRenewalService,
    private readonly executor: SiteExecutor = new DeferredSiteExecutor(),
    private readonly protectedSiteIds: readonly string[] = [],
  ) {}
  async getSites(access: SiteAccess): Promise<SiteRuntimePayload> {
    const payload = await this.monitoring.getSites(access);
    const managed = new Map(this.repository.listManagedSites().map((site) => [site.siteId, site]));
    return { ...payload, sites: payload.sites.map((site) => {
      const state = managed.get(site.id);
      const protectedSite = this.protectedSiteIds.includes(site.id) || state?.protected === true;
      return state ? { ...site, protected: protectedSite, version: state.version, desiredState: state.desiredState, manageability: "managed" as const, managementReason: null } : { ...site, protected: protectedSite };
    }) };
  }
  listRollbacks(access: SiteAccess) { return projectSiteRollbacks(this.repository, access); }
  private assertNodeAccess(nodeId: string, access: SiteAccess) {
    if (access.nodeScope !== "all" && !access.nodeScope.includes(nodeId)) throw new ServiceError(403, "FORBIDDEN", "节点超出授权范围");
  }
  private async runtimeSite(siteId: string, access: SiteAccess) { const site = (await this.getSites(access)).sites.find((item) => item.id === siteId); if (!site) throw new ServiceError(404, "NOT_FOUND", "站点不存在或超出授权范围"); return site; }
  private idempotency(requester: string, type: string, key: string) { return sha256(`${requester}\0${type}\0${key}`); }
  private async dispatch(operation: SiteOperation, instruction: SiteExecutionInstruction) {
    try {
      const taskId = await this.executor.dispatch(operation.operationId, operation.nodeId, instruction);
      const current = this.repository.getOperation(operation.operationId);
      if (!current || terminal.has(current.status)) return current ?? operation;
      const dispatched = { ...current, taskId };
      this.repository.updateOperation(dispatched);
      return dispatched;
    } catch {
      const current = this.repository.getOperation(operation.operationId);
      if (current && terminal.has(current.status)) return current;
      const failed = SiteOperationSchema.parse({ ...(current ?? operation), status: "failed", stage: "dispatch_failed", progressPercent: 100, errorCode: "DISPATCH_FAILED", updatedAt: new Date().toISOString() });
      this.repository.updateOperation(failed);
      if (operation.type === "prepare" && operation.planId) {
        const plan = this.repository.getPlan(operation.planId);
        if (plan) this.repository.updatePlan({ ...plan, status: "failed", updatedAt: failed.updatedAt });
      } else if (operation.type === "activate" && operation.planId) {
        const plan = this.repository.getPlan(operation.planId);
        if (plan) this.repository.updatePlan({ ...plan, status: "ready", updatedAt: failed.updatedAt });
      }
      return failed;
    }
  }
  async createPlan(input: CreateSitePlanRequest, access: SiteAccess, requester: string, operator: string | null = null) {
    input = CreateSitePlanRequestSchema.parse(input);
    this.assertNodeAccess(input.nodeId, access);
    const key = this.idempotency(requester, "prepare", input.idempotencyKey);
    const existing = this.repository.findPlanByIdempotency(key);
    if (existing) { this.assertNodeAccess(existing.nodeId, access); return existing; }
    const requestedDomains = new Set(input.domains.map((domain) => domain.toLowerCase()));
    const conflict = (await this.getSites(access)).sites.find((site) => site.nodeId === input.nodeId && site.manageability !== "managed" && requestedDomains.has(site.domain.toLowerCase()));
    if (conflict) throw new ServiceError(409, "BAD_REQUEST", `域名 ${conflict.domain} 已由目标节点的 Nginx 配置使用`);
    const now = new Date().toISOString();
    const preparing = operation({ type: "prepare", nodeId: input.nodeId, siteId: null, planId: null });
    const plan = SitePlanSchema.parse({
      planId: randomUUID(), nodeId: input.nodeId, deploymentEnvironment: input.deploymentEnvironment,
      domains: input.domains, repositoryUrl: input.repositoryUrl,
      repositoryRef: input.repositoryRef, certificateEnvironment: input.certificateEnvironment,
      environmentVariableNames: input.environmentVariables.map((entry) => entry.name), operator, status: "queued",
      digest: planDigest(input), version: 1, preview: null, operationId: preparing.operationId,
      createdAt: now, updatedAt: now, expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
    });
    preparing.planId = plan.planId;
    this.repository.savePlanWithOperation(
      plan, key, input.certificateEmail, input.environmentVariables, preparing,
      this.idempotency(requester, "prepare-operation", input.idempotencyKey),
    );
    const dispatched = await this.dispatch(preparing, { type: "prepare", planId: plan.planId });
    return dispatched.status === "failed" ? this.repository.getPlan(plan.planId)! : plan;
  }
  async activate(planId: string, input: ActivateSitePlanRequest, access: SiteAccess, requester: string) {
    const key = this.idempotency(requester, `activate:${planId}`, input.idempotencyKey);
    const existing = this.repository.findOperationByIdempotency(key);
    if (existing) {
      this.assertNodeAccess(existing.nodeId, access);
      const existingPlan = existing.planId ? this.repository.getPlan(existing.planId) : null;
      if (existingPlan?.deploymentEnvironment === "staging") throw new ServiceError(409, "BAD_REQUEST", "预发环境计划不能切换生产流量");
      return existing;
    }
    const plan = this.repository.getPlan(planId);
    if (!plan) throw new ServiceError(404, "NOT_FOUND", "站点计划不存在");
    this.assertNodeAccess(plan.nodeId, access);
    if (plan.deploymentEnvironment === "staging") throw new ServiceError(409, "BAD_REQUEST", "预发环境计划不能切换生产流量");
    if (plan.status !== "ready" || Date.parse(plan.expiresAt) <= Date.now()) throw new ServiceError(409, "BAD_REQUEST", "站点计划尚未就绪或已过期");
    if (plan.version !== input.planVersion || plan.digest !== input.planDigest) throw new ServiceError(409, "BAD_REQUEST", "站点计划版本或摘要已变化");
    const stagingId = this.repository.getOperation(plan.operationId)?.result?.stagingId;
    if (!stagingId) throw new ServiceError(409, "BAD_REQUEST", "站点计划缺少可激活的预检产物");
    const activation = operation({ type: "activate", nodeId: plan.nodeId, siteId: null, planId });
    this.repository.saveOperation(activation, key);
    this.repository.updatePlan({ ...plan, status: "activating", updatedAt: activation.updatedAt });
    return this.dispatch(activation, { type: "activate", planId, stagingId });
  }
  async updateLifecycle(siteId: string, input: UpdateSiteLifecycleRequest, access: SiteAccess, requester: string) {
    const key = this.idempotency(requester, `lifecycle:${siteId}`, input.idempotencyKey);
    const existing = this.repository.findOperationByIdempotency(key);
    if (existing) { this.assertNodeAccess(existing.nodeId, access); return existing; }
    const site = await this.runtimeSite(siteId, access);
    if (site.protected) throw new ServiceError(409, "BAD_REQUEST", "受保护站点不能执行生命周期操作");
    if (site.manageability !== "managed") throw new ServiceError(409, "BAD_REQUEST", "站点当前不可纳管");
    if (site.version !== input.version) throw new ServiceError(409, "BAD_REQUEST", "站点版本已变化");
    const lifecycle = operation({ type: "lifecycle", nodeId: site.nodeId, siteId, planId: null });
    lifecycle.stage = `lifecycle_${input.action}`;
    this.repository.saveOperation(lifecycle, key);
    return this.dispatch(lifecycle, { type: "lifecycle", siteId, action: input.action, expectedVersion: input.version });
  }
  async rollback(siteId: string, input: CreateSiteRollbackRequest, access: SiteAccess, requester: string, requestedBy: string) {
    const key = this.idempotency(requester, `rollback:${siteId}`, input.idempotencyKey);
    const existing = this.repository.findOperationByIdempotency(key);
    if (existing) { this.assertNodeAccess(existing.nodeId, access); return existing; }
    const site = this.repository.getManagedSite(siteId);
    if (!site) throw new ServiceError(409, "BAD_REQUEST", "站点当前不可纳管");
    this.assertNodeAccess(site.nodeId, access);
    if (this.protectedSiteIds.includes(siteId) || site.protected) throw new ServiceError(409, "BAD_REQUEST", "受保护站点不能执行回滚");
    if (site.version !== input.expectedSiteVersion) throw new ServiceError(409, "BAD_REQUEST", "站点版本已变化");
    const target = this.repository.getRelease(input.targetReleaseId);
    if (!target || target.siteId !== siteId) throw new ServiceError(409, "BAD_REQUEST", "目标版本不属于当前站点");
    if (site.activeReleaseId === target.releaseId) throw new ServiceError(409, "BAD_REQUEST", "目标版本已是当前活动版本");
    const conflict = this.repository.listNonTerminalOperations().some((item) => {
      if (!["prepare", "activate", "lifecycle", "rollback"].includes(item.type)) return false;
      if (item.siteId === siteId) return true;
      const plan = item.planId ? this.repository.getPlan(item.planId) : null;
      return plan ? managedSiteId(plan.nodeId, plan.domains[0]!) === siteId : false;
    });
    if (conflict) throw new ServiceError(409, "BAD_REQUEST", "站点已有未完成的部署或操作");
    const pending = operation({ type: "rollback", nodeId: site.nodeId, siteId, planId: target.planId });
    pending.stage = "rollback_queued";
    pending.rollback = { fromReleaseId: site.activeReleaseId!, targetReleaseId: target.releaseId, reason: input.reason, requestedBy };
    this.repository.saveOperation(SiteOperationSchema.parse(pending), key);
    return this.dispatch(pending, { type: "rollback", siteId, targetPlanId: target.planId, targetReleaseId: target.releaseId, expectedVersion: input.expectedSiteVersion });
  }
  async renewCertificate(siteId: string, input: CreateSiteCertificateRenewalRequest, access: SiteAccess, requester: string, traceId: string) {
    const key = this.idempotency(requester, `renew:${siteId}`, input.idempotencyKey);
    const existing = this.repository.findOperationByIdempotency(key);
    if (existing) { this.assertNodeAccess(existing.nodeId, access); return existing; }
    const site = await this.runtimeSite(siteId, access);
    if (site.version !== input.version) throw new ServiceError(409, "BAD_REQUEST", "站点版本已变化");
    const batch = await this.renewals.create({ siteIds: [siteId], idempotencyKey: input.idempotencyKey }, access, requester, traceId);
    const renewal = operation({ type: "certificate_renewal", nodeId: site.nodeId, siteId, planId: null });
    renewal.result = emptyResult({ certificateRenewalBatchId: batch.batchId, siteId });
    renewal.stage = "certificate_renewal";
    this.repository.saveOperation(renewal, key);
    return renewal;
  }
  async queryLogs(siteId: string, input: CreateSiteLogQueryRequest, access: SiteAccess, requester: string) {
    const key = this.idempotency(requester, `logs:${siteId}`, input.idempotencyKey);
    const existing = this.repository.findOperationByIdempotency(key);
    if (existing) { this.assertNodeAccess(existing.nodeId, access); return existing; }
    const site = await this.runtimeSite(siteId, access);
    if (site.version !== input.version) throw new ServiceError(409, "BAD_REQUEST", "站点版本已变化");
    const query = operation({ type: "log_query", nodeId: site.nodeId, siteId, planId: null });
    this.repository.saveOperation(query, key);
    return this.dispatch(query, { type: "log_query", siteId, since: input.since, limit: input.limit });
  }
  async getOperation(operationId: string, access: SiteAccess) {
    const found = this.repository.getOperation(operationId);
    if (!found) throw new ServiceError(404, "NOT_FOUND", "站点操作不存在");
    this.assertNodeAccess(found.nodeId, access);
    return found;
  }
  startBackgroundReconciliation(intervalMs = 10_000, onError: (error: unknown) => void = () => undefined) {
    if (this.reconciliationActive) return; this.reconciliationActive = true;
    const report = (error: unknown) => { try { onError(error); } catch { /* Reporting must not stop reconciliation. */ } };
    const run = async () => {
      if (!this.reconciliationActive) return;
      try { for (const operation of this.repository.listNonTerminalOperations()) {
        try { await this.reconcileOperation(operation, { nodeScope: "all" }); } catch (error) { report(error); }
      } } catch (error) { report(error); }
      finally { if (this.reconciliationActive) this.reconciliationTimer = setTimeout(() => { this.reconciliationRun = run(); }, intervalMs); }
    };
    this.reconciliationRun = run();
  }
  async stopBackgroundReconciliation() {
    this.reconciliationActive = false;
    if (this.reconciliationTimer) clearTimeout(this.reconciliationTimer);
    this.reconciliationTimer = undefined;
    await this.reconciliationRun;
    this.reconciliationRun = undefined;
  }
  private async reconcileOperation(initial: SiteOperation, access: SiteAccess) {
    const active = this.operationReconciliations.get(initial.operationId);
    if (active) return active;
    const work = this.reconcileOperationOnce(initial, access);
    this.operationReconciliations.set(initial.operationId, work);
    try { return await work; }
    finally { this.operationReconciliations.delete(initial.operationId); }
  }
  private async reconcileOperationOnce(initial: SiteOperation, access: SiteAccess) {
    let found = this.repository.getOperation(initial.operationId) ?? initial;
    if (terminal.has(found.status)) return found;
    if (found.type !== "certificate_renewal") {
      const reconciled = await this.executor.reconcile(found);
      const current = this.repository.getOperation(found.operationId);
      if (!current || terminal.has(current.status)) return current ?? found;
      found = current;
      if (reconciled?.taskId && found.taskId !== reconciled.taskId) { found = { ...found, taskId: reconciled.taskId, updatedAt: new Date().toISOString() }; this.repository.updateOperation(found); }
      if (reconciled?.status === "running") found = this.markRunning(found.operationId, 50, "agent_running");
      else if (reconciled && terminal.has(reconciled.status)) found = this.complete(found.operationId, reconciled.status === "succeeded", reconciled.result, reconciled.errorCode);
    }
    const batchId = found.result?.certificateRenewalBatchId;
    if (found.type === "certificate_renewal" && batchId && !terminal.has(found.status)) {
      const batch = await this.renewals.get(batchId, access);
      if (["succeeded", "partially_succeeded", "failed", "cancelled", "expired"].includes(batch.status)) {
        found = { ...found, status: batch.status === "succeeded" ? "succeeded" : "failed", stage: "complete", progressPercent: 100, errorCode: batch.status === "succeeded" ? null : "CERTIFICATE_RENEWAL_FAILED", updatedAt: batch.updatedAt };
        this.repository.updateOperation(found);
      } else if (batch.status === "running") {
        found = { ...found, status: "running", stage: "certificate_renewal", progressPercent: 50, updatedAt: batch.updatedAt };
        this.repository.updateOperation(found);
      }
    }
    return found;
  }
  markRunning(operationId: string, progressPercent: number, stage: string) {
    const current = this.repository.getOperation(operationId);
    if (!current || terminal.has(current.status)) throw new ServiceError(409, "BAD_REQUEST", "站点操作不能更新");
    const next = SiteOperationSchema.parse({ ...current, status: "running", stage, progressPercent, updatedAt: new Date().toISOString() });
    this.repository.updateOperation(next);
    return next;
  }
  complete(operationId: string, succeeded: boolean, result: SiteOperationResult | null, errorCode: string | null) {
    const current = this.repository.getOperation(operationId);
    if (!current || terminal.has(current.status)) throw new ServiceError(409, "BAD_REQUEST", "站点操作不能完成");
    const now = new Date().toISOString();
    const activationPlan = current.type === "activate" && current.planId ? this.repository.getPlan(current.planId) : null;
    if (succeeded && current.type === "activate") {
      const expectedSiteId = activationPlan ? managedSiteId(activationPlan.nodeId, activationPlan.domains[0]!) : null;
      if (!expectedSiteId || result?.siteId !== expectedSiteId) {
        succeeded = false;
        result = null;
        errorCode = "INVALID_REMOTE_TASK_RESULT";
      }
    }
    if (succeeded && current.type === "rollback") {
      const site = current.siteId ? this.repository.getManagedSite(current.siteId) : null;
      const valid = site && current.rollback && result?.siteId === current.siteId
        && result.releaseId === current.rollback.targetReleaseId && result.siteVersion === site.version + 1
        && site.activeReleaseId === current.rollback.fromReleaseId;
      if (!valid) { succeeded = false; result = null; errorCode = "INVALID_REMOTE_TASK_RESULT"; }
    }
    const next = SiteOperationSchema.parse({ ...current, status: succeeded ? "succeeded" : "failed", stage: "complete", progressPercent: 100, result, errorCode: succeeded ? null : (errorCode ?? "EXECUTION_FAILED"), updatedAt: now });
    if (current.type === "rollback" && succeeded) {
      const site = this.repository.getManagedSite(current.siteId!)!;
      this.repository.completeRollback(next, { ...site, activeReleaseId: current.rollback!.targetReleaseId, version: result!.siteVersion!, updatedAt: now });
    } else this.repository.updateOperation(next);
    if (current.type === "prepare" && current.planId) {
      const plan = this.repository.getPlan(current.planId);
      if (plan) this.repository.updatePlan({ ...plan, status: succeeded ? "ready" : "failed", preview: succeeded ? result?.planPreview ?? null : null, updatedAt: now });
    }
    if (current.type === "activate" && current.planId) {
      if (succeeded) this.activateManagedSite(result!, activationPlan!, now);
      else if (activationPlan) this.repository.updatePlan({ ...activationPlan, status: "ready", updatedAt: now });
    }
    if (current.type === "lifecycle" && current.siteId && succeeded) this.completeLifecycle(current, result, now);
    return next;
  }
  private activateManagedSite(result: SiteOperationResult, plan: SitePlan, now: string) {
    const domainDigest = sha256(plan.domains.join("\0"));
    const existing = this.repository.findManagedSite(plan.nodeId, domainDigest);
    const siteId = managedSiteId(plan.nodeId, plan.domains[0]!);
    const releaseId = result.releaseId ?? `release-${randomUUID()}`;
    this.repository.saveManagedSite({ siteId, nodeId: plan.nodeId, domainDigest, desiredState: "running", protected: existing?.protected ?? false, version: (existing?.version ?? 0) + 1, activeReleaseId: releaseId, createdAt: existing?.createdAt ?? now, updatedAt: now });
    this.repository.saveRelease(releaseId, siteId, plan.planId, now);
    this.repository.updatePlan({ ...plan, status: "activated", updatedAt: now });
  }
  private completeLifecycle(current: SiteOperation, result: SiteOperationResult | null, now: string) {
    const site = this.repository.getManagedSite(current.siteId!);
    if (!site) return;
    if (!result?.desiredState || result.siteId !== current.siteId) throw new ServiceError(409, "BAD_REQUEST", "生命周期结果与站点不匹配");
    this.repository.saveManagedSite({ ...site, desiredState: result.desiredState, version: site.version + 1, updatedAt: now });
  }
}
export class RemoteSiteExecutor implements SiteExecutor {
  constructor(private readonly tasks: RemoteTaskService, private readonly repository: SiteManagementRepository) {}
  async dispatch(operationId: string, nodeId: string, instruction: SiteExecutionInstruction) {
    const task = await this.tasks.create(nodeId, this.taskRequest(operationId, instruction), "controller:site-management", operationId);
    return task.taskId;
  }
  async reconcile(operation: SiteOperation) {
    const candidates = operation.taskId ? [await this.tasks.get(operation.taskId, operation.nodeId)] : await this.tasks.list(operation.nodeId);
    const task = candidates.find((item) => item && (item.taskId === operation.taskId
      || (!operation.taskId && (item.parameters as { operationId?: unknown }).operationId === operation.operationId)));
    if (!task && !operation.taskId && Date.now() - Date.parse(operation.updatedAt) < 60_000) return null;
    if (!task) return { status: "failed" as const, result: null, errorCode: operation.taskId ? "REMOTE_TASK_NOT_FOUND" : "DISPATCH_RESULT_UNKNOWN" };
    if (["queued", "dispatched"].includes(task.status)) return { status: "queued" as const, result: null, errorCode: null, taskId: task.taskId };
    if (task.status === "running") return { status: "running" as const, result: null, errorCode: null, taskId: task.taskId };
    if (task.status !== "succeeded") return { status: "failed" as const, result: null, errorCode: task.errorCode ?? "REMOTE_TASK_FAILED", taskId: task.taskId };
    try { return { status: "succeeded" as const, result: this.result(operation, task.result?.data), errorCode: null, taskId: task.taskId }; }
    catch { return { status: "failed" as const, result: null, errorCode: "INVALID_REMOTE_TASK_RESULT", taskId: task.taskId }; }
  }
  private taskRequest(operationId: string, instruction: SiteExecutionInstruction) {
    const idempotencyKey = `site-operation-${operationId}`;
    if (instruction.type === "prepare") {
      const plan = this.requirePlan(instruction.planId);
      const secrets = this.repository.getPlanExecutionSecrets(plan.planId);
      return { type: "sites.plan.prepare" as const, expiresInSeconds: 1_800, idempotencyKey, parameters: {
        operationId, planId: plan.planId, domains: plan.domains, repositoryUrl: plan.repositoryUrl,
        repositoryRef: plan.repositoryRef, certificateContact: secrets.certificateEmail,
        certificateEnvironment: plan.certificateEnvironment, environmentVariables: secrets.environmentVariables,
        expectedPlanDigest: plan.digest, runtimeInstallAuthorized: false,
      } };
    }
    if (instruction.type === "activate") {
      const plan = this.requirePlan(instruction.planId);
      return { type: "sites.plan.activate" as const, expiresInSeconds: 600, idempotencyKey, parameters: { operationId, planId: plan.planId, stagingId: instruction.stagingId, expectedPlanDigest: plan.digest } };
    }
    if (instruction.type === "lifecycle") return { type: "sites.lifecycle.update" as const, expiresInSeconds: 120, idempotencyKey, parameters: { operationId, siteId: instruction.siteId, action: instruction.action, expectedVersion: instruction.expectedVersion } };
    if (instruction.type === "rollback") return { type: "sites.rollback" as const, expiresInSeconds: 120, idempotencyKey, parameters: { operationId, siteId: instruction.siteId, targetPlanId: instruction.targetPlanId, targetReleaseId: instruction.targetReleaseId, expectedVersion: instruction.expectedVersion } };
    return { type: "sites.logs.read" as const, expiresInSeconds: 60, idempotencyKey, parameters: { operationId, siteId: instruction.siteId, since: instruction.since, limit: instruction.limit } };
  }
  private requirePlan(planId: string) {
    const plan = this.repository.getPlan(planId);
    if (!plan) throw new ServiceError(404, "NOT_FOUND", "站点计划不存在");
    return plan;
  }
  private result(operation: SiteOperation, data: unknown): SiteOperationResult {
    if (operation.type === "prepare") { const value = SitePlanPrepareTaskResultSchema.parse(data); this.assertResultIdentity(operation, value); return emptyResult({ stagingId: value.stagingId, planPreview: value.planPreview }); }
    if (operation.type === "activate") { const value = SitePlanActivateTaskResultSchema.parse(data); this.assertResultIdentity(operation, value); return emptyResult({ siteId: value.siteId, releaseId: value.releaseId }); }
    if (operation.type === "lifecycle") { const value = SiteLifecycleTaskResultSchema.parse(data); this.assertResultIdentity(operation, value); return emptyResult({ siteId: value.siteId, desiredState: value.desiredState }); }
    if (operation.type === "rollback") { const value = SiteRollbackTaskResultSchema.parse(data); this.assertResultIdentity(operation, value); return emptyResult({ siteId: value.siteId, releaseId: value.releaseId, siteVersion: value.version }); }
    const value = SiteLogQueryTaskResultSchema.parse(data); this.assertResultIdentity(operation, value); return emptyResult({ siteId: value.siteId, logs: value.logs });
  }
  private assertResultIdentity(operation: SiteOperation, result: { operationId: string; siteId?: string }) {
    if (result.operationId !== operation.operationId || (operation.siteId && result.siteId !== operation.siteId)) {
      throw new Error("REMOTE_TASK_RESULT_IDENTITY_MISMATCH");
    }
  }
}
