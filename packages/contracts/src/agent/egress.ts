import { z } from "zod";
import { NETWORK_CACHE_MAX_FETCH_BYTES, NETWORK_SEGMENT_MAX_SOURCES, NetworkCacheDigestSchema, NetworkCacheSegmentSourceSchema } from "./cache.js";

/** The helper opens exactly this port on the overlay; the proxy binds it and nothing else. */
export const MESH_DATA_PLANE_PORT = 18080;
export const MESH_DATA_PLANE_FETCH_PATH = "/v1/fetch";
/** Byte ranges for a segmented download: streamed from the origin and never stored on the peer. */
export const MESH_DATA_PLANE_RANGE_PATH = "/v1/range";
export const MESH_DATA_PLANE_HEALTH_PATH = "/healthz";

/** A probe every ten minutes keeps a fifteen-minute sample fresh through one missed round. */
export const EGRESS_PROBE_INTERVAL_MS = 10 * 60 * 1000;
export const EGRESS_SAMPLE_STALE_SECONDS = 15 * 60;
/** The probe reads a prefix of the object: enough to measure, small enough to stay off the cache. */
export const EGRESS_PROBE_MAX_BYTES = 256 * 1024;
export const EGRESS_PROBE_TIMEOUT_MS = 10_000;
export const EGRESS_PROBE_MAX_TARGETS = 6;

const OriginUrlSchema = z.string().min(1).max(2048).refine((value) => {
  try { return new URL(value).protocol === "https:"; } catch { return false; }
}, "url must be an https:// origin");

const BytesPerSecondSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

/** `network.egress.probe`: the Controller names sources, the node measures its own path to them. */
export const NetworkEgressProbeTargetSchema = z.object({ url: OriginUrlSchema }).strict();
export const NetworkEgressProbeTaskParametersSchema = z.object({
  targets: z.array(NetworkEgressProbeTargetSchema).min(1).max(EGRESS_PROBE_MAX_TARGETS),
}).strict();

export const NetworkEgressProbeSampleSchema = z.object({
  url: z.string().min(1).max(2048),
  host: z.string().min(1).max(253),
  ok: z.boolean(),
  statusCode: z.number().int().min(100).max(599).nullable(),
  // Time to first byte stands in for RTT: it is the number the caller actually pays before bytes flow.
  ttfbMs: z.number().int().min(0).max(600_000).nullable(),
  bytesPerSecond: BytesPerSecondSchema.nullable(),
  errorCode: z.string().min(1).max(64).nullable(),
}).strict();

export const NetworkEgressProbeResultSchema = z.object({
  collectedAt: z.string().datetime(),
  samples: z.array(NetworkEgressProbeSampleSchema).max(EGRESS_PROBE_MAX_TARGETS),
}).strict();

export const NetworkEgressSampleViewSchema = z.object({
  host: z.string().min(1).max(253),
  ttfbMs: z.number().int().min(0).max(600_000),
  bytesPerSecond: BytesPerSecondSchema,
  collectedAt: z.string().datetime(),
  ageSeconds: z.number().int().min(0).max(31_536_000),
}).strict();

/** The four ways a node drops out of routing: each needs a different fix, so one label would hide the action. */
export const NetworkEgressDisabledReasonSchema = z.enum(["revoked", "no-overlay", "not-allowed", "not-declared"]);

export const NetworkEgressNodeSchema = z.object({
  nodeId: z.string().uuid(),
  nodeName: z.string().min(1).max(120),
  // `offline` is a live-process fact, not a sample fact: selection skips such a node even when its samples are fresh.
  status: z.enum(["ready", "stale", "pending", "disabled", "offline"]),
  // Set only with `disabled`: which piece is missing, so the operator knows whether to grant, declare or re-enrol.
  disabledReason: NetworkEgressDisabledReasonSchema.nullable(),
  overlayAddress: z.string().max(15).nullable(),
  dataPlanePort: z.number().int().min(1).max(65_535).nullable(),
  samples: z.array(NetworkEgressSampleViewSchema).max(EGRESS_PROBE_MAX_TARGETS),
}).strict();

export const NetworkEgressPlanResponseSchema = z.object({
  updatedAt: z.string().datetime(),
  nodes: z.array(NetworkEgressNodeSchema).max(512),
  warnings: z.array(z.string().min(1).max(240)).max(20),
}).strict();

/** Why a host has no egress: the panel and the audit both need the same vocabulary. */
export const NetworkEgressSelectionReasonSchema = z.enum(["selected", "no-sample", "stale", "self", "disabled", "offline"]);
export const NetworkEgressSelectionSchema = z.object({
  host: z.string().min(1).max(253),
  nodeId: z.string().uuid().nullable(),
  nodeName: z.string().min(1).max(120).nullable(),
  overlayAddress: z.string().max(15).nullable(),
  dataPlanePort: z.number().int().min(1).max(65_535).nullable(),
  score: z.number().min(0).nullable(),
  reason: NetworkEgressSelectionReasonSchema,
  selectedAt: z.string().datetime(),
}).strict();

/** What an Agent needs to verify inbound data-plane calls and to bind its own proxy. */
export const MeshPeerDirectorySelfSchema = z.object({
  overlayAddress: z.string().max(15),
  revision: z.number().int().min(0).max(2_147_483_647),
  dataPlanePort: z.number().int().min(1).max(65_535),
}).strict();

export const MeshPeerDirectoryEntrySchema = z.object({
  nodeId: z.string().uuid(),
  nodeName: z.string().min(1).max(120),
  overlayAddress: z.string().max(15),
  publicKey: z.string().min(1).max(2_048),
  dataPlanePort: z.number().int().min(1).max(65_535),
}).strict();

export const MeshPeerDirectoryResponseSchema = z.object({
  self: MeshPeerDirectorySelfSchema.nullable(),
  peers: z.array(MeshPeerDirectoryEntrySchema).max(256),
  controllerTime: z.string().datetime(),
}).strict();

/** A user-requested fill: the Controller picks the target node's egress from its own quality table. */
export const NetworkCacheDownloadRequestSchema = z.object({
  nodeId: z.string().uuid(),
  url: OriginUrlSchema,
  digest: NetworkCacheDigestSchema.optional(),
  maxBytes: z.number().int().min(1).max(NETWORK_CACHE_MAX_FETCH_BYTES).optional(),
  expiresInSeconds: z.number().int().min(30).max(900).optional(),
  idempotencyKey: z.string().min(8).max(160).optional(),
  // Asks for a Range-parallel pull; the Controller still owns which peers may serve parts.
  segments: z.object({ maxNodes: z.number().int().min(2).max(NETWORK_SEGMENT_MAX_SOURCES) }).strict().optional(),
}).strict();

export const NetworkCacheDownloadResponseSchema = z.object({
  taskId: z.string().uuid(),
  nodeId: z.string().uuid(),
  // Null when the job runs in segments: no single node is the egress.
  selection: NetworkEgressSelectionSchema.nullable(),
  // Nullish so a Controller that lags the panel still parses a response without the segment plan.
  segments: z.object({ sources: z.array(NetworkCacheSegmentSourceSchema).max(NETWORK_SEGMENT_MAX_SOURCES) }).strict().nullish(),
}).strict();

export type NetworkCacheDownloadRequest = z.infer<typeof NetworkCacheDownloadRequestSchema>;
export type NetworkCacheDownloadResponse = z.infer<typeof NetworkCacheDownloadResponseSchema>;

export type NetworkEgressProbeTaskParameters = z.infer<typeof NetworkEgressProbeTaskParametersSchema>;
export type NetworkEgressProbeSample = z.infer<typeof NetworkEgressProbeSampleSchema>;
export type NetworkEgressProbeResult = z.infer<typeof NetworkEgressProbeResultSchema>;
export type NetworkEgressNode = z.infer<typeof NetworkEgressNodeSchema>;
export type NetworkEgressDisabledReason = z.infer<typeof NetworkEgressDisabledReasonSchema>;
export type NetworkEgressPlanResponse = z.infer<typeof NetworkEgressPlanResponseSchema>;
export type NetworkEgressSelection = z.infer<typeof NetworkEgressSelectionSchema>;
export type NetworkEgressSelectionReason = z.infer<typeof NetworkEgressSelectionReasonSchema>;
export type MeshPeerDirectoryEntry = z.infer<typeof MeshPeerDirectoryEntrySchema>;
export type MeshPeerDirectoryResponse = z.infer<typeof MeshPeerDirectoryResponseSchema>;
