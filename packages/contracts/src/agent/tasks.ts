import { z } from "zod";
import { AgentCapabilitySchema } from "./capabilities.js";
import { NetworkMeshApplyDataSchema, NetworkMeshConfigurationSchema, NetworkMeshStatusDataSchema } from "./mesh.js";
import { NETWORK_SEGMENT_MAX_SOURCES, NetworkCacheFetchResultSchema, NetworkCacheFetchTaskParametersSchema } from "./cache.js";
import { NetworkEgressProbeResultSchema, NetworkEgressProbeTaskParametersSchema } from "./egress.js";
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
// Mesh status reads are parameterless: no paths, commands or free-form selectors.
export const NetworkMeshStatusTaskParametersSchema = z.object({}).strict();
export const NetworkMeshStatusTaskResultSchema = NetworkMeshStatusDataSchema;
// Mesh configuration is the Controller-owned peer list plus the local overlay address; no paths or commands.
export const NetworkMeshConfigureTaskParametersSchema = z.object({
  revision: z.number().int().min(1).max(2_147_483_647),
  configuration: NetworkMeshConfigurationSchema,
}).strict().superRefine((value, context) => {
  if (value.revision !== value.configuration.sourceRevision) context.addIssue({ code: "custom", message: "revision must match configuration.sourceRevision", path: ["revision"] });
});
export const NetworkMeshConfigureTaskResultSchema = NetworkMeshApplyDataSchema;
// A cache fill carries one origin URL and an optional expected digest; the bytes never ride the task channel.
export const NetworkCacheFetchTaskResultSchema = NetworkCacheFetchResultSchema;
// An egress probe reports its own measured path to each source; nothing is written to the cache.
export const NetworkEgressProbeTaskResultSchema = NetworkEgressProbeResultSchema;
export const RemoteTaskTypeSchema = z.enum([
  "system.summary.read", "service.status.read", "terminal.command.execute", "sites.plan.prepare", "sites.plan.activate",
  "sites.rollback", "sites.lifecycle.update", "sites.logs.read", "sites.certificates.renew", "network.mesh.status.read",
  "network.mesh.configure", "network.cache.fetch", "network.egress.probe",
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
  z.object({ type: z.literal("network.mesh.status.read"), parameters: NetworkMeshStatusTaskParametersSchema, expiresInSeconds: z.number().int().min(5).max(120).default(30), idempotencyKey: z.string().min(8).max(160) }).strict(),
  z.object({ type: z.literal("network.mesh.configure"), parameters: NetworkMeshConfigureTaskParametersSchema, expiresInSeconds: z.number().int().min(30).max(900).default(120), idempotencyKey: z.string().min(8).max(160) }).strict(),
  z.object({ type: z.literal("network.cache.fetch"), parameters: NetworkCacheFetchTaskParametersSchema, expiresInSeconds: z.number().int().min(30).max(900).default(900), idempotencyKey: z.string().min(8).max(160) }).strict(),
  z.object({ type: z.literal("network.egress.probe"), parameters: NetworkEgressProbeTaskParametersSchema, expiresInSeconds: z.number().int().min(30).max(300).default(120), idempotencyKey: z.string().min(8).max(160) }).strict(),
]);
export const RemoteTaskEnvelopeSchema = z.object({
  protocolVersion: ProtocolVersionSchema, taskId: z.string().uuid(), type: RemoteTaskTypeSchema, targetNodeId: z.string().uuid(),
  parameters: z.record(z.string(), z.unknown()), createdAt: z.string().datetime(), expiresAt: z.string().datetime(),
  idempotencyKey: z.string().min(8).max(160), requester: z.string().min(1).max(160), traceId: z.string().uuid(),
  requiredCapability: AgentCapabilitySchema, attempt: z.number().int().min(0).max(3), maxAttempts: z.number().int().min(1).max(3),
}).strict();
export const RemoteTaskResultSummarySchema = z.object({ message: z.string().max(1024), data: z.record(z.string(), z.unknown()).optional(), truncated: z.boolean().default(false) }).strict();
// A running task may publish counters; the rate is the Controller's own derivation from two samples.
export const RemoteTaskPartProgressSampleSchema = z.object({
  index: z.number().int().min(0).max(NETWORK_SEGMENT_MAX_SOURCES + 1),
  sourceNodeId: z.string().uuid(),
  bytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  totalBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict();
export const RemoteTaskProgressSampleSchema = z.object({
  bytesReceived: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  totalBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
  partsDone: z.number().int().nonnegative().max(NETWORK_SEGMENT_MAX_SOURCES),
  partsTotal: z.number().int().nonnegative().max(NETWORK_SEGMENT_MAX_SOURCES),
  // Absent on a direct fill, and on an Agent that predates per-part counters.
  parts: z.array(RemoteTaskPartProgressSampleSchema).max(NETWORK_SEGMENT_MAX_SOURCES + 1).optional(),
}).strict();
export const RemoteTaskProgressSchema = RemoteTaskProgressSampleSchema.extend({
  bytesPerSecond: z.number().nonnegative().max(1e12).nullable(),
  // Each part carries the rate the Controller derived for it, never one the Agent measured itself.
  parts: z.array(RemoteTaskPartProgressSampleSchema.extend({
    bytesPerSecond: z.number().nonnegative().max(1e12).nullable(),
  })).max(NETWORK_SEGMENT_MAX_SOURCES + 1).optional(),
  updatedAt: z.string().datetime(),
}).strict();
export const RemoteTaskStatusUpdateSchema = z.object({
  taskId: z.string().uuid(), attempt: z.number().int().min(1).max(3), status: z.enum(["running", "succeeded", "failed", "cancelled"]), timestamp: z.string().datetime(),
  result: RemoteTaskResultSummarySchema.optional(), errorCode: z.string().max(80).optional(),
  progress: RemoteTaskProgressSampleSchema.optional(),
}).strict();
export const RemoteTaskPollResponseSchema = z.object({ tasks: z.array(RemoteTaskEnvelopeSchema).max(10), cancelledTaskIds: z.array(z.string().uuid()).max(100), controllerTime: z.string().datetime() });
export const CancelRemoteTaskRequestSchema = z.object({ reason: z.string().trim().min(1).max(240).default("administrator-request") }).strict();
export const RemoteTaskRecordSchema = RemoteTaskEnvelopeSchema.extend({
  status: RemoteTaskStatusSchema, updatedAt: z.string().datetime(), result: RemoteTaskResultSummarySchema.nullable(),
  errorCode: z.string().nullable(), retryable: z.boolean(), nextAttemptAt: z.string().datetime().nullable(),
  progress: RemoteTaskProgressSchema.nullable().optional(),
});
export const RemoteTaskListResponseSchema = z.object({
  tasks: z.array(RemoteTaskRecordSchema),
  collectedAt: z.string().datetime().optional(),
});

export type RemoteTaskStatus = z.infer<typeof RemoteTaskStatusSchema>;
export type RemoteTaskEnvelope = z.infer<typeof RemoteTaskEnvelopeSchema>;
export type CreateRemoteTaskRequest = z.infer<typeof CreateRemoteTaskRequestSchema>;
export type NetworkMeshConfigureTaskParameters = z.infer<typeof NetworkMeshConfigureTaskParametersSchema>;
export type RemoteTaskStatusUpdate = z.infer<typeof RemoteTaskStatusUpdateSchema>;
export type RemoteTaskResultSummary = z.infer<typeof RemoteTaskResultSummarySchema>;
export type RemoteTaskProgressSample = z.infer<typeof RemoteTaskProgressSampleSchema>;
export type RemoteTaskPartProgressSample = z.infer<typeof RemoteTaskPartProgressSampleSchema>;
export type RemoteTaskProgress = z.infer<typeof RemoteTaskProgressSchema>;
export type RemoteTaskRecord = z.infer<typeof RemoteTaskRecordSchema>;
