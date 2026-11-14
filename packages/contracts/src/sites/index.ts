import { z } from "zod";
import { AgentCapabilitySchema } from "../agent/capabilities.js";

const OpaqueIdSchema = z.string().min(8).max(160).regex(/^[A-Za-z0-9:_-]+$/);
const nullableDateTime = z.string().datetime().nullable();
const IdempotencyKeySchema = z.string().min(8).max(160).regex(/^[A-Za-z0-9:_-]+$/);
const DomainNameSchema = z.string().trim().min(1).max(253).toLowerCase().superRefine((value, context) => {
  if (value.startsWith("*.") || !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(value)) {
    context.addIssue({ code: "custom", message: "must be a non-wildcard DNS name" });
  }
});

const PublicGithubRepositorySchema = z.url().max(512).superRefine((value, context) => {
  try {
    const url = new URL(value);
    const pathValid = /^\/[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}(?:\.git)?$/.test(url.pathname);
    if (url.protocol !== "https:" || url.hostname !== "github.com" || url.port || url.username || url.password || url.search || url.hash || !pathValid) {
      context.addIssue({ code: "custom", message: "must be a public github.com HTTPS repository URL" });
    }
  } catch {
    context.addIssue({ code: "custom", message: "must be a valid repository URL" });
  }
});

export const SiteRuntimeStatusSchema = z.enum(["running", "warning", "stopped", "unknown"]);
export const SiteCollectionStatusSchema = z.enum(["complete", "partial", "unavailable"]);
export const SiteFreshnessSchema = z.enum(["current", "stale", "awaiting"]);
export const CertificateStatusSchema = z.enum(["valid", "expiring", "critical", "expired", "unavailable"]);
export const CertificateRenewalModeSchema = z.enum(["automatic", "manual", "unsupported"]);
export const CertificateRenewalStatusSchema = z.enum(["idle", "queued", "running", "succeeded", "failed", "cancelled", "expired"]);
export const SiteManageabilitySchema = z.enum(["monitored", "managed", "unmanageable"]);
export const SiteDesiredStateSchema = z.enum(["running", "stopped", "deleted"]);

export const SiteCertificateSchema = z.object({
  status: CertificateStatusSchema,
  notBefore: nullableDateTime,
  expiresAt: nullableDateTime,
  issuer: z.string().min(1).max(253).nullable(),
  subjectAlternativeNames: z.array(z.string().min(1).max(253)).max(100),
  fingerprintSha256: z.string().regex(/^[A-F0-9]{64}$/).nullable(),
  renewalMode: CertificateRenewalModeSchema,
  renewable: z.boolean(),
  unavailableReason: z.string().min(1).max(256).nullable(),
  certificateId: OpaqueIdSchema.nullable(),
}).strict().superRefine((value, context) => {
  if (value.renewable && !value.certificateId) context.addIssue({ code: "custom", path: ["certificateId"], message: "renewable certificates require certificateId" });
  if (value.status !== "unavailable" && !value.expiresAt) context.addIssue({ code: "custom", path: ["expiresAt"], message: "available certificates require expiresAt" });
});

export const CertificateHelperStatusDataSchema = z.object({
  certificates: z.array(z.object({
    sourceId: OpaqueIdSchema,
    certificate: SiteCertificateSchema,
  }).strict()).max(200),
}).strict();

export const AgentSiteSnapshotRecordSchema = z.object({
  id: OpaqueIdSchema,
  domain: z.string().min(1).max(253),
  status: SiteRuntimeStatusSchema,
  runtime: z.string().min(1).max(128),
  host: z.string().min(1).max(253),
  upstream: z.string().max(512).nullable(),
  source: z.string().min(1).max(128),
  latencyMs: z.number().int().nonnegative().nullable(),
  trafficBytes: z.number().int().nonnegative().safe().nullable(),
  certificate: SiteCertificateSchema,
  errorRatePercent: z.number().min(0).max(100).nullable().default(null),
  lastDeployAt: nullableDateTime.default(null),
  manageability: SiteManageabilitySchema.default("monitored"),
  managementReason: z.string().min(1).max(256).nullable().default(null),
  protected: z.boolean().default(false),
  version: z.number().int().positive().default(1),
  desiredState: SiteDesiredStateSchema.nullable().default(null),
}).strict();

export const AgentSiteSnapshotSchema = z.object({
  collectedAt: z.string().datetime(),
  collectionStatus: SiteCollectionStatusSchema,
  warnings: z.array(z.string().min(1).max(256)).max(20),
  sites: z.array(AgentSiteSnapshotRecordSchema).max(2_000),
}).strict().superRefine((value, context) => {
  const ids = new Set<string>();
  value.sites.forEach((site, index) => {
    if (ids.has(site.id)) context.addIssue({ code: "custom", path: ["sites", index, "id"], message: "site ids must be unique" });
    ids.add(site.id);
  });
});

export const SiteRenewalStateSchema = z.object({
  batchId: z.string().uuid().nullable(),
  taskId: z.string().uuid().nullable(),
  status: CertificateRenewalStatusSchema,
  message: z.string().max(512).nullable(),
  updatedAt: nullableDateTime,
}).strict();

export const SiteRuntimeRecordSchema = AgentSiteSnapshotRecordSchema.extend({
  nodeId: z.string().min(1).max(160),
  collectedAt: z.string().datetime(),
  freshness: SiteFreshnessSchema,
  renewal: SiteRenewalStateSchema,
}).strict();

export const SiteRuntimePayloadSchema = z.object({
  collectedAt: z.string().datetime(),
  collectionStatus: SiteCollectionStatusSchema,
  warnings: z.array(z.string().min(1).max(256)).max(20),
  sites: z.array(SiteRuntimeRecordSchema).max(10_000),
}).strict();

export const CreateCertificateRenewalRequestSchema = z.object({
  siteIds: z.array(OpaqueIdSchema).min(1).max(100),
  idempotencyKey: IdempotencyKeySchema,
}).strict().superRefine((value, context) => {
  if (new Set(value.siteIds).size !== value.siteIds.length) context.addIssue({ code: "custom", path: ["siteIds"], message: "siteIds must be unique" });
});

export const CertificateRenewalBatchStatusSchema = z.enum(["queued", "running", "partially_succeeded", "succeeded", "failed", "cancelled", "expired"]);
export const CertificateRenewalOperationSchema = z.object({
  siteIds: z.array(OpaqueIdSchema).min(1).max(100),
  nodeId: z.string().min(1).max(160),
  certificateId: OpaqueIdSchema,
  taskId: z.string().uuid(),
  status: CertificateRenewalStatusSchema.exclude(["idle"]),
  message: z.string().max(512).nullable(),
  updatedAt: z.string().datetime(),
}).strict();
export const CertificateRenewalBatchSchema = z.object({
  batchId: z.string().uuid(),
  status: CertificateRenewalBatchStatusSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  operations: z.array(CertificateRenewalOperationSchema).min(1).max(100),
}).strict();

export const CertificateRenewalTaskParametersSchema = z.object({
  batchId: z.string().uuid(),
  certificates: z.array(z.object({
    certificateId: OpaqueIdSchema,
    siteIds: z.array(OpaqueIdSchema).min(1).max(100),
  }).strict()).min(1).max(20),
}).strict().superRefine((value, context) => {
  const ids = value.certificates.map((certificate) => certificate.certificateId);
  if (new Set(ids).size !== ids.length) context.addIssue({ code: "custom", path: ["certificates"], message: "certificate ids must be unique" });
});

export const UpdateNodeCapabilitiesRequestSchema = z.object({
  allowedCapabilities: z.array(AgentCapabilitySchema).max(20),
}).strict().superRefine((value, context) => {
  if (new Set(value.allowedCapabilities).size !== value.allowedCapabilities.length) context.addIssue({ code: "custom", path: ["allowedCapabilities"], message: "capabilities must be unique" });
});

export const SitePlanStatusSchema = z.enum(["queued", "preparing", "ready", "activating", "activated", "failed", "expired"]);
export const SiteOperationTypeSchema = z.enum(["prepare", "activate", "rollback", "lifecycle", "certificate_renewal", "log_query"]);
export const SiteOperationStatusSchema = z.enum(["queued", "running", "succeeded", "failed", "cancelled"]);
export const SiteLifecycleActionSchema = z.enum(["running", "stopped", "deleted", "restored"]);
export const SitePlanRuntimeSchema = z.enum(["static", "node20", "node22"]);
export const SiteDeploymentEnvironmentSchema = z.enum(["production", "staging"]);
export const CertificateEnvironmentSchema = z.enum(["staging", "production"]);
const RelativeSitePathSchema = z.string().min(1).max(256).refine((value) => !value.startsWith("/") && !value.split("/").includes("..") && !value.includes("\\"), "must be a safe relative path");

export const SiteDeploymentManifestSchema = z.object({
  schemaVersion: z.literal(1),
  runtime: SitePlanRuntimeSchema,
  workingDirectory: RelativeSitePathSchema.default("."),
  buildScript: z.string().min(1).max(80).regex(/^[A-Za-z0-9:_-]+$/).nullable().default(null),
  outputDirectory: RelativeSitePathSchema.nullable().default(null),
  startScript: z.string().min(1).max(80).regex(/^[A-Za-z0-9:_-]+$/).nullable().default(null),
  healthCheckPath: z.string().min(1).max(256).regex(/^\/(?!\/)[^?#]*$/).nullable().default(null),
}).strict().superRefine((value, context) => {
  if (value.runtime === "static" && !value.outputDirectory) context.addIssue({ code: "custom", path: ["outputDirectory"], message: "static runtime requires outputDirectory" });
  if (value.runtime !== "static" && !value.startScript) context.addIssue({ code: "custom", path: ["startScript"], message: "node runtime requires startScript" });
});

export const SiteEnvironmentVariableInputSchema = z.object({
  name: z.string().min(1).max(128).regex(/^[A-Z_][A-Z0-9_]*$/),
  value: z.string().max(8_192).refine((value) => !/[\0\r\n]/.test(value), "must not contain NUL or line breaks"),
}).strict();

export const CreateSitePlanRequestSchema = z.object({
  nodeId: OpaqueIdSchema,
  deploymentEnvironment: SiteDeploymentEnvironmentSchema.default("production"),
  domains: z.array(DomainNameSchema).min(1).max(20),
  repositoryUrl: PublicGithubRepositorySchema,
  repositoryRef: z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/).default("main"),
  certificateEmail: z.email().max(254),
  certificateEnvironment: CertificateEnvironmentSchema.default("production"),
  environmentVariables: z.array(SiteEnvironmentVariableInputSchema).max(100).default([]),
  idempotencyKey: IdempotencyKeySchema,
}).strict().superRefine((value, context) => {
  if (new Set(value.domains).size !== value.domains.length) context.addIssue({ code: "custom", path: ["domains"], message: "domains must be unique" });
  const names = value.environmentVariables.map((entry) => entry.name);
  if (new Set(names).size !== names.length) context.addIssue({ code: "custom", path: ["environmentVariables"], message: "environment variable names must be unique" });
  if (value.repositoryRef.includes("..") || value.repositoryRef.includes("//") || value.repositoryRef.endsWith("/")) {
    context.addIssue({ code: "custom", path: ["repositoryRef"], message: "repository ref is unsafe" });
  }
});

export const SitePlanPreviewSchema = z.object({
  runtime: SitePlanRuntimeSchema,
  healthCheckPath: z.string().min(1).max(256).regex(/^\/(?!\/)[^?#]*$/).nullable(),
  changes: z.array(z.enum(["repository", "runtime", "nginx", "certificate", "environment", "traffic_switch"])).min(1).max(6),
}).strict();

export const SitePlanSchema = z.object({
  planId: z.string().uuid(),
  nodeId: OpaqueIdSchema,
  deploymentEnvironment: SiteDeploymentEnvironmentSchema,
  domains: z.array(DomainNameSchema).min(1).max(20),
  repositoryUrl: PublicGithubRepositorySchema,
  repositoryRef: z.string().min(1).max(160),
  certificateEnvironment: CertificateEnvironmentSchema,
  environmentVariableNames: z.array(z.string().regex(/^[A-Z_][A-Z0-9_]*$/)).max(100),
  operator: z.string().min(1).max(160).nullable().default(null),
  status: SitePlanStatusSchema,
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  version: z.number().int().positive(),
  preview: SitePlanPreviewSchema.nullable(),
  operationId: z.string().uuid(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
}).strict();

export const ActivateSitePlanRequestSchema = z.object({
  planVersion: z.number().int().positive(),
  planDigest: z.string().regex(/^[a-f0-9]{64}$/),
  idempotencyKey: IdempotencyKeySchema,
}).strict();

export const UpdateSiteLifecycleRequestSchema = z.object({
  action: SiteLifecycleActionSchema,
  version: z.number().int().positive(),
  idempotencyKey: IdempotencyKeySchema,
}).strict();

export const CreateSiteCertificateRenewalRequestSchema = z.object({
  version: z.number().int().positive(),
  idempotencyKey: IdempotencyKeySchema,
}).strict();

export const CreateSiteLogQueryRequestSchema = z.object({
  version: z.number().int().positive(),
  since: nullableDateTime.default(null),
  limit: z.number().int().min(1).max(200).default(100),
  idempotencyKey: IdempotencyKeySchema,
}).strict();

export const CreateSiteRollbackRequestSchema = z.object({
  targetReleaseId: OpaqueIdSchema,
  expectedSiteVersion: z.number().int().positive(),
  reason: z.string().trim().min(1).max(240),
  idempotencyKey: IdempotencyKeySchema,
}).strict();

export const SiteRollbackStatusSchema = z.enum(["available", "queued", "running", "succeeded", "failed", "cancelled"]);
export const SiteRollbackRecordSchema = z.object({
  id: OpaqueIdSchema, siteId: OpaqueIdSchema, nodeId: OpaqueIdSchema, domain: DomainNameSchema,
  currentReleaseId: OpaqueIdSchema, targetReleaseId: OpaqueIdSchema,
  targetPlanId: z.string().uuid(), repositoryRef: z.string().min(1).max(160), status: SiteRollbackStatusSchema,
  requestedBy: z.string().min(1).max(160).nullable(), reason: z.string().min(1).max(240).nullable(),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
  progressPercent: z.number().int().min(0).max(100), errorCode: z.string().min(1).max(80).nullable(),
  siteVersion: z.number().int().positive(),
}).strict();
export const SiteRollbackPayloadSchema = z.object({
  collectedAt: z.string().datetime(), rollbacks: z.array(SiteRollbackRecordSchema).max(10_000),
}).strict();

export const SiteAccessLogRecordSchema = z.object({
  timestamp: z.string().datetime(),
  method: z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]),
  path: z.string().min(1).max(2_048).refine((path) => path.startsWith("/") && !path.includes("?"), "path must not include a query string"),
  status: z.number().int().min(100).max(599),
  bytesSent: z.number().int().nonnegative().safe(),
  clientAddressMasked: z.string().min(1).max(64),
}).strict();

export const SiteOperationResultSchema = z.object({
  message: z.string().max(512).nullable(),
  siteId: OpaqueIdSchema.nullable(),
  releaseId: OpaqueIdSchema.nullable(),
  stagingId: OpaqueIdSchema.nullable().default(null),
  desiredState: SiteDesiredStateSchema.nullable().default(null),
  siteVersion: z.number().int().positive().nullable().default(null),
  certificateRenewalBatchId: z.string().uuid().nullable(),
  planPreview: SitePlanPreviewSchema.nullable(),
  logs: z.array(SiteAccessLogRecordSchema).max(200),
}).strict();

export const SitePlanPrepareTaskParametersSchema = z.object({
  operationId: z.string().uuid(), planId: z.string().uuid(),
  domains: z.array(DomainNameSchema).min(1).max(20), repositoryUrl: PublicGithubRepositorySchema,
  repositoryRef: z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/),
  certificateContact: z.email().max(254), certificateEnvironment: CertificateEnvironmentSchema,
  environmentVariables: z.array(SiteEnvironmentVariableInputSchema).max(100),
  expectedPlanDigest: z.string().regex(/^[a-f0-9]{64}$/),
  runtimeInstallAuthorized: z.boolean().default(false),
}).strict();

export const SitePlanActivateTaskParametersSchema = z.object({
  operationId: z.string().uuid(), planId: z.string().uuid(), stagingId: OpaqueIdSchema,
  expectedPlanDigest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export const SiteLifecycleTaskParametersSchema = z.object({
  operationId: z.string().uuid(), siteId: OpaqueIdSchema, action: SiteLifecycleActionSchema,
  expectedVersion: z.number().int().positive(),
}).strict();

export const SiteLogQueryTaskParametersSchema = z.object({
  operationId: z.string().uuid(), siteId: OpaqueIdSchema, since: nullableDateTime,
  limit: z.number().int().min(1).max(200),
}).strict();

export const SiteRollbackTaskParametersSchema = z.object({
  operationId: z.string().uuid(), siteId: OpaqueIdSchema, targetPlanId: z.string().uuid(), targetReleaseId: OpaqueIdSchema,
  expectedVersion: z.number().int().positive(),
}).strict();

export const SitePlanPrepareTaskResultSchema = z.object({
  operationId: z.string().uuid(), stagingId: OpaqueIdSchema, planPreview: SitePlanPreviewSchema,
}).strict();
export const SitePlanActivateTaskResultSchema = z.object({
  operationId: z.string().uuid(), siteId: OpaqueIdSchema, releaseId: OpaqueIdSchema,
}).strict();
export const SiteLifecycleTaskResultSchema = z.object({
  operationId: z.string().uuid(), siteId: OpaqueIdSchema, desiredState: SiteDesiredStateSchema,
}).strict();
export const SiteLogQueryTaskResultSchema = z.object({
  operationId: z.string().uuid(), siteId: OpaqueIdSchema,
  logs: z.array(SiteAccessLogRecordSchema).max(200),
}).strict();
export const SiteRollbackTaskResultSchema = z.object({
  operationId: z.string().uuid(), siteId: OpaqueIdSchema, releaseId: OpaqueIdSchema,
  version: z.number().int().positive(),
}).strict();

export const SiteOperationRollbackMetadataSchema = z.object({
  fromReleaseId: OpaqueIdSchema, targetReleaseId: OpaqueIdSchema,
  reason: z.string().min(1).max(240), requestedBy: z.string().min(1).max(160),
}).strict();

export const SiteOperationSchema = z.object({
  operationId: z.string().uuid(),
  taskId: z.string().uuid().nullable().default(null),
  type: SiteOperationTypeSchema,
  nodeId: OpaqueIdSchema,
  siteId: OpaqueIdSchema.nullable(),
  planId: z.string().uuid().nullable(),
  rollback: SiteOperationRollbackMetadataSchema.nullable().default(null),
  status: SiteOperationStatusSchema,
  stage: z.string().min(1).max(80),
  progressPercent: z.number().int().min(0).max(100),
  result: SiteOperationResultSchema.nullable(),
  errorCode: z.string().min(1).max(80).nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();

export type SiteRuntimeStatus = z.infer<typeof SiteRuntimeStatusSchema>;
export type SiteCertificate = z.infer<typeof SiteCertificateSchema>;
export type CertificateHelperStatusData = z.infer<typeof CertificateHelperStatusDataSchema>;
export type AgentSiteSnapshotRecord = z.infer<typeof AgentSiteSnapshotRecordSchema>;
export type AgentSiteSnapshot = z.infer<typeof AgentSiteSnapshotSchema>;
export type SiteRuntimeRecord = z.infer<typeof SiteRuntimeRecordSchema>;
export type SiteRuntimePayload = z.infer<typeof SiteRuntimePayloadSchema>;
export type CreateCertificateRenewalRequest = z.infer<typeof CreateCertificateRenewalRequestSchema>;
export type CertificateRenewalBatch = z.infer<typeof CertificateRenewalBatchSchema>;
export type CertificateRenewalTaskParameters = z.infer<typeof CertificateRenewalTaskParametersSchema>;
export type SiteDesiredState = z.infer<typeof SiteDesiredStateSchema>;
export type CreateSitePlanRequest = z.infer<typeof CreateSitePlanRequestSchema>;
export type SitePlan = z.infer<typeof SitePlanSchema>;
export type SitePlanPreview = z.infer<typeof SitePlanPreviewSchema>;
export type SiteDeploymentManifest = z.infer<typeof SiteDeploymentManifestSchema>;
export type SiteDeploymentEnvironment = z.infer<typeof SiteDeploymentEnvironmentSchema>;
export type CertificateEnvironment = z.infer<typeof CertificateEnvironmentSchema>;
export type ActivateSitePlanRequest = z.infer<typeof ActivateSitePlanRequestSchema>;
export type UpdateSiteLifecycleRequest = z.infer<typeof UpdateSiteLifecycleRequestSchema>;
export type CreateSiteCertificateRenewalRequest = z.infer<typeof CreateSiteCertificateRenewalRequestSchema>;
export type CreateSiteLogQueryRequest = z.infer<typeof CreateSiteLogQueryRequestSchema>;
export type CreateSiteRollbackRequest = z.infer<typeof CreateSiteRollbackRequestSchema>;
export type SiteRollbackRecord = z.infer<typeof SiteRollbackRecordSchema>;
export type SiteRollbackPayload = z.infer<typeof SiteRollbackPayloadSchema>;
export type SiteOperation = z.infer<typeof SiteOperationSchema>;
export type SiteOperationResult = z.infer<typeof SiteOperationResultSchema>;
export type SitePlanPrepareTaskParameters = z.infer<typeof SitePlanPrepareTaskParametersSchema>;
export type SitePlanActivateTaskParameters = z.infer<typeof SitePlanActivateTaskParametersSchema>;
export type SiteLifecycleTaskParameters = z.infer<typeof SiteLifecycleTaskParametersSchema>;
export type SiteLogQueryTaskParameters = z.infer<typeof SiteLogQueryTaskParametersSchema>;
export type SiteRollbackTaskParameters = z.infer<typeof SiteRollbackTaskParametersSchema>;
export type SiteRollbackTaskResult = z.infer<typeof SiteRollbackTaskResultSchema>;
