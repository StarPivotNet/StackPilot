import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { NETWORK_CACHE_MAX_FETCH_BYTES, type NetworkCacheFetchResult, type NetworkCacheFetchTaskParameters } from "@stackpilot/contracts";
import { openEgressResponse } from "../dataPlane/client.js";
import { PROGRESS_STEP_BYTES, type FetchDependencies } from "./dependencies.js";
import { CacheError } from "./errors.js";
import { openOriginResponse, toNodeStream } from "./origin.js";
import type { ProgressDeadline } from "./progressDeadline.js";
import { fetchSegmented, type SegmentPartReport } from "./segmented.js";
import type { ContentCache } from "./store.js";
import { assertAllowedOriginUrl } from "./urlPolicy.js";

const DEFAULT_MAX_BYTES = 512 * 1024 ** 2;

export { openOriginResponse } from "./origin.js";
export type { FetchDependencies } from "./dependencies.js";

type Fill = { digest: string; sizeBytes: number; originBytes: number; storedAt: string };
export type EnsuredObject = Fill & {
  hit: boolean; viaEgress: boolean; egressNodeId: string | null;
  egressFallbackReason?: string; segmentsFallbackReason?: string;
  segmented?: boolean; segmentCount?: number; segmentSources?: string[]; parts?: SegmentPartReport[]; resumedBytes?: number;
};

async function discard(path: string) { await rm(path, { force: true }).catch(() => undefined); }

function errorCode(error: unknown) {
  return error instanceof CacheError ? error.code : error instanceof Error ? error.name : "UNKNOWN";
}

/** A deadline that already fired ends the task: no further route can make progress. */
function assertLive(deadline: ProgressDeadline | null | undefined) {
  const stalled = deadline?.signal.reason;
  if (stalled instanceof Error) throw stalled;
}

/** A stall belongs to the task, not the route: another route would crawl the same link. */
function isStalled(error: unknown) {
  return error instanceof CacheError && error.code === "CACHE_TRANSFER_STALLED";
}

/** A whole-object fill has no parts; the byte counter is all the panel needs. */
function directProgress(dependencies: FetchDependencies) {
  return dependencies.onProgress
    ? (bytesReceived: number, totalBytes: number | null) => dependencies.onProgress!({ bytesReceived, totalBytes, partsDone: 0, partsTotal: 0 })
    : undefined;
}

/** Streams one response body into the temp slot while hashing, so the key is what actually arrived. */
async function store(response: { stream: Readable; declaredBytes?: number | null; deadline?: ProgressDeadline }, maxBytes: number, cache: ContentCache, input: { url: string; digest?: string }, signal?: AbortSignal, onProgress?: (bytesReceived: number, totalBytes: number | null) => void) {
  if (input.digest === undefined && response.declaredBytes && response.declaredBytes > maxBytes) throw new CacheError("CACHE_TOO_LARGE", "The object exceeds the fetch limit");
  // The volume check belongs before the first byte: an object the cache can never commit must not
  // be downloaded first and then thrown away, which is what a late commit refusal would do.
  if (response.declaredBytes && !(await cache.canStage(response.declaredBytes))) {
    response.stream.destroy();
    throw new CacheError("CACHE_DISK_LOW", "The cache volume cannot hold the object above its reserve");
  }
  const tempPath = cache.reservePath();
  const digest = createHash("sha256");
  let bytes = 0;
  let reported = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      response.deadline?.observe(chunk.length);
      if (bytes > maxBytes) { callback(new CacheError("CACHE_TOO_LARGE", "The object exceeded the fetch limit while streaming")); return; }
      digest.update(chunk);
      if (onProgress && bytes - reported >= PROGRESS_STEP_BYTES) { reported = bytes; onProgress(bytes, response.declaredBytes ?? null); }
      callback(null, chunk);
    },
  });
  try {
    await pipeline(response.stream, meter, createWriteStream(tempPath, { mode: 0o600 }), response.deadline ? { signal: response.deadline.signal } : {});
  } catch (error) {
    await discard(tempPath);
    if (signal?.aborted) throw new CacheError("CACHE_FETCH_CANCELLED", "The cache fill was cancelled");
    // The deadline aborts the pipeline with the coded error as the reason; that code is the answer.
    if (response.deadline?.signal.reason instanceof CacheError) throw response.deadline.signal.reason;
    throw error instanceof CacheError ? error : new CacheError("CACHE_FETCH_FAILED", "The transfer failed");
  }
  const hex = digest.digest("hex");
  if (input.digest && input.digest !== hex) {
    await discard(tempPath);
    throw new CacheError("CACHE_DIGEST_MISMATCH", "The content does not match the expected digest");
  }
  try {
    const entry = await cache.commit(tempPath, { digest: hex, url: input.url, sizeBytes: bytes });
    return { digest: hex, sizeBytes: bytes, storedAt: entry.fetchedAt };
  } catch (error) { await discard(tempPath); throw error; }
}

async function fillFromOrigin(url: string, maxBytes: number, parameters: NetworkCacheFetchTaskParameters, dependencies: FetchDependencies): Promise<Fill> {
  assertLive(dependencies.deadline);
  const response = await openOriginResponse(url, dependencies);
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new CacheError("CACHE_ORIGIN_ERROR", `The origin answered with HTTP ${response.status}`);
  }
  if (!response.body) throw new CacheError("CACHE_ORIGIN_EMPTY", "The origin returned no body");
  const declared = Number(response.headers.get("content-length") ?? Number.NaN);
  const declaredBytes = Number.isSafeInteger(declared) ? declared : null;
  if (declaredBytes !== null && declaredBytes > maxBytes) {
    await response.body.cancel().catch(() => undefined);
    throw new CacheError("CACHE_TOO_LARGE", "The origin object exceeds the fetch limit");
  }
  const stored = await store(
    { stream: toNodeStream(response.body), declaredBytes, ...(dependencies.deadline ? { deadline: dependencies.deadline } : {}) },
    maxBytes, dependencies.cache, { url, ...(parameters.digest ? { digest: parameters.digest } : {}) }, dependencies.signal,
    directProgress(dependencies),
  );
  return { ...stored, originBytes: stored.sizeBytes };
}

async function fillFromEgress(parameters: NetworkCacheFetchTaskParameters & { egress: NonNullable<NetworkCacheFetchTaskParameters["egress"]> }, maxBytes: number, dependencies: FetchDependencies): Promise<Fill> {
  assertLive(dependencies.deadline);
  if (!dependencies.identity) throw new CacheError("EGRESS_UNAVAILABLE", "This node has no identity to sign an egress request");
  const response = await openEgressResponse({
    egress: parameters.egress,
    parameters: { url: parameters.url, ...(parameters.digest ? { digest: parameters.digest } : {}), maxBytes },
    identity: dependencies.identity,
    ...(dependencies.signal ? { signal: dependencies.signal } : {}),
  });
  try {
    if (response.digest && parameters.digest && response.digest !== parameters.digest) {
      throw new CacheError("EGRESS_DIGEST_MISMATCH", "The egress peer announced a digest that differs from the requested one");
    }
    // Validate the stream before it is committed: a lying header must not leave a hit for this URL.
    const expected = response.digest ?? parameters.digest;
    const stored = await store(
      { stream: response.stream, declaredBytes: response.sizeBytes, ...(dependencies.deadline ? { deadline: dependencies.deadline } : {}) },
      maxBytes, dependencies.cache, { url: parameters.url, ...(expected ? { digest: expected } : {}) }, dependencies.signal,
      directProgress(dependencies),
    );
    // The peer already read the origin; the receiving node pulled nothing from the source itself.
    return { ...stored, originBytes: 0 };
  } catch (error) {
    response.stream.destroy();
    if (error instanceof CacheError && error.code === "CACHE_DIGEST_MISMATCH") {
      throw new CacheError("EGRESS_DIGEST_MISMATCH", "The egress peer served bytes that do not match its own digest header");
    }
    throw error;
  }
}

/**
 * Local cache first, then the Range-parallel pull, then the Controller-chosen egress, then the origin.
 * A dead peer never blocks the fill: the failure is recorded on the result and the node falls back.
 */
export async function ensureObject(parameters: NetworkCacheFetchTaskParameters, dependencies: FetchDependencies): Promise<EnsuredObject> {
  const cache = dependencies.cache;
  const maxBytes = Math.min(parameters.maxBytes ?? DEFAULT_MAX_BYTES, NETWORK_CACHE_MAX_FETCH_BYTES);
  const url = assertAllowedOriginUrl(parameters.url).toString();

  const cached = parameters.digest ? await cache.lookup(parameters.digest) : await cache.findByUrl(url);
  if (cached) {
    return { digest: cached.digest, sizeBytes: cached.sizeBytes, hit: true, originBytes: 0, storedAt: cached.fetchedAt, viaEgress: false, egressNodeId: null };
  }
  // A deadline that already fired ends the task here: a hit still answers, but no route can make progress.
  assertLive(dependencies.deadline);

  let segmentsFallbackReason: string | undefined;
  if (parameters.segments) {
    try {
      const filled = await fetchSegmented({ url, maxBytes, parameters, dependencies });
      await cache.recordMiss();
      // The bytes came from peers rather than from this node's own path to the source.
      return { ...filled, hit: false, viaEgress: true, egressNodeId: null };
    } catch (error) {
      if (dependencies.signal?.aborted) throw error;
      if (isStalled(error)) throw error;
      segmentsFallbackReason = errorCode(error);
    }
  }

  let fallbackReason: string | undefined;
  if (parameters.egress) {
    const trusted = dependencies.peerEgress?.(parameters.egress.nodeId) ?? null;
    const matches = trusted !== null && trusted.overlayAddress === parameters.egress.overlayAddress && trusted.port === parameters.egress.port;
    if (!matches) {
      // The task named an address the Controller's directory does not back: never sign a request for it.
      fallbackReason = "EGRESS_UNKNOWN_PEER";
    } else {
      try {
        const filled = await fillFromEgress({ ...parameters, url, egress: parameters.egress }, maxBytes, dependencies);
        await cache.recordMiss();
        return { ...filled, hit: false, viaEgress: true, egressNodeId: parameters.egress.nodeId, ...(segmentsFallbackReason ? { segmentsFallbackReason } : {}) };
      } catch (error) {
        if (dependencies.signal?.aborted) throw error;
        if (isStalled(error)) throw error;
        fallbackReason = errorCode(error);
      }
    }
  }

  const filled = await fillFromOrigin(url, maxBytes, parameters, dependencies);
  await cache.recordMiss();
  return {
    ...filled, hit: false, viaEgress: false, egressNodeId: null,
    ...(fallbackReason ? { egressFallbackReason: fallbackReason } : {}),
    ...(segmentsFallbackReason ? { segmentsFallbackReason } : {}),
  };
}

/** One in-flight transfer per cache instance and URL: two tasks for the same object pull it once. */
const inflight = new WeakMap<ContentCache, Map<string, Promise<NetworkCacheFetchResult>>>();

export async function fetchThroughCache(parameters: NetworkCacheFetchTaskParameters, dependencies: FetchDependencies): Promise<NetworkCacheFetchResult> {
  const started = Date.now();
  const cache = dependencies.cache;
  const maxBytes = Math.min(parameters.maxBytes ?? DEFAULT_MAX_BYTES, NETWORK_CACHE_MAX_FETCH_BYTES);
  const url = assertAllowedOriginUrl(parameters.url).toString();
  const key = [url, parameters.digest ?? "", String(maxBytes)].join("\u0000");
  const pending = inflight.get(cache) ?? new Map<string, Promise<NetworkCacheFetchResult>>();
  inflight.set(cache, pending);

  const existing = pending.get(key);
  if (existing) {
    const shared = await existing;
    if (dependencies.signal?.aborted) throw new CacheError("CACHE_FETCH_CANCELLED", "The cache fill was cancelled");
    return { ...shared, originBytes: 0, elapsedMs: Date.now() - started };
  }

  const task = fill(url, parameters, dependencies, started).finally(() => { pending.delete(key); });
  pending.set(key, task);
  return task;
}

async function fill(url: string, parameters: NetworkCacheFetchTaskParameters, dependencies: FetchDependencies, started: number): Promise<NetworkCacheFetchResult> {
  const ensured = await ensureObject({ ...parameters, url }, dependencies);
  return {
    url, digest: ensured.digest, sizeBytes: ensured.sizeBytes, hit: ensured.hit, originBytes: ensured.originBytes,
    storedAt: ensured.storedAt, elapsedMs: Date.now() - started, viaEgress: ensured.viaEgress, egressNodeId: ensured.egressNodeId,
    ...(ensured.egressFallbackReason ? { egressFallbackReason: ensured.egressFallbackReason } : {}),
    ...(ensured.segmentsFallbackReason ? { segmentsFallbackReason: ensured.segmentsFallbackReason } : {}),
    ...(ensured.segmented ? {
      segmented: true,
      segmentCount: ensured.segmentCount ?? 0,
      segmentSources: ensured.segmentSources ?? [],
      ...(ensured.parts ? { parts: ensured.parts } : {}),
      resumedBytes: ensured.resumedBytes ?? 0,
    } : {}),
  };
}
