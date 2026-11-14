import { AlertTriangle, CheckCircle2, CircleSlash, Clock, Loader } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { NetworkCacheDownloadJob, NetworkCacheDownloadJobListResponse } from "@stackpilot/contracts";
import type { Tone } from "../../types/app";
import { formatBackendDateTime } from "../../utils/time";

/** Local copy: the web architecture test forbids one feature importing another's helpers. */
function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"]; let value = bytes / 1024; let index = 0;
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index += 1; }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

/**
 * Failure codes an operator can act on. An unmapped code is shown verbatim: guessing a friendlier
 * sentence for a code nobody has seen yet is worse than the code itself.
 */
const FAILURE_LABELS: Record<string, string> = {
  CACHE_ORIGIN_ERROR: "源站拒绝请求",
  CACHE_ORIGIN_EMPTY: "源站没有返回内容",
  CACHE_TOO_LARGE: "对象超过大小上限",
  CACHE_DIGEST_MISMATCH: "内容校验不符",
  CACHE_DISK_LOW: "磁盘余量不足",
  CACHE_RANGE_UNSUPPORTED: "源站不支持分片",
  CACHE_SEGMENT_NO_SOURCE: "没有可信的分片来源",
  CACHE_SEGMENT_PART_FAILED: "分片重试后仍失败",
  CACHE_SEGMENT_STALLED: "分片传输停滞",
  CACHE_TRANSFER_STALLED: "传输停滞（长时间无进展）",
  CACHE_FETCH_CANCELLED: "传输已取消",
  CACHE_FETCH_FAILED: "传输失败",
  EGRESS_UNAVAILABLE: "出口节点不可用",
  EGRESS_DIGEST_MISMATCH: "出口节点内容不符",
  TASK_EXPIRED: "任务超时未完成",
  TASK_CANCELLED_OR_TIMEOUT: "执行超时",
  CANCELLED_BY_REQUESTER: "已由操作者取消",
  RESULT_UNKNOWN: "结果未知，需重新拉取",
};

const STATUS: Record<NetworkCacheDownloadJob["status"], { label: string; tone: Tone; icon: LucideIcon }> = {
  queued: { label: "排队中", tone: "gray", icon: Clock },
  dispatched: { label: "已下发", tone: "blue", icon: Loader },
  running: { label: "传输中", tone: "blue", icon: Loader },
  succeeded: { label: "已完成", tone: "green", icon: CheckCircle2 },
  failed: { label: "失败", tone: "red", icon: AlertTriangle },
  cancelled: { label: "已取消", tone: "gray", icon: CircleSlash },
  expired: { label: "已过期", tone: "orange", icon: Clock },
};

export type DownloadPartView = {
  key: string;
  label: string;
  rateLabel: string;
};

export type DownloadJobView = {
  taskId: string;
  nodeName: string;
  host: string;
  url: string;
  status: NetworkCacheDownloadJob["status"];
  statusLabel: string;
  statusTone: Tone;
  statusIcon: LucideIcon;
  live: boolean;
  progressLabel: string;
  percent: number | null;
  rateLabel: string;
  routeLabel: string;
  originLabel: string;
  segmentCount: number;
  partsLabel: string;
  /** Live per-part rates for a segmented pull; empty for a direct fill or a finished job. */
  parts: DownloadPartView[];
  resumedLabel: string | null;
  failureLabel: string | null;
  retryable: boolean;
  attemptLabel: string;
  updatedLabel: string;
};

export type DownloadTrafficRowView = {
  nodeId: string;
  nodeName: string;
  receivedLabel: string;
  originLabel: string;
  servedLabel: string;
  statusLabel: string;
  statusTone: Tone;
  statusIcon: LucideIcon;
  overQuota: boolean;
};

export type DownloadTrafficView = {
  monthLabel: string;
  quotaLabel: string;
  headlineLabel: string;
  receivedLabel: string;
  servedLabel: string;
  degradedCount: number;
  degradedLabel: string | null;
  rows: DownloadTrafficRowView[];
};

export type DownloadJobsView = {
  collectedAt: string;
  collectedLabel: string;
  jobs: DownloadJobView[];
  runningCount: number;
  failedCount: number;
  succeededCount: number;
  segmentedCount: number;
  traffic: DownloadTrafficView;
};

export const failureLabel = (code: string | null) => (code === null ? null : FAILURE_LABELS[code] ?? code);

function routeLabel(job: NetworkCacheDownloadJob) {
  // An unknown hit state is not a miss: the Agent has not reported yet.
  if (job.hit === null) return "等待结果";
  if (job.hit) return "缓存命中";
  if (job.segmented) return `分片 ${job.segmentSources} 路`;
  return job.viaEgress ? "经出口节点" : "直接回源";
}

function progressLabel(job: NetworkCacheDownloadJob) {
  const received = formatBytes(job.bytesReceived);
  return job.totalBytes === null ? `${received} / 未知大小` : `${received} / ${formatBytes(job.totalBytes)}`;
}

function percent(job: NetworkCacheDownloadJob) {
  if (job.totalBytes === null || job.totalBytes <= 0) return null;
  return Math.min(100, Math.round((job.bytesReceived / job.totalBytes) * 100));
}

/** A part's own line: its share of the object means nothing alone, so the rate is the point. */
function toPartView(part: NetworkCacheDownloadJob["parts"][number]): DownloadPartView {
  const done = part.totalBytes > 0 && part.bytes >= part.totalBytes;
  return {
    key: `${part.index}:${part.sourceNodeId}`,
    label: `片 ${part.index + 1}`,
    // A finished part keeps its last sampled rate forever; saying it is done is the honest reading.
    rateLabel: done ? "已完成" : part.bytesPerSecond === null ? "等待速率" : `${formatBytes(Math.round(part.bytesPerSecond))}/s`,
  };
}

export function toDownloadJobView(job: NetworkCacheDownloadJob): DownloadJobView {
  const status = STATUS[job.status];
  const live = job.status === "queued" || job.status === "dispatched" || job.status === "running";
  return {
    taskId: job.taskId,
    nodeName: job.nodeName ?? "未知节点",
    host: job.host,
    url: job.url,
    status: job.status,
    statusLabel: status.label,
    statusTone: status.tone,
    statusIcon: status.icon,
    live,
    progressLabel: progressLabel(job),
    percent: percent(job),
    // A finished job without a rate carried no bytes over the network, so it has none to show.
    rateLabel: job.bytesPerSecond === null ? (live ? "等待速率" : "—") : `${formatBytes(Math.round(job.bytesPerSecond))}/s`,
    routeLabel: routeLabel(job),
    originLabel: job.originBytes === null ? "—" : `回源 ${formatBytes(job.originBytes)}`,
    segmentCount: job.segmentCount,
    partsLabel: job.partsTotal > 0 ? `${job.partsDone} / ${job.partsTotal} 片` : job.segmentCount > 0 ? `${job.segmentCount} 片` : "—",
    parts: job.parts.map(toPartView),
    resumedLabel: job.resumedBytes > 0 ? `续传 ${formatBytes(job.resumedBytes)}` : null,
    failureLabel: failureLabel(job.failureReason),
    retryable: job.retryable,
    attemptLabel: job.attempt > 0 ? `第 ${job.attempt} 次尝试` : "尚未下发",
    updatedLabel: formatBackendDateTime(job.updatedAt),
  };
}

function toDownloadTrafficView(traffic: NetworkCacheDownloadJobListResponse["traffic"]): DownloadTrafficView {
  const rows = traffic.nodes.map((node) => {
    // Zero quota means the meter records and nothing is restricted, so no node is ever degraded.
    const overQuota = node.degraded;
    return {
      nodeId: node.nodeId,
      nodeName: node.nodeName ?? "未知节点",
      receivedLabel: formatBytes(node.receivedBytes),
      originLabel: formatBytes(node.originBytes),
      servedLabel: formatBytes(node.servedBytes),
      statusLabel: overQuota ? "已停用加速" : traffic.quotaBytes > 0 ? "额度内" : "仅计量",
      statusTone: (overQuota ? "orange" : "green") as Tone,
      statusIcon: overQuota ? AlertTriangle : CheckCircle2,
      overQuota,
    };
  });
  const totalReceived = traffic.nodes.reduce((total, node) => total + node.receivedBytes, 0);
  const totalServed = traffic.nodes.reduce((total, node) => total + node.servedBytes, 0);
  const degraded = rows.filter((row) => row.overQuota);
  return {
    // The Controller's clock decides the billing month, never the browser's.
    monthLabel: `${traffic.monthStart.slice(0, 7)} 计费月`,
    quotaLabel: traffic.quotaBytes > 0 ? `每节点上限 ${formatBytes(traffic.quotaBytes)}` : "未设月度上限",
    headlineLabel: rows.length === 0 ? "本月还没有节点流量" : `${rows.length} 个节点本月下行 ${formatBytes(totalReceived)}`,
    receivedLabel: formatBytes(totalReceived),
    servedLabel: formatBytes(totalServed),
    degradedCount: degraded.length,
    degradedLabel: degraded.length === 0 ? null
      : `${degraded.map((row) => row.nodeName).join("、")} 本月已用超过上限，分片并行与出口委派已停用；缓存命中与直取不受影响`,
    rows,
  };
}

export function toDownloadJobsView(payload: NetworkCacheDownloadJobListResponse): DownloadJobsView {
  const jobs = payload.jobs.map(toDownloadJobView);
  return {
    collectedAt: payload.collectedAt,
    collectedLabel: formatBackendDateTime(payload.collectedAt),
    jobs,
    runningCount: jobs.filter((job) => job.live).length,
    failedCount: jobs.filter((job) => job.status === "failed" || job.status === "expired").length,
    succeededCount: jobs.filter((job) => job.status === "succeeded").length,
    segmentedCount: jobs.filter((job) => job.segmentCount > 0).length,
    traffic: toDownloadTrafficView(payload.traffic),
  };
}
