import type { AgentCapability, AgentPlatform, RemoteTaskEnvelope, RemoteTaskProgressSample, RemoteTaskResultSummary } from "@stackpilot/contracts";
import {
  CertificateRenewalTaskParametersSchema, NetworkCacheFetchTaskParametersSchema, NetworkEgressProbeTaskParametersSchema, NetworkMeshConfigureTaskParametersSchema, NetworkMeshStatusTaskParametersSchema, ServiceStatusTaskParametersSchema, SiteLifecycleTaskParametersSchema,
  SiteLogQueryTaskParametersSchema, SitePlanActivateTaskParametersSchema, SitePlanPrepareTaskParametersSchema,
  SiteRollbackTaskParametersSchema, SystemSummaryTaskParametersSchema, TerminalCommandTaskParametersSchema,
} from "@stackpilot/contracts";
import { certificateRenewalHandler } from "./handlers/certificateRenewal.js";
import { cacheFetchHandler } from "./handlers/cacheFetch.js";
import { egressProbeHandler } from "./handlers/egressProbe.js";
import { meshConfigureHandler } from "./handlers/meshConfigure.js";
import { meshStatusHandler } from "./handlers/meshStatus.js";
import { serviceStatusHandler } from "./handlers/serviceStatus.js";
import { systemSummaryHandler } from "./handlers/systemSummary.js";
import { siteLifecycleHandler, siteLogsHandler, sitePlanActivateHandler, sitePlanPrepareHandler, siteRollbackHandler } from "./handlers/siteOperations.js";
import { terminalCommandHandler } from "./handlers/terminalCommand.js";

export type TaskRunContext = { reportProgress(progress: RemoteTaskProgressSample): void };
export type TaskDefinition = { capability: AgentCapability; platforms: readonly AgentPlatform[]; timeoutMs: number; maxOutputBytes: number; cancellable: boolean; retryable: boolean; validate(parameters: unknown): unknown; run(parameters: unknown, signal: AbortSignal, nodeId: string, capabilities: readonly AgentCapability[], context?: TaskRunContext): Promise<RemoteTaskResultSummary> };
const allPlatforms: readonly AgentPlatform[] = ["linux", "darwin", "win32"];
const taskDefinitions = {
  "system.summary.read": { capability: "system.summary.read", platforms: allPlatforms, timeoutMs: 6_000, maxOutputBytes: 16_384, cancellable: true, retryable: true, validate: (value) => SystemSummaryTaskParametersSchema.parse(value), run: (value) => systemSummaryHandler(value) },
  "service.status.read": { capability: "service.status.read", platforms: allPlatforms, timeoutMs: 6_000, maxOutputBytes: 16_384, cancellable: true, retryable: true, validate: (value) => ServiceStatusTaskParametersSchema.parse(value), run: serviceStatusHandler },
  "terminal.command.execute": { capability: "terminal.command.execute", platforms: ["linux"], timeoutMs: 10_000, maxOutputBytes: 1_024, cancellable: true, retryable: false, validate: (value) => TerminalCommandTaskParametersSchema.parse(value), run: (value, signal) => terminalCommandHandler(value, signal) },
  "sites.plan.prepare": { capability: "sites.deploy", platforms: ["linux"], timeoutMs: 1_800_000, maxOutputBytes: 16_384, cancellable: true, retryable: false, validate: (value) => SitePlanPrepareTaskParametersSchema.parse(value), run: (value, signal, nodeId, capabilities) => sitePlanPrepareHandler(value, signal, nodeId, capabilities.includes("runtime.install")) },
  "sites.plan.activate": { capability: "sites.deploy", platforms: ["linux"], timeoutMs: 600_000, maxOutputBytes: 16_384, cancellable: true, retryable: false, validate: (value) => SitePlanActivateTaskParametersSchema.parse(value), run: (value, signal, nodeId) => sitePlanActivateHandler(value, signal, nodeId) },
  "sites.rollback": { capability: "sites.deploy", platforms: ["linux"], timeoutMs: 120_000, maxOutputBytes: 16_384, cancellable: false, retryable: false, validate: (value) => SiteRollbackTaskParametersSchema.parse(value), run: (value, signal, nodeId) => siteRollbackHandler(value, signal, nodeId) },
  "sites.lifecycle.update": { capability: "sites.lifecycle.manage", platforms: ["linux"], timeoutMs: 120_000, maxOutputBytes: 16_384, cancellable: true, retryable: false, validate: (value) => SiteLifecycleTaskParametersSchema.parse(value), run: (value, signal, nodeId) => siteLifecycleHandler(value, signal, nodeId) },
  "sites.logs.read": { capability: "sites.logs.read", platforms: ["linux"], timeoutMs: 60_000, maxOutputBytes: 16_384, cancellable: true, retryable: false, validate: (value) => SiteLogQueryTaskParametersSchema.parse(value), run: (value, signal, nodeId) => siteLogsHandler(value, signal, nodeId) },
  "sites.certificates.renew": { capability: "sites.certificates.renew", platforms: ["linux"], timeoutMs: 600_000, maxOutputBytes: 16_384, cancellable: false, retryable: false, validate: (value) => CertificateRenewalTaskParametersSchema.parse(value), run: certificateRenewalHandler },
  "network.mesh.status.read": { capability: "network.mesh.read", platforms: ["linux"], timeoutMs: 10_000, maxOutputBytes: 16_384, cancellable: true, retryable: true, validate: (value) => NetworkMeshStatusTaskParametersSchema.parse(value), run: (value, signal) => meshStatusHandler(value, signal) },
  "network.mesh.configure": { capability: "network.mesh.configure", platforms: ["linux"], timeoutMs: 60_000, maxOutputBytes: 16_384, cancellable: false, retryable: false, validate: (value) => NetworkMeshConfigureTaskParametersSchema.parse(value), run: (value, signal) => meshConfigureHandler(value, signal) },
  "network.cache.fetch": { capability: "network.transfer", platforms: ["linux"], timeoutMs: 900_000, maxOutputBytes: 16_384, cancellable: true, retryable: false, validate: (value) => NetworkCacheFetchTaskParametersSchema.parse(value), run: (value, signal, _nodeId, _capabilities, context) => cacheFetchHandler(value, signal, context ? { onProgress: context.reportProgress } : {}) },
  "network.egress.probe": { capability: "network.transfer", platforms: ["linux"], timeoutMs: 60_000, maxOutputBytes: 16_384, cancellable: true, retryable: false, validate: (value) => NetworkEgressProbeTaskParametersSchema.parse(value), run: (value, signal) => egressProbeHandler(value, signal) },
} satisfies Record<RemoteTaskEnvelope["type"], TaskDefinition>;

export const taskRegistry: Readonly<Record<RemoteTaskEnvelope["type"], TaskDefinition>> = Object.freeze(taskDefinitions);
