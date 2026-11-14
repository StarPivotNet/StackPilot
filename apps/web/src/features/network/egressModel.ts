import { CheckCircle2, CircleSlash, Clock, Loader, WifiOff } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { NetworkEgressDisabledReason, NetworkEgressNode, NetworkEgressPlanResponse } from "@stackpilot/contracts";
import type { Tone } from "../../types/app";
import { formatBackendDateTime } from "../../utils/time";

/** Local copy: the web architecture test forbids one feature importing another's helpers. */
function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"]; let value = bytes / 1024; let index = 0;
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index += 1; }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

const STATUS: Record<NetworkEgressNode["status"], { label: string; tone: Tone; icon: LucideIcon }> = {
  ready: { label: "可作出口", tone: "green", icon: CheckCircle2 },
  stale: { label: "样本过期", tone: "orange", icon: Clock },
  pending: { label: "待探测", tone: "blue", icon: Loader },
  disabled: { label: "不参与选路", tone: "gray", icon: CircleSlash },
  offline: { label: "已离线", tone: "red", icon: WifiOff },
};

/** Four causes, four fixes: a grant, an Agent declaration, a mesh join, or nothing (the node is gone). */
const DISABLED: Record<NetworkEgressDisabledReason, string> = {
  revoked: "节点已撤销",
  "no-overlay": "未加入组网",
  "not-allowed": "未授予出口",
  "not-declared": "未声明出口",
};

type Sample = NetworkEgressNode["samples"][number];

export type EgressNodeView = {
  nodeId: string;
  nodeName: string;
  statusLabel: string;
  statusTone: Tone;
  statusIcon: LucideIcon;
  addressLabel: string;
  ttfbLabel: string;
  rateLabel: string;
  sampleLabel: string;
};

export type EgressView = {
  updatedLabel: string;
  freshestLabel: string;
  headlineLabel: string;
  readyCount: number;
  nodes: EgressNodeView[];
  warnings: string[];
};

/**
 * The node's best source: highest measured throughput, and on a tie the lower time to first byte.
 * A node with no sample is not a node with a zero score, so it keeps "未测出" instead of 0 B/s.
 */
function bestSample(samples: Sample[]): Sample | null {
  return samples.reduce<Sample | null>((best, sample) => {
    if (best === null) return sample;
    if (sample.bytesPerSecond !== best.bytesPerSecond) return sample.bytesPerSecond > best.bytesPerSecond ? sample : best;
    return sample.ttfbMs < best.ttfbMs ? sample : best;
  }, null);
}

/** The Controller sends the age it computed; the browser never subtracts its own clock. */
function ageLabel(ageSeconds: number) {
  if (ageSeconds < 60) return `${ageSeconds} 秒前`;
  if (ageSeconds < 3600) return `${Math.round(ageSeconds / 60)} 分钟前`;
  return `${Math.round(ageSeconds / 3600)} 小时前`;
}

function ttfbLabel(sample: Sample | null) {
  if (sample === null) return "未测出";
  return sample.ttfbMs >= 1000 ? `${(sample.ttfbMs / 1000).toFixed(1)} s` : `${sample.ttfbMs} ms`;
}

function toEgressNodeView(node: NetworkEgressNode): EgressNodeView {
  const status = STATUS[node.status];
  const best = bestSample(node.samples);
  return {
    nodeId: node.nodeId,
    nodeName: node.nodeName,
    // The generic word survives only for a payload that does not say which piece is missing.
    statusLabel: node.status === "disabled" && node.disabledReason !== null ? DISABLED[node.disabledReason] : status.label,
    statusTone: status.tone,
    statusIcon: status.icon,
    // A node without an overlay assignment cannot be reached even if its samples look good.
    addressLabel: node.overlayAddress === null || node.dataPlanePort === null ? "未分配" : `${node.overlayAddress}:${node.dataPlanePort}`,
    ttfbLabel: ttfbLabel(best),
    rateLabel: best === null ? "未测出" : `${formatBytes(best.bytesPerSecond)}/s`,
    // Count and freshness share one cell: neither means much without the other.
    sampleLabel: best === null ? "无样本" : `${node.samples.length} 个源 · ${ageLabel(best.ageSeconds)}`,
  };
}

export function toEgressView(payload: NetworkEgressPlanResponse): EgressView {
  const nodes = payload.nodes.map(toEgressNodeView);
  const readyCount = payload.nodes.filter((node) => node.status === "ready").length;
  // The newest probe, not the response time: `updatedAt` moves on every read, a sample does not.
  const ages = payload.nodes.flatMap((node) => node.samples.map((sample) => sample.ageSeconds));
  return {
    updatedLabel: formatBackendDateTime(payload.updatedAt),
    freshestLabel: ages.length === 0 ? "无样本" : ageLabel(Math.min(...ages)),
    headlineLabel: nodes.length === 0 ? "还没有节点上报出口样本" : `${readyCount} / ${nodes.length} 个节点可作出口`,
    readyCount,
    nodes,
    // Why the table is empty or degraded is the Controller's own sentence; the panel never re-derives it.
    warnings: payload.warnings,
  };
}
