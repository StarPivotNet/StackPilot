import { NetworkCacheFetchTaskParametersSchema, type RemoteTaskResultSummary } from "@stackpilot/contracts";
import { agentIdentity, agentPeerDirectory } from "../../dataPlane/runtime.js";
import { fetchThroughCache, type FetchDependencies } from "../../cache/fetch.js";
import { agentCache } from "../../cache/runtime.js";

export type CacheFetchDependencies = {
  cache?: FetchDependencies["cache"];
  fetchImpl?: FetchDependencies["fetchImpl"];
  identity?: FetchDependencies["identity"];
  peerEgress?: FetchDependencies["peerEgress"];
};

export async function cacheFetchHandler(parameters: unknown, signal: AbortSignal, dependencies: CacheFetchDependencies = {}): Promise<RemoteTaskResultSummary> {
  const input = NetworkCacheFetchTaskParametersSchema.parse(parameters);
  const cache = dependencies.cache ?? await agentCache();
  const identity = dependencies.identity ?? agentIdentity();
  const peerEgress = dependencies.peerEgress ?? ((nodeId: string) => {
    const entry = agentPeerDirectory()?.entryFor(nodeId);
    return entry ? { overlayAddress: entry.overlayAddress, port: entry.dataPlanePort } : null;
  });
  const result = await fetchThroughCache(input, {
    cache, signal, peerEgress,
    ...(dependencies.fetchImpl ? { fetchImpl: dependencies.fetchImpl } : {}),
    ...(identity ? { identity } : {}),
  });
  const short = result.digest.slice(0, 12);
  const route = result.viaEgress ? "经出口节点取回" : result.egressFallbackReason ? `出口不可用（${result.egressFallbackReason}）已直取` : "回源";
  const message = result.hit ? `缓存命中 ${short}，本次回源 0 字节` : `已写入缓存 ${short}，${route} ${result.originBytes} 字节`;
  return { message, data: result as unknown as Record<string, unknown>, truncated: false };
}
