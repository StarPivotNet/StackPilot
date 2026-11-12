import { platform as runtimePlatform } from "node:os";
import { HostMonitoringPayloadSchema } from "@stackpilot/contracts";
import type { AgentPlatform, AgentTelemetrySnapshot, HostMonitoringPayload, HostMonitoringRecord } from "@stackpilot/contracts";
import type { PlatformAdapter, PlatformSnapshot } from "../../platform/types.js";
import type { AgentControlRepository, AgentNodeState } from "../../repositories/agentControlRepository.js";
import type { NodeScope } from "@stackpilot/contracts";
import { hasResourceWarning } from "../../platform/resourceHealth.js";
import { agentControlState, controllerMirrorAgents } from "../nodes/physicalHostIdentity.js";

const LOCAL_ENVIRONMENT = "本机";
const PRODUCTION_ENVIRONMENT = "生产";
const LOCAL_OWNER = "Controller";

function percentage(used: number, total: number) {
  return total > 0 ? Math.min(100, Math.max(0, Math.round(used / total * 1000) / 10)) : 0;
}

function safeByteSum(values: number[]) {
  const total = values.reduce((sum, value) => sum + value, 0);
  return Number.isSafeInteger(total) ? total : null;
}

function nullableAddress(value: string) {
  const address = value.trim();
  return address && !["暂不可用", "不可用", "未知"].includes(address) ? address : null;
}

function controllerPlatform(): AgentPlatform {
  const current = runtimePlatform();
  return current === "win32" || current === "darwin" ? current : "linux";
}

function localRecord(snapshot: PlatformSnapshot, production: boolean): HostMonitoringRecord {
  const totalMemoryBytes = snapshot.totalMemoryBytes;
  const availableMemoryBytes = snapshot.availableMemoryBytes;
  const totalDiskBytes = safeByteSum(snapshot.disks.map((volume) => volume.totalBytes));
  const usedDiskBytes = safeByteSum(snapshot.disks.map((volume) => volume.usedBytes));
  const diskAvailable = snapshot.node.availability.disk && totalDiskBytes !== null && usedDiskBytes !== null && totalDiskBytes > 0;
  const latency = Number.parseFloat(snapshot.node.latency);
  return {
    id: snapshot.node.id,
    source: "controller",
    name: snapshot.node.name,
    platform: controllerPlatform(),
    address: nullableAddress(snapshot.node.ip),
    environment: production ? PRODUCTION_ENVIRONMENT : LOCAL_ENVIRONMENT,
    owner: snapshot.node.owner || LOCAL_OWNER,
    connectionStatus: "local",
    healthStatus: snapshot.node.status === "健康" && snapshot.node.availability.cpu && snapshot.node.availability.memory && diskAvailable ? "healthy" : "degraded",
    telemetryFreshness: "current",
    telemetryCollectedAt: snapshot.node.collectedAt,
    lastSeenAt: snapshot.node.collectedAt,
    cpuPercent: snapshot.node.availability.cpu ? snapshot.cpuPercent : null,
    memory: snapshot.node.availability.memory && totalMemoryBytes > 0 ? { totalBytes: totalMemoryBytes, usedBytes: totalMemoryBytes - Math.min(totalMemoryBytes, availableMemoryBytes), percent: snapshot.memoryPercent } : null,
    disk: diskAvailable ? {
      totalBytes: totalDiskBytes,
      usedBytes: usedDiskBytes,
      percent: percentage(usedDiskBytes, totalDiskBytes),
      volumes: snapshot.disks.map((volume) => ({ label: volume.label, mountPath: volume.mount, totalBytes: volume.totalBytes, usedBytes: volume.usedBytes, percent: volume.percent })),
    } : null,
    uptimeSeconds: parseUptime(snapshot.node.uptime),
    backup: { status: snapshot.node.backupStatus === "健康" ? "healthy" : "degraded", latestAt: null, detail: snapshot.node.backup },
    services: snapshot.node.services.slice(0, 20).map((service) => ({ name: service.id, status: service.status === "健康" ? "running" : "stopped" })),
    version: snapshot.version,
    latency: Number.isFinite(latency) ? latency : null,
    updateStatus: snapshot.node.update || null,
  };
}

function parseUptime(value: string) {
  const hours = Number(value.match(/(\d+)\s*小时/)?.[1] ?? 0);
  const minutes = Number(value.match(/(\d+)\s*分钟/)?.[1] ?? 0);
  return hours * 3600 + minutes * 60;
}

function aggregateDisk(telemetry: AgentTelemetrySnapshot) {
  const totalBytes = safeByteSum(telemetry.disks.map((volume) => volume.totalBytes));
  const usedBytes = safeByteSum(telemetry.disks.map((volume) => volume.usedBytes));
  if (!totalBytes || usedBytes === null) return null;
  return {
    totalBytes, usedBytes, percent: percentage(usedBytes, totalBytes),
    volumes: telemetry.disks.map((volume) => ({ label: volume.label, mountPath: volume.mount, totalBytes: volume.totalBytes, usedBytes: volume.usedBytes, percent: percentage(volume.usedBytes, volume.totalBytes) })),
  };
}

function remoteHealth(telemetry: AgentTelemetrySnapshot | undefined): "healthy" | "degraded" | "unknown" {
  if (!telemetry) return "unknown";
  const memory = telemetry.memory ? percentage(telemetry.memory.totalBytes - telemetry.memory.availableBytes, telemetry.memory.totalBytes) : null;
  const disk = aggregateDisk(telemetry)?.percent ?? null;
  return hasResourceWarning({ cpu: telemetry.cpu?.usagePercent ?? null, memory, disk }) ? "degraded" : "healthy";
}

function remoteRecord(node: AgentNodeState, now: number, offlineAfterMs: number): HostMonitoringRecord {
  const telemetry = node.telemetry;
  const heartbeatStale = node.lastSeenAt !== null && now - Date.parse(node.lastSeenAt) > offlineAfterMs;
  const telemetryStale = Boolean(telemetry && now - Date.parse(telemetry.collectedAt) > offlineAfterMs);
  const freshness = !telemetry ? "awaiting" : heartbeatStale || telemetryStale ? "stale" : "current";
  const connectionStatus = node.lastSeenAt === null ? "pending" : heartbeatStale || node.status === "offline" ? "offline" : "online";
  return {
    id: node.nodeId,
    source: "agent",
    name: telemetry?.hostname ?? node.nodeName,
    platform: node.platform,
    address: telemetry?.primaryIp ?? null,
    environment: "未分类",
    owner: "未分配",
    connectionStatus,
    healthStatus: node.heartbeatHealthStatus === "degraded" || freshness === "stale" ? "degraded" : freshness === "current" ? remoteHealth(telemetry) : "unknown",
    telemetryFreshness: freshness,
    telemetryCollectedAt: telemetry?.collectedAt ?? null,
    lastSeenAt: node.lastSeenAt,
    cpuPercent: telemetry?.cpu?.usagePercent ?? null,
    memory: telemetry?.memory ? { totalBytes: telemetry.memory.totalBytes, usedBytes: telemetry.memory.totalBytes - telemetry.memory.availableBytes, percent: percentage(telemetry.memory.totalBytes - telemetry.memory.availableBytes, telemetry.memory.totalBytes) } : null,
    disk: telemetry ? aggregateDisk(telemetry) : null,
    uptimeSeconds: telemetry?.uptimeSeconds ?? null,
    backup: null,
    services: [],
    version: node.agentVersion,
    latency: null,
    updateStatus: null,
  };
}

export class HostMonitoringService {
  constructor(
    private readonly platform: PlatformAdapter,
    private readonly repository: AgentControlRepository,
    private readonly offlineAfterMs = 45_000,
    private readonly production = false,
  ) {}

  async getHosts(includeAgents: boolean, nodeScope: NodeScope): Promise<HostMonitoringPayload> {
    const snapshot = await this.platform.collectSnapshot();
    const local = localRecord(snapshot, this.production);
    const hosts = [local];
    if (includeAgents) {
      const state = await this.repository.read({ sections: ["nodes"] });
      const allowed = nodeScope === "all" ? state.nodes : state.nodes.filter((node) => nodeScope.includes(node.nodeId));
      const active = allowed.filter((node) => !node.revokedAt && node.status !== "revoked");
      const activeIds = new Set(active.map((node) => node.nodeId));
      const mirrorNodes = controllerMirrorAgents(snapshot, state.nodes.filter((node) => !node.revokedAt && node.status !== "revoked"))
        .filter((node) => activeIds.has(node.nodeId));
      const mirrors = new Set(mirrorNodes.map((node) => node.nodeId));
      const mirror = mirrorNodes[0];
      if (mirror) {
        const control = agentControlState(mirror, Date.now(), this.offlineAfterMs);
        hosts[0] = {
          ...local,
          healthStatus: control.healthy ? local.healthStatus : "degraded",
          owner: `${local.owner} · Agent ${mirror.agentVersion}`,
          services: [...local.services, { name: "StackPilot Agent 控制通道", status: control.healthy ? "running" : "stopped" }],
        };
      }
      hosts.push(...allowed
        .filter((node) => !node.revokedAt && node.status !== "revoked")
        .filter((node) => !mirrors.has(node.nodeId))
        .map((node) => remoteRecord(node, Date.now(), this.offlineAfterMs)));
    }
    const collectedAt = new Date().toISOString();
    return HostMonitoringPayloadSchema.parse({ collectedAt, hosts });
  }
}
