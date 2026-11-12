import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  AGENT_PROTOCOL_VERSION, AGENT_TASK_CONCURRENCY, RemoteTaskEnvelopeSchema, RemoteTaskRecordSchema,
  type AgentCapability, type CreateRemoteTaskRequest, type NodeScope, type Permission, type RemoteTaskRecord, type RemoteTaskStatus, type RemoteTaskStatusUpdate,
} from "@stackpilot/contracts";
import type { AgentControlRepository, AuditEvent } from "../../repositories/agentControlRepository.js";
import { ServiceError } from "../serviceError.js";

const terminal: readonly RemoteTaskStatus[] = ["succeeded", "failed", "cancelled", "expired"];
const irreversibleTypes: ReadonlySet<CreateRemoteTaskRequest["type"]> = new Set(["sites.certificates.renew", "sites.rollback"]);
const transitions: Record<RemoteTaskStatus, readonly RemoteTaskStatus[]> = {
  queued: ["dispatched", "cancelled", "expired"], dispatched: ["running", "queued", "succeeded", "failed", "cancelled", "expired"],
  running: ["succeeded", "failed", "cancelled", "expired"], succeeded: [], failed: ["queued"], cancelled: [], expired: [],
};
const requiredCapability: Record<CreateRemoteTaskRequest["type"], AgentCapability> = {
  "system.summary.read": "system.summary.read",
  "service.status.read": "service.status.read",
  "sites.plan.prepare": "sites.deploy",
  "sites.plan.activate": "sites.deploy",
  "sites.rollback": "sites.deploy",
  "sites.lifecycle.update": "sites.lifecycle.manage",
  "sites.logs.read": "sites.logs.read",
  "terminal.command.execute": "terminal.command.execute",
  "sites.certificates.renew": "sites.certificates.renew",
};
const singleAttemptTypes: ReadonlySet<CreateRemoteTaskRequest["type"]> = new Set(["terminal.command.execute", "sites.plan.prepare", "sites.plan.activate", "sites.rollback", "sites.lifecycle.update", "sites.logs.read", "sites.certificates.renew"]);
const audit = (event: Omit<AuditEvent, "eventId" | "timestamp">): AuditEvent => ({ eventId: randomUUID(), timestamp: new Date().toISOString(), ...event });
const sensitiveResultKey = /authorization|cookie|token|secret|password|private|environment|stdout|stderr/i;
function containsSensitiveKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsSensitiveKey);
  if (value && typeof value === "object") return Object.entries(value).some(([key, nested]) => sensitiveResultKey.test(key) || containsSensitiveKey(nested));
  return false;
}
const taskResultSummary = (task: RemoteTaskRecord, message?: string) => task.type === "terminal.command.execute" ? message ? "Terminal command result recorded" : null : message ?? null;

function sameTaskOperation(task: RemoteTaskRecord, input: CreateRemoteTaskRequest, requester: string) {
  return task.requester === requester && task.type === input.type
    && isDeepStrictEqual(parametersForIdentity(task.type, task.parameters), parametersForIdentity(input.type, input.parameters))
    && Math.round((Date.parse(task.expiresAt) - Date.parse(task.createdAt)) / 1_000) === input.expiresInSeconds;
}

function parametersForIdentity(type: CreateRemoteTaskRequest["type"], parameters: Record<string, unknown>) {
  if (type !== "sites.plan.prepare") return parameters;
  const identity = { ...parameters };
  delete identity.runtimeInstallAuthorized;
  return identity;
}

function parametersForNode(type: CreateRemoteTaskRequest["type"], parameters: Record<string, unknown>, node: { allowedCapabilities: AgentCapability[]; declaredCapabilities: AgentCapability[] }) {
  if (type !== "sites.plan.prepare") return parameters;
  const runtimeInstallAuthorized = node.allowedCapabilities.includes("runtime.install") && node.declaredCapabilities.includes("runtime.install");
  return { ...parameters, runtimeInstallAuthorized };
}

function expireTask(task: RemoteTaskRecord, now: string): RemoteTaskStatus | null {
  if (terminal.includes(task.status) || Date.parse(task.expiresAt) > Date.parse(now)) return null;
  const previous = task.status;
  if (irreversibleTypes.has(task.type) && task.attempt > 0) {
    task.status = "failed"; task.errorCode = "RESULT_UNKNOWN";
    task.result = { message: "Certificate renewal result is unknown after task expiry; it will not be replayed", truncated: false };
  } else { task.status = "expired"; task.errorCode = "TASK_EXPIRED"; }
  task.updatedAt = now;
  return previous;
}

export function transitionTask(task: RemoteTaskRecord, next: RemoteTaskStatus, now = new Date().toISOString()) {
  if (!transitions[task.status].includes(next)) throw new ServiceError(409, "BAD_REQUEST", `任务状态不能从 ${task.status} 转换为 ${next}`);
  task.status = next; task.updatedAt = now;
}

export class RemoteTaskService {
  constructor(private readonly repository: AgentControlRepository, private readonly queueLimit = 100) {}

  private reconcile(state: { tasks: RemoteTaskRecord[]; audits: AuditEvent[] }, traceId: string = randomUUID(), now = new Date().toISOString()) {
    for (const task of state.tasks) {
      const previous = expireTask(task, now);
      if (previous) {
        state.audits.push(audit({ requester: "controller", nodeId: task.targetNodeId, taskId: task.taskId, event: task.errorCode === "RESULT_UNKNOWN" ? "task.result-unknown" : "task.expired", taskType: task.type, parameters: null, fromStatus: previous, toStatus: task.status, resultSummary: task.result?.message ?? null, traceId })); continue;
      }
    }
  }

  async createForUser(nodeId: string, input: CreateRemoteTaskRequest, requester: string, traceId: string,
    access: { permissions: ReadonlySet<Permission>; nodeScope: NodeScope }, authorize: () => void) {
    if (!access.permissions.has("tasks:create") || (access.nodeScope !== "all" && !access.nodeScope.includes(nodeId))) {
      throw new ServiceError(403, "FORBIDDEN", "任务权限不足或节点超出授权范围");
    }
    // Site tasks must also pass plan, protection and operation-lock checks in the site service.
    if (input.type.startsWith("sites.")) throw new ServiceError(403, "FORBIDDEN", "站点任务只能通过对应的站点业务接口创建");
    if (input.type === "terminal.command.execute" && !access.permissions.has("terminal:execute")) {
      throw new ServiceError(403, "FORBIDDEN", "缺少终端执行权限");
    }
    return this.create(nodeId, input, requester, traceId, authorize);
  }

  async create(nodeId: string, input: CreateRemoteTaskRequest, requester: string, traceId: string, authorize: () => void = () => undefined) {
    let created: RemoteTaskRecord | undefined;
    await this.repository.update((state) => {
      this.reconcile(state, traceId);
      const node = state.nodes.find((item) => item.nodeId === nodeId);
      if (!node || node.revokedAt) throw new ServiceError(404, "NOT_FOUND", "目标节点不存在或已撤销");
      const capability = requiredCapability[input.type];
      if (!node.allowedCapabilities.includes(capability) || !node.declaredCapabilities.includes(capability)) throw new ServiceError(403, "FORBIDDEN", "Controller 未授权节点执行该能力或 Agent 未声明该能力");
      const effectiveInput = { ...input, parameters: parametersForNode(input.type, input.parameters, node) } as CreateRemoteTaskRequest;
      const duplicate = state.tasks.find((item) => item.targetNodeId === nodeId && item.idempotencyKey === input.idempotencyKey);
      if (duplicate) {
        if (!sameTaskOperation(duplicate, effectiveInput, requester)) throw new ServiceError(409, "BAD_REQUEST", "幂等键已用于其他远程任务");
      }
      if (!duplicate && state.tasks.filter((item) => item.targetNodeId === nodeId && !terminal.includes(item.status)).length >= this.queueLimit) throw new ServiceError(409, "BAD_REQUEST", "节点任务队列已满");
      authorize();
      if (duplicate) { created = duplicate; return; }
      const now = new Date().toISOString();
      created = RemoteTaskRecordSchema.parse({
        protocolVersion: AGENT_PROTOCOL_VERSION, taskId: randomUUID(), type: input.type, targetNodeId: nodeId,
        parameters: effectiveInput.parameters, createdAt: now, expiresAt: new Date(Date.now() + input.expiresInSeconds * 1000).toISOString(),
        idempotencyKey: input.idempotencyKey, requester, traceId, requiredCapability: capability, attempt: 0,
        maxAttempts: singleAttemptTypes.has(input.type) ? 1 : 3,
        status: "queued", updatedAt: now, result: null, errorCode: null,
        retryable: !singleAttemptTypes.has(input.type), nextAttemptAt: null,
      });
      state.tasks.push(created);
      const parameters = input.parameters as Record<string, unknown>;
      const identifiers = Object.fromEntries(["operationId", "planId", "siteId", "batchId"].flatMap((key) => typeof parameters[key] === "string" ? [[key, parameters[key]]] : []));
      state.audits.push(audit({ requester, nodeId, taskId: created.taskId, event: "task.created", taskType: input.type, parameters: identifiers, fromStatus: null, toStatus: "queued", resultSummary: null, traceId }));
    }, { sections: ["nodes", "tasks"], nodeId });
    if (!created) throw new ServiceError(500, "INTERNAL_ERROR", "任务状态未保存");
    return created as RemoteTaskRecord;
  }

  async list(nodeId?: string) {
    const state = await this.repository.update((next) => this.reconcile(next), { sections: ["tasks"], ...(nodeId ? { nodeId } : {}) });
    return nodeId ? state.tasks.filter((item) => item.targetNodeId === nodeId) : state.tasks;
  }

  async get(taskId: string, nodeId?: string) {
    const state = await this.repository.update((next) => this.reconcile(next), { sections: ["tasks"], taskId, ...(nodeId ? { nodeId } : {}) });
    return state.tasks[0];
  }

  async getReadOnly(taskId: string) {
    const task = (await this.repository.read({ sections: ["tasks"], taskId })).tasks[0];
    if (task) expireTask(task, new Date().toISOString());
    return task;
  }

  async listReadOnly(nodeId?: string, nodeScope: NodeScope = "all", limit = 200, filter?: (task: RemoteTaskRecord) => boolean) {
    const scoped = (await this.repository.read({ sections: ["tasks"], ...(nodeId ? { nodeId } : {}), ...(nodeScope === "all" ? {} : { nodeIds: nodeScope }), ...(filter ? {} : { taskLimit: limit }) })).tasks;
    // Payload-level filters must run before pagination; SQL still scopes nodes before decryption.
    const tasks = filter ? scoped.filter(filter).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.taskId.localeCompare(left.taskId)).slice(0, limit) : scoped;
    const now = new Date().toISOString();
    for (const task of tasks) expireTask(task, now);
    return nodeId ? tasks.filter((item) => item.targetNodeId === nodeId) : tasks;
  }

  async poll(nodeId: string, traceId: string) {
    const dispatched: RemoteTaskRecord[] = [];
    await this.repository.update((state) => {
      this.reconcile(state, traceId); const node = state.nodes.find((item) => item.nodeId === nodeId);
      if (!node || node.revokedAt) throw new ServiceError(401, "UNAUTHORIZED", "节点不存在或已撤销");
      const running = state.tasks.filter((item) => item.targetNodeId === nodeId && item.status === "running");
      const available = Math.max(0, AGENT_TASK_CONCURRENCY - running.length);
      let siteActive = running.some((item) => item.type.startsWith("sites."));
      const candidates = state.tasks.filter((item) => item.targetNodeId === nodeId
        && (item.status === "dispatched" || (item.status === "queued" && (!item.nextAttemptAt || Date.parse(item.nextAttemptAt) <= Date.now()))))
        .sort((left, right) => Number(right.status === "dispatched") - Number(left.status === "dispatched"));
      for (const task of candidates) {
        if (dispatched.length >= available) break;
        if (task.type.startsWith("sites.") && siteActive) continue;
        if (!node.allowedCapabilities.includes(task.requiredCapability) || !node.declaredCapabilities.includes(task.requiredCapability)) { task.status = "cancelled"; task.errorCode = "CAPABILITY_REVOKED"; continue; }
        if (task.status === "dispatched") {
          // Lost poll responses and temporarily busy executors redeliver the same attempt.
          dispatched.push(structuredClone(task));
          if (task.type.startsWith("sites.")) siteActive = true;
          continue;
        }
        task.parameters = parametersForNode(task.type, task.parameters, node);
        transitionTask(task, "dispatched"); task.attempt += 1; dispatched.push(structuredClone(task));
        if (task.type.startsWith("sites.")) siteActive = true;
        state.audits.push(audit({ requester: `agent:${nodeId}`, nodeId, taskId: task.taskId, event: "task.dispatched", taskType: task.type, parameters: null, fromStatus: "queued", toStatus: "dispatched", resultSummary: null, traceId }));
      }
    }, { sections: ["nodes", "tasks"], nodeId, activeTasks: true });
    return dispatched.map((task) => RemoteTaskEnvelopeSchema.parse({
      protocolVersion: task.protocolVersion, taskId: task.taskId, type: task.type, targetNodeId: task.targetNodeId,
      parameters: task.parameters, createdAt: task.createdAt, expiresAt: task.expiresAt,
      idempotencyKey: task.idempotencyKey, requester: task.requester, traceId: task.traceId,
      requiredCapability: task.requiredCapability, attempt: task.attempt, maxAttempts: task.maxAttempts,
    }));
  }

  async cancellations(nodeId: string) {
    const state = await this.repository.read({ sections: ["tasks"], nodeId, taskStatus: "cancelled", taskLimit: 100 });
    return state.tasks.filter((item) => item.targetNodeId === nodeId && item.status === "cancelled").slice(-100).map((item) => item.taskId);
  }

  async update(nodeId: string, input: RemoteTaskStatusUpdate, traceId: string) {
    if (input.result && (Buffer.byteLength(JSON.stringify(input.result), "utf8") > 16_384 || containsSensitiveKey(input.result))) throw new ServiceError(400, "BAD_REQUEST", "任务结果包含禁止字段或超过大小限制");
    // Request signatures enforce freshness; persisted task events may arrive after a long outage.
    const eventTime = Date.parse(input.timestamp);
    if (!Number.isFinite(eventTime) || eventTime > Date.now() + 5 * 60 * 1000) throw new ServiceError(400, "BAD_REQUEST", "任务状态时间无效或来自未来");
    let updated: RemoteTaskRecord | null = null;
    await this.repository.update((state) => {
      const task = state.tasks.find((item) => item.taskId === input.taskId && item.targetNodeId === nodeId);
      if (!task) throw new ServiceError(404, "NOT_FOUND", "任务不存在");
      if (eventTime < Date.parse(task.createdAt) - 5 * 60 * 1000) throw new ServiceError(400, "BAD_REQUEST", "任务状态时间早于任务创建时间");
      if (input.attempt !== task.attempt) throw new ServiceError(409, "BAD_REQUEST", "任务投递 attempt 不匹配");
      if (terminal.includes(task.status)) {
        if (task.errorCode === "RESULT_UNKNOWN" && (input.status === "succeeded" || input.status === "failed")) {
          const previous = task.status;
          task.status = input.status; task.updatedAt = input.timestamp; task.result = input.result ?? null; task.errorCode = input.errorCode ?? null;
          state.audits.push(audit({ requester: `agent:${nodeId}`, nodeId, taskId: task.taskId, event: "task.result-reconciled", taskType: task.type, parameters: null, fromStatus: previous, toStatus: task.status, resultSummary: taskResultSummary(task, input.result?.message), traceId }));
          updated = task;
        } else { updated = task; }
        return;
      }
      if (task.status === "queued" && task.attempt > 0 && input.status === "failed") { updated = task; return; }
      if (task.status === input.status) { updated = task; return; }
      const previous = task.status; transitionTask(task, input.status, input.timestamp);
      task.result = input.result ?? null; task.errorCode = input.errorCode ?? null; task.nextAttemptAt = null;
      const unknownIrreversible = irreversibleTypes.has(task.type) && task.attempt > 0
        && (input.status === "cancelled" || (input.status === "failed"
          && ["AGENT_RESTARTED_DURING_TASK", "TASK_CANCELLED_OR_TIMEOUT", "CERT_HELPER_TIMEOUT", "CERT_HELPER_CANCELLED", "RESULT_UNKNOWN"].includes(input.errorCode ?? "")));
      if (unknownIrreversible) {
        task.status = "failed";
        task.errorCode = "RESULT_UNKNOWN";
        task.result = { message: "Irreversible task result is unknown; it will not be replayed", truncated: false };
      }
      if (input.status === "failed" && task.retryable && task.attempt < task.maxAttempts && Date.parse(task.expiresAt) > Date.now()) {
        transitionTask(task, "queued"); task.nextAttemptAt = new Date(Date.now() + 1000 * (2 ** Math.max(task.attempt - 1, 0))).toISOString();
      }
      state.audits.push(audit({ requester: `agent:${nodeId}`, nodeId, taskId: task.taskId, event: "task.status", taskType: task.type, parameters: null, fromStatus: previous, toStatus: task.status, resultSummary: taskResultSummary(task, input.result?.message), traceId }));
      updated = task;
    }, { sections: ["tasks"], nodeId, taskId: input.taskId });
    if (!updated) throw new ServiceError(500, "INTERNAL_ERROR", "任务状态未保存");
    return updated;
  }

  async cancel(taskId: string, requester: string, reason: string, traceId: string) {
    let updated: RemoteTaskRecord | null = null;
    await this.repository.update((state) => {
      const task = state.tasks.find((item) => item.taskId === taskId);
      if (!task) throw new ServiceError(404, "NOT_FOUND", "任务不存在");
      if (terminal.includes(task.status)) { updated = task; return; }
      if (irreversibleTypes.has(task.type) && (task.status === "dispatched" || task.status === "running" || task.attempt > 0)) {
        throw new ServiceError(409, "BAD_REQUEST", "不可逆任务开始执行后不能取消；结果未知时不会自动重放");
      }
      const previous = task.status; transitionTask(task, "cancelled"); task.errorCode = "CANCELLED_BY_REQUESTER";
      state.audits.push(audit({ requester, nodeId: task.targetNodeId, taskId, event: "task.cancelled", taskType: task.type, parameters: { reason }, fromStatus: previous, toStatus: "cancelled", resultSummary: null, traceId }));
      updated = task;
    }, { sections: ["tasks"], taskId });
    if (!updated) throw new ServiceError(500, "INTERNAL_ERROR", "任务状态未保存");
    return updated;
  }
}
