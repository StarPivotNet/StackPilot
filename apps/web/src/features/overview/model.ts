import type { OverviewMetricIcon, OverviewNode, OverviewService, OverviewSummaryPayload, OverviewTaskPageData, OverviewTaskRecord } from "../../api/overviewApi";
import { Bell, CalendarDays, Database, Globe2, Server, Shield } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { Notify, Tone } from "../../types/app";

const overviewMetricIcons: Record<OverviewMetricIcon, LucideIcon> = {
  server: Server,
  globe: Globe2,
  database: Database,
  calendar: CalendarDays,
  shield: Shield,
  bell: Bell,
};

function reportApiError(error: unknown, notify: Notify, fallback = "后端请求失败") {
  notify(error instanceof Error ? error.message : fallback, "danger");
}

function serviceTone(status: OverviewService["status"]): Tone {
  if (status === "健康") return "green";
  if (status === "警告") return "orange";
  return "red";
}

function healthProbeTone(status: "健康" | "警告"): Tone {
  return status === "健康" ? "green" : "orange";
}

function serviceHealthTone(services: OverviewService[]): Tone {
  if (services.some((service) => service.status === "离线")) return "red";
  if (services.some((service) => service.status === "警告")) return "orange";
  return services.length ? "green" : "gray";
}

function serviceHealthLabel(services: OverviewService[]) {
  if (services.length === 0) return "未发现服务";
  const healthyCount = services.filter((service) => service.status === "健康").length;
  return `${healthyCount}/${services.length} 健康`;
}

function taskTone(status: OverviewTaskRecord["status"]): Tone {
  if (status === "成功") return "green";
  if (status === "运行中") return "blue";
  if (status === "失败") return "red";
  return "orange";
}

function emptyTaskPageData(): OverviewTaskPageData {
  return {
    title: "任务流",
    subtitle: "正在从后端加载任务流。",
    searchPlaceholder: "搜索后端返回的任务",
    filters: [],
    metrics: [],
    context: { eyebrow: "工作台 / 任务流", title: "任务流", chips: [] },
    collectedAt: "",
  };
}

function emptyOverviewSummary(): OverviewSummaryPayload {
  return {
    cluster: { current: "", health: "维护", latency: "-", version: "-", uptime: "-", lastBackup: "-", pendingUpdates: 0 },
    metrics: [],
    nodes: [],
    tasks: [],
    taskPage: emptyTaskPageData(),
    audits: [],
    risks: [],
    resources: {},
    collectedAt: new Date(0).toISOString(),
    lastRefresh: "",
  };
}

const overviewNodeFreshness = (node: OverviewNode) => node.freshness;
const overviewNodeCollectedAt = (node: OverviewNode) => node.collectedAt;
const overviewNodeFieldAvailable = (node: OverviewNode, field: keyof OverviewNode["availability"]) => node.availability[field];

function overviewNodeDisk(node: OverviewNode) {
  const volumes = (node.diskVolumes ?? []).map((volume) => ({ ...volume, percent: volume.totalBytes > 0 ? Math.round(volume.usedBytes / volume.totalBytes * 1000) / 10 : 0 }));
  const total = volumes.reduce((sum, volume) => sum + volume.totalBytes, 0);
  const used = volumes.reduce((sum, volume) => sum + volume.usedBytes, 0);
  return { volumes, total, used, value: total > 0 ? `${Math.round(used / total * 1000) / 10}%` : node.disk };
}

function formatOverviewBytes(bytes: number) {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const index = bytes > 0 ? Math.max(0, Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)) : 0;
  return `${new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(bytes / 1024 ** index)} ${units[index]}`;
}

export { emptyOverviewSummary, emptyTaskPageData, formatOverviewBytes, healthProbeTone, overviewMetricIcons, overviewNodeCollectedAt, overviewNodeDisk, overviewNodeFieldAvailable, overviewNodeFreshness, reportApiError, serviceHealthLabel, serviceHealthTone, serviceTone, taskTone };
