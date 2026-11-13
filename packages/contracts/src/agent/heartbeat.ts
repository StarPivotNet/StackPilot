import { z } from "zod";
import { AgentHeartbeatDatabaseSnapshotSchema } from "../databases/index.js";
import { AgentSiteSnapshotSchema } from "../sites/index.js";
import { ProtocolVersionSchema } from "../versioning/index.js";
import { AgentCapabilitiesSchema, AgentPlatformSchema } from "./capabilities.js";
import { NetworkMeshHeartbeatSchema } from "./mesh.js";
import { NetworkCacheStatsSchema } from "./cache.js";
import { PhysicalHostIdSchema } from "./physicalIdentity.js";
import { AgentSystemdSnapshotSchema } from "../systemd/index.js";
import { AgentFirewallDenySnapshotSchema } from "../firewall/index.js";
const PercentSchema = z.number().finite().min(0).max(100);
const BytesSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const AGENT_TELEMETRY_MAX_CPU_CORES = 512;
export const AGENT_TELEMETRY_MAX_DISK_VOLUMES = 256;
export const AGENT_API_BODY_LIMIT_BYTES = 1024 * 1024;

export const AgentTelemetryCpuSchema = z.object({
  usagePercent: PercentSchema,
  coreUsagePercents: z.array(PercentSchema).min(1).max(AGENT_TELEMETRY_MAX_CPU_CORES),
}).strict();

export const AgentTelemetryMemorySchema = z.object({
  totalBytes: BytesSchema.positive(),
  availableBytes: BytesSchema,
}).strict().refine((value) => value.availableBytes <= value.totalBytes, {
  message: "availableBytes must not exceed totalBytes",
  path: ["availableBytes"],
});

export const AgentTelemetryDiskVolumeSchema = z.object({
  label: z.string().min(1).max(120),
  mount: z.string().min(1).max(512),
  totalBytes: BytesSchema.positive(),
  usedBytes: BytesSchema,
}).strict().refine((value) => value.usedBytes <= value.totalBytes, {
  message: "usedBytes must not exceed totalBytes",
  path: ["usedBytes"],
});

export const AgentTelemetrySnapshotSchema = z.object({
  collectedAt: z.string().datetime(),
  hostname: z.string().min(1).max(120),
  primaryIp: z.union([z.ipv4(), z.ipv6()]).nullable(),
  cpu: AgentTelemetryCpuSchema.nullable(),
  memory: AgentTelemetryMemorySchema.nullable(),
  loadAverage: z.tuple([
    z.number().finite().nonnegative(),
    z.number().finite().nonnegative(),
    z.number().finite().nonnegative(),
  ]).nullable(),
  disks: z.array(AgentTelemetryDiskVolumeSchema).max(AGENT_TELEMETRY_MAX_DISK_VOLUMES),
  uptimeSeconds: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict().superRefine((value, context) => {
  const totalBytes = value.disks.reduce((sum, disk) => sum + disk.totalBytes, 0);
  const usedBytes = value.disks.reduce((sum, disk) => sum + disk.usedBytes, 0);
  if (!Number.isSafeInteger(totalBytes)) context.addIssue({ code: "custom", message: "aggregate disk totalBytes must be a safe integer", path: ["disks"] });
  if (!Number.isSafeInteger(usedBytes)) context.addIssue({ code: "custom", message: "aggregate disk usedBytes must be a safe integer", path: ["disks"] });
});

export const AgentHealthSchema = z.object({
  status: z.enum(["healthy", "degraded"]),
  uptimeSeconds: z.number().int().nonnegative(),
}).strict();

export const AgentHeartbeatSchema = z.object({
  nodeId: z.string().uuid(),
  agentVersion: z.string().min(1).max(40),
  protocolVersion: ProtocolVersionSchema,
  timestamp: z.string().datetime(),
  platform: AgentPlatformSchema,
  physicalHostId: PhysicalHostIdSchema.optional(),
  capabilities: AgentCapabilitiesSchema,
  health: AgentHealthSchema,
  telemetry: AgentTelemetrySnapshotSchema.optional(),
  siteSnapshot: AgentSiteSnapshotSchema.optional(),
  databaseSnapshot: AgentHeartbeatDatabaseSnapshotSchema.optional(),
  systemdSnapshot: AgentSystemdSnapshotSchema.optional(),
  firewallDenySnapshot: AgentFirewallDenySnapshotSchema.optional(),
  mesh: NetworkMeshHeartbeatSchema.optional(),
  cache: NetworkCacheStatsSchema.optional(),
}).strict();

export const AgentHeartbeatResponseSchema = z.object({
  acceptedAt: z.string().datetime(),
  nextHeartbeatSeconds: z.number().int().positive(),
}).strict();

export type AgentHeartbeat = z.infer<typeof AgentHeartbeatSchema>;
export type AgentTelemetrySnapshot = z.infer<typeof AgentTelemetrySnapshotSchema>;
export type AgentTelemetryDiskVolume = z.infer<typeof AgentTelemetryDiskVolumeSchema>;
