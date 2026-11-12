import { createHash, randomUUID } from "node:crypto";
import {
  AGENT_PROTOCOL_VERSION, CertificateRenewalBatchSchema, RemoteTaskRecordSchema,
  type CertificateRenewalBatch, type CreateCertificateRenewalRequest, type RemoteTaskRecord,
} from "@stackpilot/contracts";
import type { AgentControlRepository, AuditEvent } from "../../repositories/agentControlRepository.js";
import { CertHelperError, requestCertHelper } from "../../platform/certHelperClient.js";
import { ServiceError } from "../serviceError.js";
import { publicSiteId, taskBatchId } from "./siteMonitoringService.js";

export type RenewalAccess = { nodeScope: "all" | string[] };
const terminal = new Set(["succeeded", "failed", "cancelled", "expired"]);
export const LOCAL_RENEWAL_NODE_ID = "00000000-0000-4000-8000-000000000001";
type LocalInventory = { getLocalSites(): Promise<{ sites: Array<{ id: string; nodeId: string; certificate: { renewable: boolean; certificateId: string | null } }> }> };
type HelperClient = (request: { operation: "renew"; certificateId: string }) => Promise<unknown>;

function audit(event: Omit<AuditEvent, "eventId" | "timestamp">): AuditEvent {
  return { eventId: randomUUID(), timestamp: new Date().toISOString(), ...event };
}

function idempotencyPrefix(key: string, requester: string) {
  return `renew-${createHash("sha256").update(`${requester}\0${key}`).digest("hex").slice(0, 48)}-`;
}

function taskIdempotency(prefix: string, nodeId: string) {
  return `${prefix}${createHash("sha256").update(nodeId).digest("hex").slice(0, 16)}`;
}

function canonicalSiteIds(siteIds: readonly string[]) {
  return [...siteIds].sort();
}

function taskCertificates(task: RemoteTaskRecord) {
  const parameters = task.parameters as { certificates?: Array<{ certificateId?: unknown; siteIds?: unknown }> };
  return (parameters.certificates ?? []).flatMap((item) =>
    typeof item.certificateId === "string" && Array.isArray(item.siteIds)
      ? [{ certificateId: item.certificateId, siteIds: item.siteIds.filter((siteId): siteId is string => typeof siteId === "string") }]
      : [],
  );
}

function batchSiteIds(tasks: RemoteTaskRecord[], batchId: string) {
  return canonicalSiteIds(tasks
    .filter((task) => task.type === "sites.certificates.renew" && taskBatchId(task) === batchId)
    .flatMap((task) => taskCertificates(task).flatMap((certificate) => certificate.siteIds)));
}

function locksCertificate(task: RemoteTaskRecord) {
  return !terminal.has(task.status) || task.errorCode === "RESULT_UNKNOWN"
    || (task.attempt > 0 && (task.status === "cancelled" || task.status === "expired"));
}

function operationStatus(task: RemoteTaskRecord) {
  if (!terminal.has(task.status) && Date.parse(task.expiresAt) <= Date.now()) return "expired" as const;
  return task.status === "dispatched" ? "queued" as const : task.status;
}

function aggregateStatus(tasks: RemoteTaskRecord[]): CertificateRenewalBatch["status"] {
  const statuses = tasks.map(operationStatus);
  if (statuses.every((status) => status === "succeeded")) return "succeeded";
  if (statuses.includes("running")) return "running";
  if (statuses.some((status) => status === "queued")) return "queued";
  if (statuses.includes("succeeded")) return "partially_succeeded";
  if (statuses.every((status) => status === "cancelled")) return "cancelled";
  if (statuses.every((status) => status === "expired")) return "expired";
  return "failed";
}

function batchFrom(tasks: RemoteTaskRecord[], batchId: string): CertificateRenewalBatch {
  const batchTasks = tasks.filter((task) => task.type === "sites.certificates.renew" && taskBatchId(task) === batchId);
  if (!batchTasks.length) throw new ServiceError(404, "NOT_FOUND", "证书续期批次不存在");
  return CertificateRenewalBatchSchema.parse({
    batchId,
    status: aggregateStatus(batchTasks),
    createdAt: batchTasks.map((task) => task.createdAt).sort()[0],
    updatedAt: batchTasks.map((task) => task.updatedAt).sort().at(-1),
    operations: batchTasks.flatMap((task) => taskCertificates(task).map((certificate) => ({
      siteIds: certificate.siteIds, nodeId: task.targetNodeId === LOCAL_RENEWAL_NODE_ID ? "node-local" : task.targetNodeId, certificateId: certificate.certificateId,
      taskId: task.taskId, status: operationStatus(task), message: (task.result?.message ?? task.errorCode)?.slice(0, 512) ?? null,
      updatedAt: task.updatedAt,
    }))),
  });
}

export class CertificateRenewalService {
  private processing = false;
  private recovery: Promise<void> | undefined;
  constructor(
    private readonly repository: AgentControlRepository,
    private readonly localInventory?: LocalInventory,
    private readonly helperClient: HelperClient = (request) => requestCertHelper(request),
    private readonly queueLimit = 100,
  ) {}

  async startup() { await this.ensureRecovered(); }

  async create(input: CreateCertificateRenewalRequest, access: RenewalAccess, requester: string, traceId: string) {
    await this.ensureRecovered();
    const prefix = idempotencyPrefix(input.idempotencyKey, requester);
    const localSites = this.localInventory ? (await this.localInventory.getLocalSites()).sites : [];
    let batchId: string | null = null;
    await this.repository.update((state) => {
      const existing = state.tasks.find((task) => task.type === "sites.certificates.renew" && task.idempotencyKey.startsWith(prefix));
      if (existing) {
        const existingBatchId = taskBatchId(existing);
        if (!existingBatchId) throw new ServiceError(500, "INTERNAL_ERROR", "既有证书续期任务缺少批次标识");
        batchId = existingBatchId;
        if (JSON.stringify(batchSiteIds(state.tasks, existingBatchId)) !== JSON.stringify(canonicalSiteIds(input.siteIds))) {
          throw new ServiceError(409, "BAD_REQUEST", "幂等键已用于其他证书续期请求");
        }
        return;
      }

      const requested = new Set(input.siteIds);
      const certificates = new Map<string, { nodeId: string; certificateId: string; siteIds: string[] }>();
      for (const site of localSites) {
        if (!requested.has(site.id)) continue;
        if (!site.certificate.renewable || !site.certificate.certificateId) throw new ServiceError(409, "BAD_REQUEST", "请求包含不可续期的证书");
        requested.delete(site.id);
        const key = `${LOCAL_RENEWAL_NODE_ID}\0${site.certificate.certificateId}`;
        const entry = certificates.get(key) ?? { nodeId: LOCAL_RENEWAL_NODE_ID, certificateId: site.certificate.certificateId, siteIds: [] };
        entry.siteIds.push(site.id); certificates.set(key, entry);
      }
      for (const node of state.nodes) {
        if (!node.siteSnapshot || node.revokedAt || (access.nodeScope !== "all" && !access.nodeScope.includes(node.nodeId))) continue;
        const fresh = Date.now() - Date.parse(node.siteSnapshot.collectedAt) <= 150_000;
        const capable = node.platform === "linux"
          && node.declaredCapabilities.includes("sites.certificates.renew")
          && node.allowedCapabilities.includes("sites.certificates.renew");
        for (const site of node.siteSnapshot.sites) {
          const siteId = publicSiteId(node.nodeId, site.id);
          if (!requested.has(siteId)) continue;
          if (!fresh) throw new ServiceError(409, "BAD_REQUEST", "站点快照已过期，不能续期");
          if (!capable || !site.certificate.renewable || !site.certificate.certificateId) {
            throw new ServiceError(409, "BAD_REQUEST", "请求包含不可续期的证书");
          }
          requested.delete(siteId);
          const key = `${node.nodeId}\0${site.certificate.certificateId}`;
          const entry = certificates.get(key) ?? { nodeId: node.nodeId, certificateId: site.certificate.certificateId, siteIds: [] };
          entry.siteIds.push(siteId); certificates.set(key, entry);
        }
      }
      if (requested.size) throw new ServiceError(404, "NOT_FOUND", "请求包含不存在或超出授权范围的站点");

      for (const candidate of certificates.values()) {
        const duplicate = state.tasks.some((task) => task.type === "sites.certificates.renew"
          && task.targetNodeId === candidate.nodeId && locksCertificate(task)
          && taskCertificates(task).some((item) => item.certificateId === candidate.certificateId));
        if (duplicate) throw new ServiceError(409, "BAD_REQUEST", "证书已有进行中的续期任务");
      }

      const grouped = new Map<string, Array<{ certificateId: string; siteIds: string[] }>>();
      for (const candidate of certificates.values()) {
        const entries = grouped.get(candidate.nodeId) ?? [];
        entries.push({ certificateId: candidate.certificateId, siteIds: candidate.siteIds }); grouped.set(candidate.nodeId, entries);
      }
      for (const [nodeId, entries] of grouped) {
        const queued = state.tasks.filter((task) => task.targetNodeId === nodeId && !terminal.has(task.status)).length;
        if (queued + entries.length > this.queueLimit) throw new ServiceError(409, "BAD_REQUEST", "节点任务队列已满");
      }

      batchId = randomUUID();
      const now = new Date().toISOString();
      for (const [nodeId, entries] of grouped) {
        entries.forEach((entry, index) => {
          const task = RemoteTaskRecordSchema.parse({
            protocolVersion: AGENT_PROTOCOL_VERSION, taskId: randomUUID(), type: "sites.certificates.renew", targetNodeId: nodeId,
            parameters: { batchId, certificates: [entry] }, createdAt: now, expiresAt: new Date(Date.now() + 600_000).toISOString(),
            idempotencyKey: `${taskIdempotency(prefix, nodeId)}-${index}`, requester, traceId, requiredCapability: "sites.certificates.renew",
            attempt: 0, maxAttempts: 1, status: "queued", updatedAt: now, result: null, errorCode: null, retryable: false, nextAttemptAt: null,
          });
          state.tasks.push(task);
          state.audits.push(audit({
            requester, nodeId, taskId: task.taskId, event: "certificate-renewal.created", taskType: task.type,
            parameters: { batchId, certificates: [{ certificateId: entry.certificateId, siteCount: entry.siteIds.length }] },
            fromStatus: null, toStatus: "queued", resultSummary: null, traceId,
          }));
        });
      }
    }, { sections: ["nodes", "tasks"] });
    if (!batchId) throw new ServiceError(500, "INTERNAL_ERROR", "续期批次未保存");
    void this.runLocalQueued();
    return this.get(batchId, access);
  }

  async get(batchId: string, access: RenewalAccess) {
    await this.ensureRecovered();
    const state = await this.repository.read({ sections: ["tasks"] });
    const tasks = state.tasks.filter((task) => taskBatchId(task) === batchId);
    if (!tasks.length) throw new ServiceError(404, "NOT_FOUND", "证书续期批次不存在");
    if (access.nodeScope !== "all" && tasks.some((task) => task.targetNodeId !== LOCAL_RENEWAL_NODE_ID && !access.nodeScope.includes(task.targetNodeId))) {
      throw new ServiceError(403, "FORBIDDEN", "证书续期批次超出授权范围");
    }
    return batchFrom(state.tasks, batchId);
  }

  private ensureRecovered() {
    this.recovery ??= this.recoverAndRun();
    return this.recovery;
  }

  private async recoverAndRun() {
    await this.repository.update((state) => {
      const now = new Date().toISOString();
      for (const task of state.tasks) {
        if (task.targetNodeId !== LOCAL_RENEWAL_NODE_ID || task.type !== "sites.certificates.renew" || task.status !== "running") continue;
        task.status = "failed"; task.updatedAt = now; task.errorCode = "RESULT_UNKNOWN"; task.result = { message: "Controller restarted while local certificate renewal was running; the task was not replayed", truncated: false };
        state.audits.push(audit({ requester: "controller", nodeId: task.targetNodeId, taskId: task.taskId, event: "certificate-renewal.interrupted", taskType: task.type, parameters: null, fromStatus: "running", toStatus: "failed", resultSummary: "result unknown; not replayed", traceId: randomUUID() }));
      }
    }, { sections: ["tasks"], nodeId: LOCAL_RENEWAL_NODE_ID, activeTasks: true });
    await this.runLocalQueued();
  }

  private async runLocalQueued() {
    if (this.processing) return;
    this.processing = true;
    try {
      while (true) {
        let taskId: string | null = null;
        await this.repository.update((state) => {
          const task = state.tasks.find((item) => item.targetNodeId === LOCAL_RENEWAL_NODE_ID && item.type === "sites.certificates.renew" && item.status === "queued");
          if (!task) return;
          if (Date.parse(task.expiresAt) <= Date.now()) { task.status = "expired"; task.updatedAt = new Date().toISOString(); task.errorCode = "TASK_EXPIRED"; return; }
          task.status = "running"; task.attempt = 1; task.updatedAt = new Date().toISOString(); taskId = task.taskId;
        }, { sections: ["tasks"], nodeId: LOCAL_RENEWAL_NODE_ID, taskStatus: "queued" });
        if (!taskId) break;
        const state = await this.repository.read({ sections: ["tasks"], taskId });
        const task = state.tasks.find((item) => item.taskId === taskId)!;
        let result: { status: "succeeded" | "failed"; message: string; errorCode: string | null };
        try {
          for (const certificate of taskCertificates(task)) await this.helperClient({ operation: "renew", certificateId: certificate.certificateId });
          result = { status: "succeeded", message: "Certificate renewal, Nginx validation and reload completed", errorCode: null };
        } catch (error) {
          const code = error instanceof CertHelperError ? error.code : "CERT_HELPER_FAILED";
          const unknown = new Set(["CERT_HELPER_TIMEOUT", "CERT_HELPER_CANCELLED", "CERT_HELPER_INVALID_RESPONSE", "CERT_HELPER_UNAVAILABLE", "CERT_HELPER_RESPONSE_TOO_LARGE"]);
          result = unknown.has(code)
            ? { status: "failed", message: "Local certificate renewal result is unknown; it will not be replayed", errorCode: "RESULT_UNKNOWN" }
            : { status: "failed", message: "Local certificate renewal failed; inspect the root helper logs", errorCode: code };
        }
        await this.repository.update((next) => {
          const current = next.tasks.find((item) => item.taskId === taskId);
          if (!current || current.status !== "running") return;
          current.status = result.status; current.updatedAt = new Date().toISOString(); current.errorCode = result.errorCode;
          current.result = { message: result.message, truncated: false };
          next.audits.push(audit({ requester: "controller-local", nodeId: current.targetNodeId, taskId: current.taskId, event: "certificate-renewal.status", taskType: current.type, parameters: null, fromStatus: "running", toStatus: result.status, resultSummary: result.message, traceId: current.traceId }));
        }, { sections: ["tasks"], taskId });
      }
    } finally { this.processing = false; }
  }
}
