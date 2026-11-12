import type { HostMonitoringRecord } from "../../api/hostsApi";

type HostStatus = "健康" | "警告" | "等待采集" | "待连接" | "离线";
type HostServiceView = { id: string; name: string; target: string; status: "健康" | "警告" | "未知"; detail: string };
type HostVolumeView = { label: string; mount: string; totalBytes: number; usedBytes: number; percent: number };

type HostView = {
  id: string;
  name: string;
  ip: string;
  env: string;
  owner: string;
  platform: string;
  source: "controller" | "agent";
  connectionStatus: HostMonitoringRecord["connectionStatus"];
  connectionLabel: "本机" | "待连接" | "在线" | "离线";
  telemetryFreshness: HostMonitoringRecord["telemetryFreshness"];
  status: HostStatus;
  cpu: number | null;
  memory: number | null;
  disk: number | null;
  memoryUsedBytes: number | null;
  memoryTotalBytes: number | null;
  diskUsedBytes: number | null;
  diskTotalBytes: number | null;
  version: string;
  uptime: string;
  backup: string;
  backupStatus: "健康" | "警告" | "未知";
  update: string;
  latency: string;
  collectedAt: string | null;
  lastSeenAt: string | null;
  services: HostServiceView[];
  diskVolumes: HostVolumeView[];
};

function formatBytes(bytes: number | null) {
  if (bytes === null || !Number.isFinite(bytes)) return "不可用";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value.toFixed(unit < 3 ? 0 : 1)} ${units[unit]}`;
}

function formatUptime(seconds: number | null) {
  if (seconds === null) return "不可用";
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  return days > 0 ? `${days} 天 ${hours} 小时` : `${hours} 小时`;
}

function formatTimestamp(value: string | null) {
  if (!value) return "等待采集";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).format(date);
}

function percent(total: number, used: number, provided?: number | null) {
  if (provided !== undefined && provided !== null) return provided;
  return total > 0 ? Math.round((used / total) * 100) : 0;
}

function statusOf(record: HostMonitoringRecord): HostStatus {
  if (record.connectionStatus === "pending") return "待连接";
  if (record.connectionStatus === "offline") return "离线";
  if (record.healthStatus === "degraded") return "警告";
  if (record.telemetryFreshness === "awaiting") return "等待采集";
  if (record.healthStatus === "healthy") return "健康";
  return "等待采集";
}

function connectionLabel(status: HostMonitoringRecord["connectionStatus"]): HostView["connectionLabel"] {
  if (status === "local") return "本机";
  if (status === "pending") return "待连接";
  if (status === "online") return "在线";
  return "离线";
}

function serviceStatus(status: string): HostServiceView["status"] {
  if (["healthy", "active", "running"].includes(status)) return "健康";
  if (["degraded", "failed", "inactive", "stopped"].includes(status)) return "警告";
  return "未知";
}

function toHostView(record: HostMonitoringRecord): HostView {
  const memory = record.memory;
  const disk = record.disk;
  const volumes = disk?.volumes ?? [];
  const volumeTotalBytes = volumes.reduce((total, volume) => total + volume.totalBytes, 0);
  const volumeUsedBytes = volumes.reduce((total, volume) => total + volume.usedBytes, 0);
  const memoryUsedBytes = memory?.usedBytes ?? null;
  const backupStatus = record.backup?.status === "healthy" ? "健康" : record.backup?.status === "degraded" ? "警告" : "未知";
  return {
    id: record.id,
    name: record.name,
    ip: record.address ?? "不可用",
    env: record.environment ?? "未分类",
    owner: record.owner ?? "未分配",
    platform: record.platform,
    source: record.source,
    connectionStatus: record.connectionStatus,
    connectionLabel: connectionLabel(record.connectionStatus),
    telemetryFreshness: record.telemetryFreshness,
    status: statusOf(record),
    cpu: record.cpuPercent,
    memory: memory?.percent ?? null,
    disk: volumeTotalBytes > 0 ? Math.round(volumeUsedBytes / volumeTotalBytes * 100) : disk?.percent ?? null,
    memoryUsedBytes,
    memoryTotalBytes: memory?.totalBytes ?? null,
    diskUsedBytes: volumeTotalBytes > 0 ? volumeUsedBytes : disk?.usedBytes ?? null,
    diskTotalBytes: volumeTotalBytes > 0 ? volumeTotalBytes : disk?.totalBytes ?? null,
    version: record.version ?? "不可用",
    uptime: formatUptime(record.uptimeSeconds),
    backup: record.backup ? (record.backup.latestAt ? formatTimestamp(record.backup.latestAt) : record.backup.detail) : "不可用",
    backupStatus,
    update: record.updateStatus ?? "不可用",
    latency: record.latency === null ? "不可用" : `${Math.round(record.latency)}ms`,
    collectedAt: record.telemetryCollectedAt,
    lastSeenAt: record.lastSeenAt,
    services: (record.services ?? []).map((service, index) => ({
      id: `${record.id}-service-${index}`,
      name: service.name,
      target: record.name,
      status: serviceStatus(service.status),
      detail: service.status,
    })),
    diskVolumes: (disk?.volumes ?? []).map((volume) => ({
      label: volume.label,
      mount: volume.mountPath,
      totalBytes: volume.totalBytes,
      usedBytes: volume.usedBytes,
      percent: percent(volume.totalBytes, volume.usedBytes, volume.percent),
    })),
  };
}

function metricText(value: number | null) { return value === null ? "等待采集" : `${Math.round(value)}%`; }
function metricAria(label: string, value: number | null) { return `${label} ${metricText(value)}`; }

export { formatBytes, formatTimestamp, metricAria, metricText, toHostView };
export type { HostServiceView, HostStatus, HostView, HostVolumeView };
