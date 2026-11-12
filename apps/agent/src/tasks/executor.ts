import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { isAgentProtocolCompatible, RemoteTaskEnvelopeSchema, type AgentCapability, type AgentPlatform, type RemoteTaskStatusUpdate } from "@stackpilot/contracts";
import { taskRegistry } from "./registry.js";
import { z } from "zod";

const ReceiptSchema = z.object({ taskId: z.string().uuid(), taskType: z.string().optional(), idempotencyKey: z.string(), attempt: z.number().int().min(1).max(3), status: z.enum(["running", "succeeded", "failed", "cancelled"]), updatedAt: z.string().datetime(), reported: z.boolean(), update: z.object({ taskId: z.string().uuid(), attempt: z.number().int().min(1).max(3), status: z.enum(["running", "succeeded", "failed", "cancelled"]), timestamp: z.string().datetime(), result: z.object({ message: z.string(), data: z.record(z.string(), z.unknown()).optional(), truncated: z.boolean() }).optional(), errorCode: z.string().optional() }).strict() }).strict();
type Receipt = z.infer<typeof ReceiptSchema>;

export class TaskExecutor {
  private receipts = new Map<string, Receipt>();
  private running = new Map<string, { controller: AbortController; cancellable: boolean; taskType: string }>();
  private persistence = Promise.resolve();
  private capabilities: readonly AgentCapability[];
  constructor(private readonly receiptPath: string, private readonly nodeId: string, private readonly platform: AgentPlatform, capabilities: readonly AgentCapability[], private readonly registry = taskRegistry) { this.capabilities = capabilities; }
  async load() {
    try {
      const rows = z.array(ReceiptSchema).max(1000).parse(JSON.parse(await readFile(this.receiptPath, "utf8")));
      this.receipts = new Map(rows.map((row) => {
        if (row.status !== "running") return [row.taskId, row];
        const irreversible = row.taskType === "sites.certificates.renew" || row.taskType === "sites.rollback" || row.idempotencyKey.startsWith("renew-");
        const update: RemoteTaskStatusUpdate = { taskId: row.taskId, attempt: row.attempt ?? 1, status: "failed", timestamp: new Date().toISOString(), errorCode: irreversible ? "RESULT_UNKNOWN" : "AGENT_RESTARTED_DURING_TASK", result: { message: irreversible ? "Irreversible task result is unknown after Agent restart; it will not be replayed" : "Agent restarted before task completion", truncated: false } };
        return [row.taskId, { ...row, attempt: row.attempt ?? 1, status: "failed" as const, updatedAt: update.timestamp, reported: false, update }];
      }));
      await this.persist();
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  private persist() {
    const write = async () => { const directory = dirname(this.receiptPath); await mkdir(directory, { recursive: true, mode: 0o700 }); await chmod(directory, 0o700); const temporary = `${this.receiptPath}.${process.pid}.tmp`; await writeFile(temporary, JSON.stringify([...this.receipts.values()].slice(-1000), null, 2), { mode: 0o600 }); await rename(temporary, this.receiptPath); await chmod(this.receiptPath, 0o600); };
    const pending = this.persistence.then(write, write);
    this.persistence = pending.catch(() => undefined);
    return pending;
  }
  cancel(taskId: string) { const running = this.running.get(taskId); if (running?.cancellable) running.controller.abort(); }
  setCapabilities(capabilities: readonly AgentCapability[]) { this.capabilities = capabilities; }
  get activeCount() { return this.running.size; }
  get activeSiteOperationCount() { return [...this.running.values()].filter((task) => task.taskType.startsWith("sites.")).length; }
  pendingUpdates() { return [...this.receipts.values()].filter((receipt) => !receipt.reported).map((receipt) => receipt.update); }
  async markReported(taskId: string, expected?: RemoteTaskStatusUpdate) {
    const receipt = this.receipts.get(taskId);
    // An acknowledgement for a running receipt must not acknowledge a newer terminal result.
    if (receipt && (!expected || receipt.update.attempt === expected.attempt && receipt.update.status === expected.status && receipt.update.timestamp === expected.timestamp)) {
      receipt.reported = true; await this.persist();
    }
  }
  tryExecute(raw: unknown, maxConcurrent: number, onRunning?: (update: RemoteTaskStatusUpdate) => Promise<void>) {
    if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1) throw new Error("INVALID_CONCURRENCY_LIMIT");
    const task = RemoteTaskEnvelopeSchema.parse(raw);
    if (this.activeCount >= maxConcurrent || (task.type.startsWith("sites.") && this.activeSiteOperationCount > 0)) return undefined;
    return this.execute(task, onRunning);
  }
  async execute(raw: unknown, onRunning?: (update: RemoteTaskStatusUpdate) => Promise<void>): Promise<RemoteTaskStatusUpdate> {
    const task = RemoteTaskEnvelopeSchema.parse(raw); const existing = this.receipts.get(task.taskId);
    if (existing && !(existing.status === "failed" && task.attempt > existing.attempt && this.registry[task.type]?.retryable)) return existing.update;
    const duplicateKey = [...this.receipts.values()].find((receipt) => receipt.idempotencyKey === task.idempotencyKey && receipt.taskId !== task.taskId);
    if (duplicateKey) return { taskId: task.taskId, attempt: task.attempt, status: "failed", timestamp: new Date().toISOString(), errorCode: "DUPLICATE_IDEMPOTENCY_KEY", result: { message: "Task idempotency key was already processed", truncated: false } };
    if (!isAgentProtocolCompatible(task.protocolVersion)) throw new Error("INCOMPATIBLE_PROTOCOL");
    if (task.targetNodeId !== this.nodeId) throw new Error("WRONG_TARGET");
    if (Date.parse(task.expiresAt) <= Date.now()) throw new Error("TASK_EXPIRED");
    const definition = this.registry[task.type];
    if (!definition || definition.capability !== task.requiredCapability || !this.capabilities.includes(definition.capability)) throw new Error("CAPABILITY_DENIED");
    if (!definition.platforms.includes(this.platform)) throw new Error("PLATFORM_UNSUPPORTED");
    const parameters = definition.validate(task.parameters); const startedAt = new Date().toISOString();
    const runningUpdate: RemoteTaskStatusUpdate = { taskId: task.taskId, attempt: task.attempt, status: "running", timestamp: startedAt };
    const controller = new AbortController(); this.running.set(task.taskId, { controller, cancellable: definition.cancellable, taskType: task.type });
    try {
      this.receipts.set(task.taskId, { taskId: task.taskId, taskType: task.type, idempotencyKey: task.idempotencyKey, attempt: task.attempt, status: "running", updatedAt: startedAt, reported: false, update: runningUpdate }); await this.persist();
      if (onRunning) {
        try { await onRunning(runningUpdate); const receipt = this.receipts.get(task.taskId); if (receipt) { receipt.reported = true; await this.persist(); } }
        catch { /* The terminal receipt is authoritative when the running acknowledgement is lost. */ }
      }
      const timer = setTimeout(() => controller.abort(), definition.timeoutMs);
      let update: RemoteTaskStatusUpdate;
      try { const result = await definition.run(parameters, controller.signal, this.nodeId, this.capabilities); controller.signal.throwIfAborted(); update = { taskId: task.taskId, attempt: task.attempt, status: "succeeded", timestamp: new Date().toISOString(), result }; }
      catch (error) { const aborted = controller.signal.aborted; const unknown = aborted && !definition.cancellable; const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" && /^[A-Z0-9_]{1,80}$/.test(error.code) ? error.code : error instanceof Error && /^[A-Z0-9_]{1,80}$/.test(error.name) ? error.name : "TASK_FAILED"; update = { taskId: task.taskId, attempt: task.attempt, status: aborted && definition.cancellable ? "cancelled" : "failed", timestamp: new Date().toISOString(), errorCode: unknown ? "RESULT_UNKNOWN" : aborted ? "TASK_CANCELLED_OR_TIMEOUT" : code, result: { message: unknown ? "Task result is unknown after timeout; it will not be replayed" : aborted ? "Task cancelled or timed out" : "Task failed", truncated: false } }; }
      finally { clearTimeout(timer); }
      this.receipts.set(task.taskId, { taskId: task.taskId, taskType: task.type, idempotencyKey: task.idempotencyKey, attempt: task.attempt, status: update.status, updatedAt: update.timestamp, reported: false, update }); await this.persist(); return update;
    } finally { this.running.delete(task.taskId); }
  }
}
