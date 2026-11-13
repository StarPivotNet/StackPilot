import { AlertTriangle, CheckCircle2, CircleSlash, Timer } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { NetworkCacheNodeState, NetworkCachePlanResponse } from "@stackpilot/contracts";
import type { Tone } from "../../types/app";
import { formatBackendDateTime } from "../../utils/time";

type CacheNodeView = {
  nodeId: string;
  nodeName: string;
  status: NetworkCacheNodeState["status"];
  statusLabel: string;
  statusTone: Tone;
  statusIcon: LucideIcon;
  usageLabel: string;
  entryLabel: string;
  hitRateLabel: string;
  hitLabel: string;
  evictionLabel: string;
  collectedLabel: string;
  diskFreeLabel: string;
};

type CacheView = {
  updatedAt: string;
  nodes: CacheNodeView[];
  warnings: string[];
  readyCount: number;
  reportingCount: number;
  participantCount: number;
  usedBytes: number;
  capacityBytes: number;
  usageLabel: string;
  entryCount: number;
  hits: number;
  misses: number;
  evictions: number;
  hitRateLabel: string;
  hitLabel: string;
};

const statusMeta: Record<NetworkCacheNodeState["status"], { label: string; tone: Tone; icon: LucideIcon }> = {
  ready: { label: "就绪", tone: "green", icon: CheckCircle2 },
  stale: { label: "指标过期", tone: "orange", icon: AlertTriangle },
  pending: { label: "待上报", tone: "blue", icon: Timer },
  disabled: { label: "未授权", tone: "gray", icon: CircleSlash },
};

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(1)} GB`;
}

/** Counters live in the cache index and survive restarts, so an empty pair means "no sample", not 0%. */
function hitRateLabel(hits: number, misses: number) {
  const samples = hits + misses;
  return samples === 0 ? "暂无样本" : `${Math.round((hits / samples) * 100)}%`;
}

function toCacheView(plan: NetworkCachePlanResponse): CacheView {
  const nodes = plan.nodes.map((node): CacheNodeView => {
    const stats = node.stats;
    const meta = statusMeta[node.status];
    return {
      nodeId: node.nodeId,
      nodeName: node.nodeName,
      status: node.status,
      statusLabel: meta.label,
      statusTone: meta.tone,
      statusIcon: meta.icon,
      usageLabel: stats ? `${formatBytes(stats.usedBytes)} / ${formatBytes(stats.capacityBytes)}` : "等待上报",
      entryLabel: stats ? `${stats.entryCount} 条` : "未上报",
      hitRateLabel: stats ? hitRateLabel(stats.hits, stats.misses) : "等待上报",
      hitLabel: stats ? `${stats.hits} 次命中 / ${stats.misses} 次回源` : "等待上报",
      evictionLabel: stats ? `${stats.evictions} 条` : "未上报",
      collectedLabel: stats ? formatBackendDateTime(stats.collectedAt) : "未上报",
      diskFreeLabel: stats?.diskFreeBytes === null || stats?.diskFreeBytes === undefined ? "未知" : formatBytes(stats.diskFreeBytes),
    };
  });
  const reporting = plan.nodes.filter((node) => node.stats !== null).map((node) => node.stats!);
  const usedBytes = reporting.reduce((sum, stats) => sum + stats.usedBytes, 0);
  const capacityBytes = reporting.reduce((sum, stats) => sum + stats.capacityBytes, 0);
  const hits = reporting.reduce((sum, stats) => sum + stats.hits, 0);
  const misses = reporting.reduce((sum, stats) => sum + stats.misses, 0);
  return {
    updatedAt: plan.updatedAt,
    nodes,
    warnings: plan.warnings,
    readyCount: nodes.filter((node) => node.status === "ready").length,
    reportingCount: reporting.length,
    // A node without the capability is listed for the operator but is not part of the cache pool.
    participantCount: nodes.filter((node) => node.status !== "disabled").length,
    usedBytes,
    capacityBytes,
    usageLabel: reporting.length === 0 ? "等待首个节点上报" : `${formatBytes(usedBytes)} / ${formatBytes(capacityBytes)}`,
    entryCount: reporting.reduce((sum, stats) => sum + stats.entryCount, 0),
    hits,
    misses,
    evictions: reporting.reduce((sum, stats) => sum + stats.evictions, 0),
    hitRateLabel: reporting.length === 0 ? "等待上报" : hitRateLabel(hits, misses),
    hitLabel: reporting.length === 0 ? "等待上报" : `${hits} 次命中 / ${misses} 次回源`,
  };
}

export { toCacheView };
export type { CacheNodeView, CacheView };
