import { z } from "zod";
import { NetworkMeshOverlayAddressSchema } from "./mesh.js";

const BytesSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
// The index is a single JSON document; the cap keeps it small enough to rewrite on every hit.
export const NETWORK_CACHE_MAX_ENTRIES = 8_192;
export const NETWORK_CACHE_MAX_FETCH_BYTES = 8 * 1024 ** 3;
/** A heartbeat every 15s makes five minutes of silence a dead collector, not a slow one. */
export const NETWORK_CACHE_STATS_STALE_SECONDS = 300;
/** Below this the helper-side reserve refuses new objects, so the panel warns before downloads fail. */
export const NETWORK_CACHE_DISK_WARNING_BYTES = 1024 ** 3;

/** Splitting a small object only adds overhead: below this one stream wins. */
export const NETWORK_SEGMENT_MIN_BYTES = 8 * 1024 ** 2;
/** Parts smaller than this mostly measure per-request latency, not bandwidth. */
export const NETWORK_SEGMENT_MIN_PART_BYTES = 2 * 1024 ** 2;
export const NETWORK_SEGMENT_MAX_SOURCES = 8;
/** A failed part is retried on its own; only a digest mismatch restarts the whole object. */
export const NETWORK_SEGMENT_PART_ATTEMPTS = 2;
export const NETWORK_SEGMENT_RESTARTS = 1;
/** No byte for this long means a stalled part, which is retried instead of pinning the job. */
export const NETWORK_SEGMENT_IDLE_TIMEOUT_MS = 60_000;
/** Staging nobody touched for a day is an abandoned transfer, not a resumable job. */
export const NETWORK_SEGMENT_STAGING_TTL_MS = 24 * 60 * 60 * 1000;
/**
 * A blind directory can never be reopened: its name carries the process that made it and that
 * process's sequence number. After a crash the bytes are unverifiable garbage, so it goes after an
 * hour instead of holding the volume for a day.
 */
export const NETWORK_SEGMENT_BLIND_TTL_MS = 60 * 60 * 1000;
/**
 * A transfer that keeps trickling is dead in practice: a throttled peer sends a few bytes often
 * enough to keep any idle timer armed. Progress is judged over a window, and the floor is a rate.
 */
export const NETWORK_TRANSFER_STALL_WINDOW_MS = 120_000;
export const NETWORK_TRANSFER_MIN_BYTES_PER_SECOND = 2_048;

/** Content addressing key: the SHA-256 of the stored bytes, lowercase hex. */
export const NetworkCacheDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);

/** What one node reports about its local cache; no paths, URLs or object identities. */
export const NetworkCacheStatsSchema = z.object({
  collectedAt: z.string().datetime(),
  capacityBytes: BytesSchema,
  usedBytes: BytesSchema,
  entryCount: z.number().int().min(0).max(NETWORK_CACHE_MAX_ENTRIES),
  hits: BytesSchema,
  misses: BytesSchema,
  evictions: BytesSchema,
  // Nullish so a node whose filesystem refuses statfs reports unknown instead of a fake number.
  diskFreeBytes: BytesSchema.nullish(),
}).strict();

export const OriginUrlSchema = z.string().min(1).max(2048).refine((value) => {
  try { return new URL(value).protocol === "https:"; } catch { return false; }
}, "url must be an https:// origin");

/**
 * A peer the receiving node may pull one byte range from. The Controller names it, but the node only
 * signs a request for an entry its own peer directory backs.
 */
export const NetworkCacheSegmentSourceSchema = z.object({
  nodeId: z.string().uuid(),
  overlayAddress: NetworkMeshOverlayAddressSchema,
  port: z.number().int().min(1).max(65_535),
}).strict();

/** Sources only: how many parts to cut is the receiving node's decision, since it knows the size. */
export const NetworkCacheSegmentPlanSchema = z.object({
  sources: z.array(NetworkCacheSegmentSourceSchema).min(1).max(NETWORK_SEGMENT_MAX_SOURCES),
}).strict();

/** One byte range of an origin object, served over the overlay without being stored anywhere. */
export const NetworkCacheRangeRequestSchema = z.object({
  url: OriginUrlSchema,
  start: BytesSchema,
  end: BytesSchema,
}).strict().refine((value) => value.end >= value.start, { message: "end must not precede start", path: ["end"] });

/** The Controller chooses the object; the Agent still re-validates the host before any transfer. */
export const NetworkCacheFetchTaskParametersSchema = z.object({
  url: OriginUrlSchema,
  // Optional because a release asset may not publish a digest; the fetched bytes become the key.
  digest: NetworkCacheDigestSchema.optional(),
  maxBytes: z.number().int().min(1).max(NETWORK_CACHE_MAX_FETCH_BYTES).optional(),
  // Chosen by the Controller from its egress table; the receiving node calls that peer's proxy first
  // and re-checks the address against the peer directory before it signs anything.
  egress: z.object({
    nodeId: z.string().uuid(),
    overlayAddress: NetworkMeshOverlayAddressSchema,
    port: z.number().int().min(1).max(65_535),
  }).strict().optional(),
  // Present when the Controller wants the object cut into ranges and pulled from several peers.
  segments: NetworkCacheSegmentPlanSchema.optional(),
}).strict();

/**
 * One finished part: which peer served it and how many bytes it wrote. The Agent's own staging
 * refuses a short or long body, so `bytes` is the verified range, not an estimate.
 */
export const NetworkCacheSegmentPartResultSchema = z.object({
  index: z.number().int().min(0).max(NETWORK_SEGMENT_MAX_SOURCES + 1),
  sourceNodeId: z.string().uuid(),
  bytes: BytesSchema,
  resumed: z.boolean(),
}).strict();

export const NetworkCacheFetchResultSchema = z.object({
  url: OriginUrlSchema,
  digest: NetworkCacheDigestSchema,
  sizeBytes: BytesSchema,
  hit: z.boolean(),
  originBytes: BytesSchema,
  storedAt: z.string().datetime(),
  elapsedMs: z.number().int().min(0).max(3_600_000),
  // Optional so a Controller that lags its Agent still parses a result that names its egress.
  viaEgress: z.boolean().optional(),
  egressNodeId: z.string().uuid().nullish(),
  // Set when the chosen egress failed and the node fetched directly instead.
  egressFallbackReason: z.string().min(1).max(64).optional(),
  // Segmented mode: which peers served bytes, and why it was abandoned when it was.
  segmented: z.boolean().optional(),
  segmentCount: z.number().int().min(0).max(NETWORK_SEGMENT_MAX_SOURCES + 1).optional(),
  segmentSources: z.array(z.string().uuid()).max(NETWORK_SEGMENT_MAX_SOURCES).optional(),
  // Per-part attribution; absent on a result from an Agent that predates the field.
  parts: z.array(NetworkCacheSegmentPartResultSchema).max(NETWORK_SEGMENT_MAX_SOURCES + 1).optional(),
  resumedBytes: BytesSchema.optional(),
  segmentsFallbackReason: z.string().min(1).max(64).optional(),
}).strict();

export const NetworkCacheNodeStateSchema = z.object({
  nodeId: z.string().uuid(),
  nodeName: z.string().min(1).max(120),
  status: z.enum(["ready", "stale", "pending", "disabled"]),
  stats: NetworkCacheStatsSchema.nullable(),
}).strict();

/** Mirror of the mesh plan response: one timestamp from the Controller, no client-side clock math. */
export const NetworkCachePlanResponseSchema = z.object({
  updatedAt: z.string().datetime(),
  nodes: z.array(NetworkCacheNodeStateSchema).max(512),
  warnings: z.array(z.string().min(1).max(240)).max(20),
}).strict();

export type NetworkCacheSegmentSource = z.infer<typeof NetworkCacheSegmentSourceSchema>;
export type NetworkCacheSegmentPlan = z.infer<typeof NetworkCacheSegmentPlanSchema>;
export type NetworkCacheRangeRequest = z.infer<typeof NetworkCacheRangeRequestSchema>;
export type NetworkCacheStats = z.infer<typeof NetworkCacheStatsSchema>;
export type NetworkCacheFetchTaskParameters = z.infer<typeof NetworkCacheFetchTaskParametersSchema>;
export type NetworkCacheSegmentPartResult = z.infer<typeof NetworkCacheSegmentPartResultSchema>;
export type NetworkCacheFetchResult = z.infer<typeof NetworkCacheFetchResultSchema>;
export type NetworkCacheNodeState = z.infer<typeof NetworkCacheNodeStateSchema>;
export type NetworkCachePlanResponse = z.infer<typeof NetworkCachePlanResponseSchema>;
