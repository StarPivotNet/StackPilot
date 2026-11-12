import { z } from "zod";
import { AgentCapabilitySchema } from "./capabilities.js";
import { ProtocolVersionSchema } from "../versioning/index.js";
import {
  CertificateRenewalTaskParametersSchema, SiteLifecycleTaskParametersSchema, SiteLogQueryTaskParametersSchema,
  SitePlanActivateTaskParametersSchema, SitePlanPrepareTaskParametersSchema, SiteRollbackTaskParametersSchema,
} from "../sites/index.js";

export const RemoteTaskStatusSchema = z.enum(["queued", "dispatched", "running", "succeeded", "failed", "cancelled", "expired"]);
export const AGENT_TASK_CONCURRENCY = 4;
export const SystemSummaryTaskParametersSchema = z.object({ includeLoad: z.boolean().default(true) }).strict();
const ServiceNameSchema = z.string().min(1).max(120).regex(/^[A-Za-z0-9][A-Za-z0-9_.@:-]*$/);
export const ServiceStatusTaskParametersSchema = z.object({ serviceName: ServiceNameSchema }).strict();
const TerminalServiceNameSchema = ServiceNameSchema;
export const TerminalCommandTaskParametersSchema = z.discriminatedUnion("command", [
  z.object({ command: z.literal("disk-usage") }).strict(),
  z.object({ command: z.literal("uptime") }).strict(),
  z.object({ command: z.literal("top-summary") }).strict(),
  z.object({ command: z.literal("service-status"), serviceName: TerminalServiceNameSchema }).strict(),
]);
export const RemoteTaskTypeSchema = z.enum([
  "system.summary.read", "service.status.read", "terminal.command.execute", "sites.plan.prepare", "sites.plan.activate",
  "sites.rollback", "sites.lifecycle.update", "sites.logs.read", "sites.certificates.renew",
]);
export const CreateRemoteTaskRequestSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("system.summary.read"), parameters: SystemSummaryTaskParametersSchema, expiresInSeconds: z.number().int().min(5).max(900).default(120), idempotencyKey: z.string().min(8).max(160) }).strict(),
  z.object({ type: z.literal("service.status.read"), parameters: ServiceStatusTaskParametersSchema, expiresInSeconds: z.number().int().min(5).max(900).default(120), idempotencyKey: z.string().min(8).max(160) }).strict(),
  z.object({ type: z.literal("terminal.command.execute"), parameters: TerminalCommandTaskParametersSchema, expiresInSeconds: z.number().int().min(5).max(120).default(30), idempotencyKey: z.string().min(8).max(160) }).strict(),
  z.object({ type: z.literal("sites.plan.prepare"), parameters: SitePlanPrepareTaskParametersSchema, expiresInSeconds: z.number().int().min(60).max(1_800).default(1_800), idempotencyKey: z.string().min(8).max(160) }).strict(),
  z.object({ type: z.literal("sites.plan.activate"), parameters: SitePlanActivateTaskParametersSchema, expiresInSeconds: z.number().int().min(30).max(900).default(600), idempotencyKey: z.string().min(8).max(160) }).strict(),
  z.object({ type: z.literal("sites.rollback"), parameters: SiteRollbackTaskParametersSchema, expiresInSeconds: z.number().int().min(30).max(300).default(120), idempotencyKey: z.string().min(8).max(160) }).strict(),
  z.object({ type: z.literal("sites.lifecycle.update"), parameters: SiteLifecycleTaskParametersSchema, expiresInSeconds: z.number().int().min(30).max(300).default(120), idempotencyKey: z.string().min(8).max(160) }).strict(),
  z.object({ type: z.literal("sites.logs.read"), parameters: SiteLogQueryTaskParametersSchema, expiresInSeconds: z.number().int().min(10).max(120).default(60), idempotencyKey: z.string().min(8).max(160) }).strict(),
  z.object({ type: z.literal("sites.certificates.renew"), parameters: CertificateRenewalTaskParametersSchema, expiresInSeconds: z.number().int().min(30).max(900).default(600), idempotencyKey: z.string().min(8).max(160) }).strict(),
]);
export const RemoteTaskEnvelopeSchema = z.object({
  protocolVersion: ProtocolVersionSchema, taskId: z.string().uuid(), type: RemoteTaskTypeSchema, targetNodeId: z.string().uuid(),
  parameters: z.record(z.string(), z.unknown()), createdAt: z.string().datetime(), expiresAt: z.string().datetime(),
  idempotencyKey: z.string().min(8).max(160), requester: z.string().min(1).max(160), traceId: z.string().uuid(),
  requiredCapability: AgentCapabilitySchema, attempt: z.number().int().min(0).max(3), maxAttempts: z.number().int().min(1).max(3),
}).strict();
export const RemoteTaskResultSummarySchema = z.object({ message: z.string().max(1024), data: z.record(z.string(), z.unknown()).optional(), truncated: z.boolean().default(false) }).strict();
export const RemoteTaskStatusUpdateSchema = z.object({
  taskId: z.string().uuid(), attempt: z.number().int().min(1).max(3), status: z.enum(["running", "succeeded", "failed", "cancelled"]), timestamp: z.string().datetime(),
  result: RemoteTaskResultSummarySchema.optional(), errorCode: z.string().max(80).optional(),
}).strict();
export const RemoteTaskPollResponseSchema = z.object({ tasks: z.array(RemoteTaskEnvelopeSchema).max(10), cancelledTaskIds: z.array(z.string().uuid()).max(100), controllerTime: z.string().datetime() });
export const CancelRemoteTaskRequestSchema = z.object({ reason: z.string().trim().min(1).max(240).default("administrator-request") }).strict();
export const RemoteTaskRecordSchema = RemoteTaskEnvelopeSchema.extend({
  status: RemoteTaskStatusSchema, updatedAt: z.string().datetime(), result: RemoteTaskResultSummarySchema.nullable(),
  errorCode: z.string().nullable(), retryable: z.boolean(), nextAttemptAt: z.string().datetime().nullable(),
});
export const RemoteTaskListResponseSchema = z.object({
  tasks: z.array(RemoteTaskRecordSchema),
  collectedAt: z.string().datetime().optional(),
});

export type RemoteTaskStatus = z.infer<typeof RemoteTaskStatusSchema>;
export type RemoteTaskEnvelope = z.infer<typeof RemoteTaskEnvelopeSchema>;
export type CreateRemoteTaskRequest = z.infer<typeof CreateRemoteTaskRequestSchema>;
export type RemoteTaskStatusUpdate = z.infer<typeof RemoteTaskStatusUpdateSchema>;
export type RemoteTaskResultSummary = z.infer<typeof RemoteTaskResultSummarySchema>;
export type RemoteTaskRecord = z.infer<typeof RemoteTaskRecordSchema>;
