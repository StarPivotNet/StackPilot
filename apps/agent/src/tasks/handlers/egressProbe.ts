import { EGRESS_PROBE_MAX_BYTES, EGRESS_PROBE_TIMEOUT_MS, NetworkEgressProbeResultSchema, NetworkEgressProbeTaskParametersSchema, type NetworkEgressProbeSample, type RemoteTaskResultSummary } from "@stackpilot/contracts";
import { openOriginResponse } from "../../cache/fetch.js";
import { CacheError } from "../../cache/errors.js";
import { assertAllowedOriginUrl } from "../../cache/urlPolicy.js";

export type EgressProbeDependencies = { fetchImpl?: typeof fetch; now?: () => Date; timeoutMs?: number };

/**
 * Measures this node's own path to each source: time to first byte plus the rate of a bounded read.
 * Nothing is cached and no response is kept; the numbers are the whole payload. Redirects are followed
 * hop by hop under the same host policy as a fill, so a probe cannot be steered at an internal address.
 */
export async function egressProbeHandler(parameters: unknown, signal: AbortSignal, dependencies: EgressProbeDependencies = {}): Promise<RemoteTaskResultSummary> {
  const input = NetworkEgressProbeTaskParametersSchema.parse(parameters);
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const timeoutMs = dependencies.timeoutMs ?? EGRESS_PROBE_TIMEOUT_MS;
  const samples: NetworkEgressProbeSample[] = [];

  for (const target of input.targets) {
    if (signal.aborted) throw new Error("EGRESS_PROBE_CANCELLED");
    const started = performance.now();
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let url = target.url;
    let host = "-";
    let statusCode: number | null = null;
    let ttfbMs: number | null = null;
    let bytes = 0;
    let errorCode: string | null = null;
    try {
      url = assertAllowedOriginUrl(target.url).toString();
      host = new URL(url).hostname;
      const response = await openOriginResponse(url, { fetchImpl, signal: controller.signal });
      statusCode = response.status;
      ttfbMs = Math.max(0, Math.round(performance.now() - started));
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        errorCode = `EGRESS_PROBE_HTTP_${response.status}`;
      } else if (response.body) {
        const reader = response.body.getReader();
        while (bytes < EGRESS_PROBE_MAX_BYTES) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
        }
        await reader.cancel().catch(() => undefined);
      }
    } catch (error) {
      errorCode = controller.signal.aborted
        ? (signal.aborted ? "EGRESS_PROBE_CANCELLED" : "EGRESS_PROBE_TIMEOUT")
        : error instanceof CacheError ? error.code : "EGRESS_PROBE_FAILED";
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
    if (signal.aborted) throw new Error("EGRESS_PROBE_CANCELLED");
    const elapsedMs = Math.max(1, performance.now() - started);
    samples.push({
      url, host, ok: errorCode === null, statusCode, ttfbMs,
      bytesPerSecond: bytes > 0 ? Math.round(bytes / (elapsedMs / 1_000)) : null,
      errorCode,
    });
  }

  const collectedAt = (dependencies.now ?? (() => new Date()))().toISOString();
  const result = NetworkEgressProbeResultSchema.parse({ collectedAt, samples });
  const ok = samples.filter((sample) => sample.ok).length;
  return { message: `Probed ${samples.length} source(s); ${ok} responded`, data: result as unknown as Record<string, unknown>, truncated: false };
}
