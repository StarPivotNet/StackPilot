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

const OriginUrlSchema = z.string().min(1).max(2048).refine((value) => {
  try { return new URL(value).protocol === "https:"; } catch { return false; }
}, "url must be an https:// origin");

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

export type NetworkCacheStats = z.infer<typeof NetworkCacheStatsSchema>;
export type NetworkCacheFetchTaskParameters = z.infer<typeof NetworkCacheFetchTaskParametersSchema>;
export type NetworkCacheFetchResult = z.infer<typeof NetworkCacheFetchResultSchema>;
export type NetworkCacheNodeState = z.infer<typeof NetworkCacheNodeStateSchema>;
export type NetworkCachePlanResponse = z.infer<typeof NetworkCachePlanResponseSchema>;
