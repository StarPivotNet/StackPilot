import { z } from "zod";
import { NETWORK_SEGMENT_MAX_SOURCES, NetworkCacheDigestSchema, OriginUrlSchema } from "./cache.js";
import { RemoteTaskStatusSchema } from "./tasks.js";

/** One part of a segmented pull: the peer serving it, how far it got, and the Controller's rate. */
export const NetworkCacheDownloadPartSchema = z.object({
  index: z.number().int().min(0).max(NETWORK_SEGMENT_MAX_SOURCES + 1),
  sourceNodeId: z.string().uuid(),
  bytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  totalBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  bytesPerSecond: z.number().nonnegative().max(1e12).nullable(),
}).strict();

/**
 * One `network.cache.fetch` task seen as a download job: the task counters plus the fill result.
 * Every byte figure comes from the Agent; nothing here is estimated by the panel.
 */
export const NetworkCacheDownloadJobSchema = z.object({
  taskId: z.string().uuid(),
  nodeId: z.string().uuid(),
  nodeName: z.string().min(1).max(120).nullable(),
  url: OriginUrlSchema,
  host: z.string().min(1).max(253),
  status: RemoteTaskStatusSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  bytesReceived: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  totalBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
  bytesPerSecond: z.number().nonnegative().max(1e12).nullable(),
  segmented: z.boolean(),
  // Live part counters from the running task; zero when the job is not segmented.
  partsDone: z.number().int().min(0).max(NETWORK_SEGMENT_MAX_SOURCES),
  partsTotal: z.number().int().min(0).max(NETWORK_SEGMENT_MAX_SOURCES),
  segmentCount: z.number().int().min(0).max(NETWORK_SEGMENT_MAX_SOURCES + 1),
  segmentSources: z.number().int().min(0).max(NETWORK_SEGMENT_MAX_SOURCES),
  // Live per-part counters; empty for a direct fill, a finished job, or an Agent that sent none.
  parts: z.array(NetworkCacheDownloadPartSchema).max(NETWORK_SEGMENT_MAX_SOURCES + 1).default([]),
  resumedBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  // null until the Agent reports a result: an unknown hit state must not render as a miss.
  hit: z.boolean().nullable(),
  viaEgress: z.boolean().nullable(),
  originBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
  sizeBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
  digest: NetworkCacheDigestSchema.nullable(),
  failureReason: z.string().min(1).max(120).nullable(),
  retryable: z.boolean(),
  attempt: z.number().int().min(0).max(3),
}).strict();

/**
 * One node's month-to-date transfer, all figures summed from finished jobs and their parts.
 * `receivedBytes` is what the node pulled in (origin or peers), `servedBytes` what it streamed to
 * peers, `originBytes` what it read from the origin itself. A degraded node keeps cache hits and
 * direct fills but loses shard parallelism and egress delegation.
 */
export const NetworkCacheDownloadTrafficNodeSchema = z.object({
  nodeId: z.string().uuid(),
  nodeName: z.string().min(1).max(120).nullable(),
  receivedBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  originBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  servedBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  degraded: z.boolean(),
}).strict();

export const NetworkCacheDownloadTrafficSchema = z.object({
  /** First instant of the UTC month the counters cover; the Controller's clock, never the panel's. */
  monthStart: z.string().datetime(),
  /** Zero means no monthly limit is configured and nothing is ever degraded. */
  quotaBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  nodes: z.array(NetworkCacheDownloadTrafficNodeSchema).max(512),
}).strict();

export const NetworkCacheDownloadJobListResponseSchema = z.object({
  jobs: z.array(NetworkCacheDownloadJobSchema).max(200),
  traffic: NetworkCacheDownloadTrafficSchema,
  collectedAt: z.string().datetime(),
}).strict();

export type NetworkCacheDownloadJob = z.infer<typeof NetworkCacheDownloadJobSchema>;
export type NetworkCacheDownloadTraffic = z.infer<typeof NetworkCacheDownloadTrafficSchema>;
export type NetworkCacheDownloadTrafficNode = z.infer<typeof NetworkCacheDownloadTrafficNodeSchema>;
export type NetworkCacheDownloadJobListResponse = z.infer<typeof NetworkCacheDownloadJobListResponseSchema>;
