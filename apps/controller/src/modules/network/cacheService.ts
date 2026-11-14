import {
  NETWORK_CACHE_DISK_WARNING_BYTES, NETWORK_CACHE_STATS_STALE_SECONDS,
  type AgentCapability, type NetworkCacheNodeState, type NetworkCachePlanResponse,
} from "@stackpilot/contracts";
import type { AgentControlRepository, AgentNodeState } from "../../repositories/agentControlRepository.js";

export const CACHE_READ_CAPABILITY: AgentCapability = "network.cache.read";

/** Reads only; the catalogue is filled by `network.cache.fetch`, which needs `network.transfer`. */
const isEligible = (node: AgentNodeState) => !node.revokedAt
  && node.allowedCapabilities.includes(CACHE_READ_CAPABILITY) && node.declaredCapabilities.includes(CACHE_READ_CAPABILITY);

function formatBytes(value: number) {
  if (value < 1024 ** 2) return `${Math.round(value / 1024)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(1)} GB`;
}

export class CacheService {
  constructor(private readonly repository: AgentControlRepository) {}

  private project(nodes: readonly AgentNodeState[], now: Date): NetworkCacheNodeState[] {
    return nodes.map((node) => {
      const stats = node.cacheStats ?? null;
      const ageSeconds = stats === null ? null : Math.max(0, Math.floor((now.getTime() - Date.parse(stats.collectedAt)) / 1_000));
      return {
        nodeId: node.nodeId,
        nodeName: node.nodeName,
        status: !isEligible(node) ? "disabled"
          : stats === null ? "pending"
          : ageSeconds !== null && ageSeconds > NETWORK_CACHE_STATS_STALE_SECONDS ? "stale"
          : "ready",
        stats,
      };
    });
  }

  private warnings(nodeStates: readonly NetworkCacheNodeState[]): string[] {
    const warnings: string[] = [];
    for (const state of nodeStates) {
      const stats = state.stats;
      if (state.status === "disabled") warnings.push(`节点 ${state.nodeName} 未授权 network.cache.read 能力，不参与共享缓存`);
      else if (state.status === "pending") warnings.push(`节点 ${state.nodeName} 尚未上报缓存指标，等 Agent 完成心跳后再检查`);
      else if (state.status === "stale" && stats) warnings.push(`节点 ${state.nodeName} 的缓存指标已过期（${Math.floor(Math.max(0, Date.now() - Date.parse(stats.collectedAt)) / 60_000)} 分钟前采集），该节点可能离线`);
      if (state.status !== "ready" || !stats) continue;
      if (stats.capacityBytes > 0 && stats.usedBytes >= stats.capacityBytes) warnings.push(`节点 ${state.nodeName} 的缓存已用满 ${formatBytes(stats.capacityBytes)}，新内容会按 LRU 淘汰旧条目`);
      if (stats.diskFreeBytes !== null && stats.diskFreeBytes !== undefined && stats.diskFreeBytes < NETWORK_CACHE_DISK_WARNING_BYTES) warnings.push(`节点 ${state.nodeName} 缓存所在磁盘剩余 ${formatBytes(stats.diskFreeBytes)}，低于保留水位后新的下载会被拒绝`);
    }
    return warnings.slice(0, 20);
  }

  /** Same shape as the mesh plan: one Controller timestamp, ages computed server-side. */
  async plan(): Promise<NetworkCachePlanResponse> {
    const now = new Date();
    const nodes = (await this.repository.read({ sections: ["nodes"] })).nodes;
    const nodeStates = this.project(nodes, now);
    return { updatedAt: now.toISOString(), nodes: nodeStates, warnings: this.warnings(nodeStates) };
  }
}
