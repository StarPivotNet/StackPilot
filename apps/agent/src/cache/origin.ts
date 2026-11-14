import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { CacheError } from "./errors.js";
import { assertAllowedOriginUrl } from "./urlPolicy.js";

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 3;
/** `bytes 0-0/1234`: the total is the only number a Range probe is after. */
const CONTENT_RANGE = /^bytes (\d+)-(\d+)\/(\d+|\*)$/i;

export type OriginDependencies = { fetchImpl?: typeof fetch; signal?: AbortSignal; headers?: Record<string, string> };

export function toNodeStream(body: ReadableStream<Uint8Array>) {
  return Readable.fromWeb(body as unknown as NodeReadableStream<Uint8Array>);
}

export function parseContentRange(value: string | null): { start: number; end: number; total: number | null } | null {
  const match = CONTENT_RANGE.exec((value ?? "").trim());
  if (!match) return null;
  const start = Number(match[1]); const end = Number(match[2]);
  const total = match[3] === "*" ? null : Number(match[3]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) return null;
  if (total !== null && (!Number.isSafeInteger(total) || total <= end)) return null;
  return { start, end, total };
}

/** `redirect: manual` because every hop has to pass the same host policy as the first one. */
export async function openOriginResponse(url: string, dependencies: OriginDependencies): Promise<Response> {
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const init: RequestInit = {
      method: "GET", redirect: "manual",
      ...(dependencies.headers ? { headers: dependencies.headers } : {}),
      ...(dependencies.signal ? { signal: dependencies.signal } : {}),
    };
    const response = await fetchImpl(current, init);
    if (!REDIRECT_STATUS.has(response.status)) return response;
    const location = response.headers.get("location");
    await response.body?.cancel().catch(() => undefined);
    if (!location) throw new CacheError("CACHE_REDIRECT_INVALID", "The origin redirected without a location");
    current = assertAllowedOriginUrl(new URL(location, current).toString()).toString();
  }
  throw new CacheError("CACHE_REDIRECT_LIMIT", "The origin redirected more than three times");
}

export type RangeSupport = { supported: boolean; totalBytes: number; etag: string | null };

/**
 * One-byte probe: a 206 with a `Content-Range` total is the only proof that the source can be cut
 * into ranges. A 200 means the origin ignored the header, so the whole object has to be fetched.
 */
export async function probeRangeSupport(url: string, dependencies: OriginDependencies): Promise<RangeSupport> {
  const target = assertAllowedOriginUrl(url).toString();
  const response = await openOriginResponse(target, { ...dependencies, headers: { ...dependencies.headers, Range: "bytes=0-0" } });
  try {
    if (response.status === 206) {
      const range = parseContentRange(response.headers.get("content-range"));
      if (range === null || range.total === null) throw new CacheError("CACHE_RANGE_UNSUPPORTED", "The origin sent no total size for the range");
      return { supported: true, totalBytes: range.total, etag: response.headers.get("etag") };
    }
    if (response.status === 200) {
      const declared = Number(response.headers.get("content-length") ?? Number.NaN);
      return { supported: false, totalBytes: Number.isSafeInteger(declared) && declared >= 0 ? declared : 0, etag: response.headers.get("etag") };
    }
    throw new CacheError("CACHE_ORIGIN_ERROR", `The origin answered with HTTP ${response.status}`);
  } finally {
    await response.body?.cancel().catch(() => undefined);
  }
}

/**
 * One part straight from the origin: the response must be a 206 covering exactly the requested
 * span, otherwise the caller would write bytes at the wrong offset.
 */
export async function openOriginRange(url: string, start: number, end: number, dependencies: OriginDependencies): Promise<{ stream: Readable; bytes: number; totalBytes: number | null }> {
  // The range path is reachable from a peer request, so it re-validates the host instead of trusting the caller.
  const target = assertAllowedOriginUrl(url).toString();
  const response = await openOriginResponse(target, { ...dependencies, headers: { ...dependencies.headers, Range: `bytes=${start}-${end}` } });
  if (response.status === 200) {
    await response.body?.cancel().catch(() => undefined);
    throw new CacheError("CACHE_RANGE_UNSUPPORTED", "The origin ignored the range request");
  }
  if (response.status !== 206) {
    await response.body?.cancel().catch(() => undefined);
    throw new CacheError("CACHE_ORIGIN_ERROR", `The origin answered with HTTP ${response.status}`);
  }
  const range = parseContentRange(response.headers.get("content-range"));
  if (range === null || range.start !== start || range.end !== end) {
    await response.body?.cancel().catch(() => undefined);
    throw new CacheError("CACHE_RANGE_MISMATCH", "The origin served a different range than the one requested");
  }
  if (!response.body) throw new CacheError("CACHE_ORIGIN_EMPTY", "The origin returned no body");
  return { stream: toNodeStream(response.body), bytes: end - start + 1, totalBytes: range.total };
}
