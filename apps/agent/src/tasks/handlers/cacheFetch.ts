import { NetworkCacheFetchTaskParametersSchema, type NetworkCacheFetchResult, type RemoteTaskResultSummary } from "@stackpilot/contracts";
import { agentIdentity, agentPeerDirectory } from "../../dataPlane/runtime.js";
import { fetchThroughCache, type FetchDependencies } from "../../cache/fetch.js";
import { agentCache, transferDeadlineFromEnv } from "../../cache/runtime.js";

export type CacheFetchDependencies = {
  cache?: FetchDependencies["cache"];
  fetchImpl?: FetchDependencies["fetchImpl"];
  identity?: FetchDependencies["identity"];
  peerEgress?: FetchDependencies["peerEgress"];
  onProgress?: FetchDependencies["onProgress"];
  /** `null` disables the deadline; omitting it reads the Agent's environment. */
  deadline?: FetchDependencies["deadline"];
};

/** One sentence an operator can act on: where the bytes came from, and why not elsewhere. */
export function describeFill(result: NetworkCacheFetchResult): string {
  const short = result.digest.slice(0, 12);
  if (result.hit) return `缓存命中 ${short}，本次回源 0 字节`;
  const resumed = result.resumedBytes ? `，其中 ${result.resumedBytes} 字节为上次续传` : "";
  if (result.segmented) return `已写入缓存 ${short}，${result.segmentCount} 个分片从 ${result.segmentSources?.length ?? 0} 个节点并行取回 ${result.sizeBytes} 字节${resumed}`;
  const route = result.viaEgress ? "经出口节点取回"
    : result.egressFallbackReason ? `出口不可用（${result.egressFallbackReason}）已直取`
    : result.segmentsFallbackReason ? `分片不可用（${result.segmentsFallbackReason}）已直取`
    : "回源";
  return `已写入缓存 ${short}，${route} ${result.originBytes} 字节`;
}

export async function cacheFetchHandler(parameters: unknown, signal: AbortSignal, dependencies: CacheFetchDependencies = {}): Promise<RemoteTaskResultSummary> {
  const input = NetworkCacheFetchTaskParametersSchema.parse(parameters);
  const cache = dependencies.cache ?? await agentCache();
  const identity = dependencies.identity ?? agentIdentity();
  const peerEgress = dependencies.peerEgress ?? ((nodeId: string) => {
    const entry = agentPeerDirectory()?.entryFor(nodeId);
    return entry ? { overlayAddress: entry.overlayAddress, port: entry.dataPlanePort } : null;
  });
  // One deadline per task, spanning every route it falls back through; the bytes of a transfer that
  // crawls through three routes still count as one transfer, and nothing waits on it after this.
  const deadline = dependencies.deadline === undefined ? transferDeadlineFromEnv() : dependencies.deadline;
  try {
    const result = await fetchThroughCache(input, {
      cache, signal, peerEgress,
      ...(deadline ? { deadline } : {}),
      ...(dependencies.fetchImpl ? { fetchImpl: dependencies.fetchImpl } : {}),
      ...(identity ? { identity } : {}),
      ...(dependencies.onProgress ? { onProgress: dependencies.onProgress } : {}),
    });
    return { message: describeFill(result), data: result as unknown as Record<string, unknown>, truncated: false };
  } finally {
    deadline?.stop();
  }
}
