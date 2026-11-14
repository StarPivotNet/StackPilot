import {
  NETWORK_SEGMENT_MAX_SOURCES, NETWORK_SEGMENT_MIN_BYTES, NETWORK_SEGMENT_MIN_PART_BYTES,
  NETWORK_SEGMENT_PART_ATTEMPTS, NETWORK_SEGMENT_RESTARTS,
  type NetworkCacheFetchTaskParameters, type NetworkCacheSegmentSource,
} from "@stackpilot/contracts";
import { openPeerRange } from "../dataPlane/client.js";
import type { FetchDependencies } from "./dependencies.js";
import { CacheError } from "./errors.js";
import { probeRangeSupport } from "./origin.js";
import { SegmentStaging, lockStagingFill, stagingKey } from "./staging.js";

export type SegmentPart = { index: number; start: number; end: number; source: NetworkCacheSegmentSource };
export type SegmentPartReport = { index: number; sourceNodeId: string; bytes: number; resumed: boolean };

export type SegmentedFill = {
  digest: string; sizeBytes: number; originBytes: number; storedAt: string;
  segmented: true; segmentCount: number; segmentSources: string[]; parts: SegmentPartReport[]; resumedBytes: number;
};

/**
 * Cuts the object into as many contiguous parts as there are usable sources, never below the part
 * floor: a range request that returns a few hundred kilobytes mostly measures latency.
 */
export function planSegments(totalBytes: number, sources: readonly NetworkCacheSegmentSource[]): SegmentPart[] {
  if (!Number.isSafeInteger(totalBytes) || totalBytes < NETWORK_SEGMENT_MIN_BYTES) return [];
  const usable = sources.slice(0, NETWORK_SEGMENT_MAX_SOURCES);
  if (usable.length === 0) return [];
  const count = Math.min(usable.length, Math.floor(totalBytes / NETWORK_SEGMENT_MIN_PART_BYTES));
  if (count < 1) return [];
  const size = Math.floor(totalBytes / count);
  return Array.from({ length: count }, (_, index) => ({
    index,
    start: index * size,
    end: index === count - 1 ? totalBytes - 1 : (index + 1) * size - 1,
    source: usable[index]!,
  }));
}

/** Only sources the Controller's own directory backs; a task parameter may name any address. */
function trustedSources(plan: NonNullable<NetworkCacheFetchTaskParameters["segments"]>, dependencies: FetchDependencies) {
  return plan.sources.filter((source) => {
    const trusted = dependencies.peerEgress?.(source.nodeId) ?? null;
    return trusted !== null && trusted.overlayAddress === source.overlayAddress && trusted.port === source.port;
  });
}

async function runPart(part: SegmentPart, url: string, staging: SegmentStaging, dependencies: FetchDependencies, onWritten?: (index: number, written: number) => void) {
  let lastError: unknown;
  for (let attempt = 0; attempt < NETWORK_SEGMENT_PART_ATTEMPTS; attempt += 1) {
    if (dependencies.signal?.aborted) throw new CacheError("CACHE_FETCH_CANCELLED", "The cache fill was cancelled");
    // A stalled job must not spend its retries: the deadline already judged the whole transfer dead.
    const stalled = dependencies.deadline?.signal.reason;
    if (stalled instanceof Error) throw stalled;
    let stream: NodeJS.ReadableStream | null = null;
    try {
      const response = await openPeerRange({
        source: part.source,
        parameters: { url, start: part.start, end: part.end },
        identity: dependencies.identity!,
        ...(dependencies.signal ? { signal: dependencies.signal } : {}),
      });
      stream = response.stream;
      await staging.writePart(part, response.stream, undefined, onWritten ? (written) => onWritten(part.index, written) : undefined, dependencies.deadline);
      return;
    } catch (error) {
      (stream as { destroy?: () => void } | null)?.destroy?.();
      if (process.env.SP_SEGMENTS_DEBUG) console.error("[segments-debug]", part.index, (error as { code?: string }).code ?? "NO_CODE", (error as Error).message);
      if (dependencies.signal?.aborted) throw new CacheError("CACHE_FETCH_CANCELLED", "The cache fill was cancelled");
      lastError = error;
    }
  }
  throw new CacheError("CACHE_SEGMENT_PART_FAILED", `Part ${part.index} failed after ${NETWORK_SEGMENT_PART_ATTEMPTS} attempts (${lastError instanceof CacheError ? lastError.code : "UNKNOWN"})`);
}

async function runParts(parts: readonly SegmentPart[], url: string, staging: SegmentStaging, dependencies: FetchDependencies, onWritten?: (index: number, written: number) => void) {
  const pending = parts.filter((part) => !staging.completed.includes(part.index));
  // Settled, not all: a failing part must not leave the others writing into a staging area the
  // caller is about to discard or resume from.
  const results = await Promise.allSettled(pending.map((part) => runPart(part, url, staging, dependencies, onWritten)));
  const failed = results.find((result) => result.status === "rejected");
  if (failed) throw (failed as PromiseRejectedResult).reason;
}

/**
 * Range-parallel pull: every peer streams one contiguous part of the same origin object, the
 * receiving node writes each part at its offset and hashes the assembled file once at the end.
 * A part is retried on its own; only a whole-object digest mismatch restarts everything.
 */
export async function fetchSegmented(input: {
  url: string; maxBytes: number; parameters: NetworkCacheFetchTaskParameters; dependencies: FetchDependencies;
}): Promise<SegmentedFill> {
  const { url, maxBytes, parameters, dependencies } = input;
  const plan = parameters.segments;
  if (!plan) throw new CacheError("CACHE_SEGMENT_PLAN_MISSING", "No segment plan was supplied");
  if (!dependencies.identity) throw new CacheError("CACHE_SEGMENT_NO_IDENTITY", "This node has no identity to sign a segment request");
  const sources = trustedSources(plan, dependencies);
  if (sources.length === 0) throw new CacheError("CACHE_SEGMENT_NO_SOURCE", "No named peer matches the Controller's directory");

  const support = await probeRangeSupport(url, dependencies);
  // A source that ignores Range has to be fetched whole, which is the egress or direct path.
  if (!support.supported) throw new CacheError("CACHE_RANGE_UNSUPPORTED", "The origin does not serve byte ranges");
  if (support.totalBytes <= 0) throw new CacheError("CACHE_RANGE_UNSUPPORTED", "The origin did not report the object size");
  if (support.totalBytes > maxBytes) throw new CacheError("CACHE_TOO_LARGE", "The origin object exceeds the fetch limit");
  if (!(await dependencies.cache.canStage(support.totalBytes))) {
    throw new CacheError("CACHE_DISK_LOW", "The cache volume cannot stage the object above its reserve");
  }

  const parts = planSegments(support.totalBytes, sources);
  if (parts.length === 0) throw new CacheError("CACHE_SEGMENT_TOO_SMALL", "The object is too small to be worth splitting");

  const resumable = parameters.digest !== undefined;
  // A resumable directory is named after the object, so two tasks for one object can get here with
  // the same directory; the lock makes one fill own it at a time, restarts included.
  const release = resumable ? await lockStagingFill(stagingKey(url, support.totalBytes), dependencies.signal) : null;
  let keepStaging = false;
  let dropStaging: (() => Promise<void>) | null = null;
  try {
    for (let attempt = 0; attempt <= NETWORK_SEGMENT_RESTARTS; attempt += 1) {
      const staging = await SegmentStaging.open({
        root: dependencies.cache.stagingRoot, url, totalBytes: support.totalBytes, etag: support.etag, parts,
        // Only a digest proves resumed parts are this object's bytes; a blind fill always starts at zero.
        resume: resumable,
      });
      dropStaging = () => staging.discard();
      const resumedBytes = staging.resumedBytes;
      const resumedParts = new Set(staging.completed);
      // Resumed parts already count through the staging area; the live map only adds the parts that
      // are still arriving, so a part that just completed is never counted twice.
      const live = new Map<number, number>();
      const report = () => {
        let received = staging.resumedBytes;
        for (const [index, written] of live) if (!staging.completed.includes(index)) received += written;
        // A completed part counts as its whole range; a running one reports the bytes on disk so far.
        const progressParts = parts.map((part) => {
          const totalBytes = part.end - part.start + 1;
          return {
            index: part.index,
            sourceNodeId: part.source.nodeId,
            bytes: staging.completed.includes(part.index) ? totalBytes : live.get(part.index) ?? 0,
            totalBytes,
          };
        });
        dependencies.onProgress?.({ bytesReceived: received, totalBytes: support.totalBytes, partsDone: staging.completed.length, partsTotal: parts.length, parts: progressParts });
      };
      let nothingToResume = false;
      try {
        // Every part is on disk; publish the finished counters before the whole-object hash runs.
        report();
        await runParts(parts, url, staging, dependencies, (index, written) => { live.set(index, written); report(); });
        // Every part is on disk; publish the finished counters before the whole-object hash runs.
        report();
        const digest = await staging.digest();
        if (parameters.digest && parameters.digest !== digest) {
          // The whole-object hash is the only integrity proof; a bad part invalidates every part.
          await staging.discard();
          nothingToResume = true;
          if (attempt < NETWORK_SEGMENT_RESTARTS) continue;
          throw new CacheError("CACHE_DIGEST_MISMATCH", "The assembled object does not match the expected digest");
        }
        const dataPath = await staging.take();
        // The file belongs to the cache from here: a commit failure leaves nothing to resume.
        nothingToResume = true;
        try {
          const entry = await dependencies.cache.commitStaged(dataPath, { digest, url, sizeBytes: support.totalBytes });
          return {
            digest, sizeBytes: support.totalBytes, originBytes: 0, storedAt: entry.fetchedAt,
            segmented: true, segmentCount: parts.length, segmentSources: [...new Set(parts.map((part) => part.source.nodeId))],
            // writePart refuses a short or long body, so a completed part is exactly its range.
            parts: parts.map((part) => ({ index: part.index, sourceNodeId: part.source.nodeId, bytes: part.end - part.start + 1, resumed: resumedParts.has(part.index) })),
            resumedBytes,
          };
        } finally {
          await staging.discard();
        }
      } catch (error) {
        // Only a part failure leaves bytes worth resuming; a dropped directory or a handed-off file
        // has nothing left. The cleanup below is the one place that runs it before the lock moves on.
        keepStaging = resumable && !nothingToResume && !(error instanceof CacheError && error.code === "CACHE_FETCH_CANCELLED");
        throw error;
      }
    }
  } finally {
    // The next owner resets whatever it finds here, so the directory has to be gone before the lock
    // moves on. An `open` that failed after creating the directory is the exception: it leaves a
    // directory this function never learns about, and the next `open` (or the sweep) reclaims it.
    if (!keepStaging) await dropStaging?.();
    release?.();
  }
  throw new CacheError("CACHE_DIGEST_MISMATCH", "The assembled object does not match the expected digest");
}
