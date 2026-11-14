import { OverviewSummaryPayloadSchema } from "@stackpilot/contracts";
import type {
  AgentTelemetrySnapshot, OverviewNode, OverviewResourceRecord, OverviewRiskRecord,
  OverviewSummaryPayload, OverviewTaskRecord, RemoteTaskRecord,
} from "@stackpilot/contracts";
import type { PlatformAdapter, PlatformSnapshot } from "../../platform/types.js";
import { hasResourceWarning, RESOURCE_THRESHOLDS } from "../../platform/resourceHealth.js";
import type { AgentControlRepository, AgentNodeState, AuditEvent } from "../../repositories/agentControlRepository.js";
import { MemoryAgentControlRepository } from "../../repositories/agentControlRepository.js";
import type { TaskStateRepository } from "../../repositories/taskStateRepository.js";
import { agentControlState, controllerMirrorAgents } from "../nodes/physicalHostIdentity.js";

export type OverviewAccess = { nodeScope: "all" | readonly string[]; canReadTasks: boolean; canReadAudit: boolean };
type LocalSample = { sequence: number; collectedAt: string; displayTime: string; snapshot: PlatformSnapshot; tasks: OverviewTaskRecord[]; risks: OverviewRiskRecord[] };
type ResourceAggregate = {
  cpuSamples: number[]; cpu: number | null;
  memoryTotal: number; memoryUsed: number; memory: number | null;
  diskTotal: number; diskUsed: number; disk: number | null; diskVolumes: number;
  loadAverages: number[]; liveNodes: number; windowsEquivalentNodes: number;
};

const fullAccess: OverviewAccess = { nodeScope: "all", canReadTasks: true, canReadAudit: true };
const displayTime = (value = new Date()) => value.toLocaleString("zh-CN", { hour12: false });
const spark = (value: number) => [Math.max(0, value - 7), Math.max(0, value - 2), value, Math.min(100, value + 2)];
const formatGb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;
const percent = (used: number, total: number) => total > 0 ? Math.round(used / total * 100) : null;
const uptime = (seconds: number) => `${Math.floor(seconds / 3600)} 小时 ${Math.floor(seconds % 3600 / 60)} 分钟`;
const resourceTone = (value: number | null, resource: keyof typeof RESOURCE_THRESHOLDS) => value === null ? "gray" : value >= RESOURCE_THRESHOLDS[resource].critical ? "red" : value >= RESOURCE_THRESHOLDS[resource].warning ? "orange" : "blue";

export class OverviewService {
  private localCache: { value: LocalSample; expiresAt: number } | null = null;
  private localInFlight: Promise<LocalSample> | null = null;
  private forcedLocalInFlight: Promise<LocalSample> | null = null;
  private localSequence = 0;

  constructor(
    private readonly platform: PlatformAdapter,
    private readonly taskState: TaskStateRepository,
    private readonly agents: AgentControlRepository = new MemoryAgentControlRepository(),
    private readonly cacheTtlMs = 10_000,
  ) {}

  async getOverview(access: OverviewAccess = fullAccess, options: { bypassCache?: boolean } = {}): Promise<OverviewSummaryPayload> {
    const [local, state] = await Promise.all([this.localSample(Boolean(options.bypassCache)), this.agents.read({
      sections: ["nodes", ...(access.canReadTasks ? ["tasks" as const] : []), ...(access.canReadAudit ? ["audits" as const] : [])],
      ...(access.nodeScope === "all" ? {} : { nodeIds: access.nodeScope }),
    })]);
    const allowed = (nodeId: string) => access.nodeScope === "all" || access.nodeScope.includes(nodeId);
    const remoteNodes = state.nodes.filter((node) => !node.revokedAt && allowed(node.nodeId));
    const mirrorNodes = controllerMirrorAgents(local.snapshot, state.nodes.filter((node) => !node.revokedAt)).filter((node) => allowed(node.nodeId));
    const mirrorNodeIds = new Set(mirrorNodes.map((node) => node.nodeId));
    const visibleRemoteNodes = remoteNodes.filter((node) => !mirrorNodeIds.has(node.nodeId));
    const remoteNodeIds = new Set(remoteNodes.map((node) => node.nodeId));
    const localNode = this.mergeControllerAgent(local.snapshot.node, mirrorNodes[0]);
    const nodes = [localNode, ...visibleRemoteNodes.map((node) => this.remoteNode(node))];
    const remoteTasks = access.canReadTasks ? state.tasks.filter((task) => remoteNodeIds.has(task.targetNodeId)).map((task) => this.remoteTask(task, remoteNodes)) : [];
    const tasks = [...local.tasks, ...remoteTasks];
    const risks = [...local.risks, ...mirrorNodes.flatMap((node) => this.remoteControlRisks(node)), ...visibleRemoteNodes.flatMap((node) => this.remoteRisks(node))];
    const audits = [...local.snapshot.auditRows, ...(access.canReadAudit ? this.agentAudits(state.audits.filter((event) => event.nodeId !== null && remoteNodeIds.has(event.nodeId)), remoteNodes) : [])];
    const onlineNodes = visibleRemoteNodes.filter((node) => this.freshness(node) === "current" && node.telemetry);
    const onlineTelemetry = onlineNodes.map((node) => node.telemetry!);
    const aggregate = this.aggregateResources(local.snapshot, onlineNodes);
    const taskPage = this.taskPage(tasks, local.displayTime, local.collectedAt);
    const resources = this.resources(local.snapshot, visibleRemoteNodes, aggregate, local.collectedAt);
    const unavailable = nodes.filter((node) => node.status !== "健康").length;
    const openRisks = risks.filter((risk) => risk.status === "待处理");
    return OverviewSummaryPayloadSchema.parse({
      collectedAt: local.collectedAt, lastRefresh: local.displayTime,
      cluster: { current: `${nodes.length} 个节点`, health: unavailable || nodes.some((node) => node.status !== "健康") ? "警告" : "健康", latency: local.snapshot.node.latency, version: local.snapshot.node.version, uptime: local.snapshot.node.uptime, lastBackup: local.snapshot.node.backup, pendingUpdates: local.snapshot.changedFiles.length + local.snapshot.behind },
      metrics: [
        { label: "CPU 使用率", value: aggregate.cpu === null ? "暂不可用" : String(aggregate.cpu), suffix: aggregate.cpu === null ? "" : "%", delta: aggregate.cpu === null ? "等待采集" : `${aggregate.cpuSamples.length} 个核心样本`, icon: "server", tone: resourceTone(aggregate.cpu, "cpu"), line: aggregate.cpuSamples },
        { label: "内存使用率", value: aggregate.memory === null ? "暂不可用" : String(aggregate.memory), suffix: aggregate.memory === null ? "" : "%", delta: aggregate.memory === null ? "等待采集" : `${formatGb(Math.max(0, aggregate.memoryTotal - aggregate.memoryUsed))} 可用`, icon: "database", tone: resourceTone(aggregate.memory, "memory"), line: aggregate.memory === null ? [] : spark(aggregate.memory) },
        { label: "磁盘使用率", value: aggregate.disk === null ? "暂不可用" : String(aggregate.disk), suffix: aggregate.disk === null ? "" : "%", delta: aggregate.disk === null ? "等待采集" : `${aggregate.diskVolumes} 个盘 · ${formatGb(Math.max(0, aggregate.diskTotal - aggregate.diskUsed))} 可用`, icon: "globe", tone: resourceTone(aggregate.disk, "disk"), line: aggregate.disk === null ? [] : spark(aggregate.disk), details: this.diskDetails(local.snapshot, onlineTelemetry) },
        { label: "待处理任务", value: String(tasks.filter((task) => ["运行中", "等待"].includes(task.status)).length), suffix: "", delta: `${tasks.length} 个任务`, icon: "calendar", tone: "gray", line: spark(tasks.length * 10) },
        { label: "风险项", value: String(openRisks.length), suffix: "", delta: `${openRisks.filter((risk) => risk.level === "高危").length} 高危`, icon: "shield", tone: openRisks.length ? "orange" : "blue", line: spark(openRisks.length * 20) },
        { label: "异常节点", value: String(unavailable), suffix: "", delta: `${nodes.length} 个节点`, icon: "bell", tone: unavailable ? "red" : "blue", line: spark(unavailable * 20) },
      ],
      nodes, tasks, taskPage, audits, risks, resources,
    });
  }

  private async localSample(bypass: boolean): Promise<LocalSample> {
    if (!bypass && this.forcedLocalInFlight) return this.forcedLocalInFlight;
    if (!bypass && this.localCache && this.localCache.expiresAt > Date.now()) return this.localCache.value;
    const key = bypass ? "forcedLocalInFlight" : "localInFlight";
    const existing = this[key];
    if (existing) return existing;
    const promise = this.collectLocalSample();
    this[key] = promise;
    try {
      const value = await promise;
      if (!this.localCache || value.sequence >= this.localCache.value.sequence) this.localCache = { value, expiresAt: Date.now() + this.cacheTtlMs };
      return value;
    } finally {
      if (this[key] === promise) this[key] = null;
    }
  }

  private async collectLocalSample(): Promise<LocalSample> {
    const sequence = ++this.localSequence;
    const collectedAt = new Date().toISOString(); const shown = displayTime(new Date(collectedAt));
    const snapshot = await this.platform.collectSnapshot();
    const tasks = (await this.platform.collectDeviceTasks(snapshot, shown)).map((task) => ({ ...task, ...this.taskState.get(task.id) }));
    return { sequence, collectedAt, displayTime: shown, snapshot, tasks, risks: this.localRisks(snapshot) };
  }

  private isHeartbeatStale(node: AgentNodeState) {
    return node.status === "offline" || Boolean(node.lastSeenAt && Date.now() - Date.parse(node.lastSeenAt) > 45_000);
  }
  private isTelemetryStale(node: AgentNodeState) { return Boolean(node.telemetry && Date.now() - Date.parse(node.telemetry.collectedAt) > 45_000); }
  private freshness(node: AgentNodeState): "current" | "stale" | "awaiting" {
    if (!node.telemetry) return this.isHeartbeatStale(node) ? "stale" : "awaiting";
    return this.isHeartbeatStale(node) || this.isTelemetryStale(node) ? "stale" : "current";
  }

  private remoteNode(node: AgentNodeState): OverviewNode {
    const telemetry = node.telemetry; const freshness = this.freshness(node); const heartbeatStale = this.isHeartbeatStale(node);
    const memory = telemetry?.memory ? percent(telemetry.memory.totalBytes - telemetry.memory.availableBytes, telemetry.memory.totalBytes) : null;
    const diskTotal = telemetry?.disks.reduce((sum, item) => sum + item.totalBytes, 0) ?? 0;
    const diskUsed = telemetry?.disks.reduce((sum, item) => sum + item.usedBytes, 0) ?? 0;
    const disk = percent(diskUsed, diskTotal);
    return {
      id: node.nodeId, name: telemetry?.hostname ?? node.nodeName, ip: telemetry?.primaryIp ?? "暂不可用", env: node.platform,
      status: heartbeatStale ? "离线" : freshness === "awaiting" ? "维护" : freshness === "stale" || node.heartbeatHealthStatus === "degraded" || hasResourceWarning({ cpu: telemetry?.cpu?.usagePercent ?? null, memory, disk }) ? "警告" : "健康", source: "agent", collectedAt: telemetry?.collectedAt ?? null, freshness,
      availability: { cpu: Boolean(telemetry?.cpu), memory: Boolean(telemetry?.memory), disk: Boolean(telemetry?.disks.length), latency: false, backup: false, update: false, services: false },
      latency: "暂不可用", latencyStatus: "警告", cpu: telemetry?.cpu ? `${Math.round(telemetry.cpu.usagePercent)}%` : "暂不可用",
      memory: memory === null ? "暂不可用" : `${memory}%`, disk: disk === null ? "暂不可用" : `${disk}%`, version: `v${node.agentVersion}`,
      uptime: telemetry ? uptime(telemetry.uptimeSeconds) : "暂不可用", backup: "暂不可用", backupStatus: "警告", update: "暂不可用", owner: "StackPilot Agent", services: [],
      diskVolumes: telemetry?.disks.map((item) => ({ ...item, percent: percent(item.usedBytes, item.totalBytes) ?? 0 })) ?? [],
    };
  }

  private mergeControllerAgent(node: OverviewNode, mirror?: AgentNodeState): OverviewNode {
    if (!mirror) return node;
    const control = agentControlState(mirror);
    const controlService = {
      id: `stackpilot-agent-${mirror.nodeId}`, name: "StackPilot Agent 控制通道", target: mirror.nodeId,
      status: control.status, detail: control.detail,
    };
    return { ...node, status: control.healthy ? node.status : "警告", owner: `${node.owner} · Agent ${mirror.agentVersion}`, services: [...node.services, controlService] };
  }

  private remoteTask(task: RemoteTaskRecord, nodes: AgentNodeState[]): OverviewTaskRecord {
    const effectiveStatus = !["succeeded", "failed", "cancelled", "expired"].includes(task.status) && Date.parse(task.expiresAt) <= Date.now() ? "expired" : task.status;
    const status = { queued: "等待", dispatched: "运行中", running: "运行中", succeeded: "成功", failed: "失败", cancelled: "取消", expired: "过期" }[effectiveStatus] as OverviewTaskRecord["status"];
    const title = task.type === "system.summary.read" ? "采集系统摘要" : task.type === "network.mesh.status.read" ? "采集组网状态" : "采集服务状态";
    return { id: task.taskId, type: "远程任务", title, target: nodes.find((node) => node.nodeId === task.targetNodeId)?.nodeName ?? task.targetNodeId, status, priority: ["失败", "过期"].includes(status) ? "高" : status === "成功" ? "低" : "中", operator: task.requester, queuedAt: displayTime(new Date(task.createdAt)), duration: effectiveStatus === "running" ? "运行中" : "暂不可用", source: "Agent 控制面", actionLabel: "查看", collectedAt: task.updatedAt, logs: [task.result?.message, task.errorCode, effectiveStatus === "expired" && task.status !== "expired" ? "任务已超过有效期" : null].filter((value): value is string => Boolean(value)) };
  }

  private remoteRisks(node: AgentNodeState): OverviewRiskRecord[] {
    const freshness = this.freshness(node); const risks: OverviewRiskRecord[] = [];
    const add = (suffix: string, title: string, level: "高危" | "中危", impact: string) => risks.push({ id: `risk-agent-${node.nodeId}-${suffix}`, title, level, status: "待处理", target: node.nodeName, owner: "StackPilot Agent", impact, detected: node.telemetry?.collectedAt ?? node.enrolledAt, suggestion: "检查 Agent 连接和主机资源，恢复后等待下一次自动采集。", traceId: `agent-${node.nodeId}-${suffix}` });
    if (freshness === "awaiting") add("awaiting", "Agent 等待遥测", "中危", "节点已注册但尚无资源快照");
    if (this.isHeartbeatStale(node)) add("offline", "Agent 节点离线", "高危", `最后心跳 ${node.lastSeenAt ?? "未知"}`);
    if (this.isTelemetryStale(node)) add("telemetry-stale", "Agent 遥测已过期", "高危", `最后采集 ${node.telemetry?.collectedAt ?? "未知"}`);
    if (node.heartbeatHealthStatus === "degraded") add("heartbeat-degraded", "Agent 控制通道降级", "中危", "Agent 最近一次心跳报告降级");
    if (freshness !== "current" || !node.telemetry) return risks;
    const telemetry = node.telemetry; const memory = telemetry.memory ? percent(telemetry.memory.totalBytes - telemetry.memory.availableBytes, telemetry.memory.totalBytes) : null;
    const disk = percent(telemetry.disks.reduce((sum, item) => sum + item.usedBytes, 0), telemetry.disks.reduce((sum, item) => sum + item.totalBytes, 0));
    if (telemetry.cpu && telemetry.cpu.usagePercent >= RESOURCE_THRESHOLDS.cpu.warning) add("cpu", "Agent CPU 使用率偏高", telemetry.cpu.usagePercent >= RESOURCE_THRESHOLDS.cpu.critical ? "高危" : "中危", `${Math.round(telemetry.cpu.usagePercent)}%`);
    if (memory !== null && memory >= RESOURCE_THRESHOLDS.memory.warning) add("memory", "Agent 内存压力偏高", memory >= RESOURCE_THRESHOLDS.memory.critical ? "高危" : "中危", `${memory}%`);
    if (disk !== null && disk >= RESOURCE_THRESHOLDS.disk.warning) add("disk", "Agent 磁盘使用率偏高", disk >= RESOURCE_THRESHOLDS.disk.critical ? "高危" : "中危", `${disk}%`);
    return risks;
  }

  private remoteControlRisks(node: AgentNodeState) {
    return this.remoteRisks(node).filter((risk) => ["awaiting", "offline", "telemetry-stale", "heartbeat-degraded"].some((suffix) => risk.id.endsWith(`-${suffix}`)));
  }

  private localRisks(snapshot: PlatformSnapshot): OverviewRiskRecord[] {
    const risks: OverviewRiskRecord[] = [];
    const add = (id: string, title: string, value: number, high: number, warning: number, target: string) => { if (value >= warning) risks.push({ id, title, level: value >= high ? "高危" : "中危", status: "待处理", target, owner: "本机工作台", impact: `当前采样 ${value}%`, detected: "实时采样", suggestion: "定位高占用来源，处理后重新扫描并确认指标恢复。", traceId: id }); };
    if (snapshot.node.availability.cpu) add("risk-cpu", "CPU 使用率偏高", snapshot.cpuPercent, RESOURCE_THRESHOLDS.cpu.critical, RESOURCE_THRESHOLDS.cpu.warning, snapshot.node.name);
    if (snapshot.node.availability.memory) add("risk-memory", "内存压力偏高", snapshot.memoryPercent, RESOURCE_THRESHOLDS.memory.critical, RESOURCE_THRESHOLDS.memory.warning, snapshot.node.name);
    if (snapshot.node.availability.disk) add("risk-disk", "磁盘使用率偏高", snapshot.diskPercent, RESOURCE_THRESHOLDS.disk.critical, RESOURCE_THRESHOLDS.disk.warning, "所有本地盘汇总");
    if (snapshot.changedFiles.length) risks.push({ id: "risk-git-dirty", title: "Git 工作区存在未提交变更", level: snapshot.changedFiles.length >= 5 ? "中危" : "低危", status: "待处理", target: `${snapshot.branch} @ ${snapshot.commit}`, owner: "本机工作台", impact: `${snapshot.changedFiles.length} 个变更会影响交付边界`, detected: "实时采样", suggestion: "提交前检查工作区范围并运行完整验证。", evidence: snapshot.changedFiles.slice(0, 6).map((value) => ({ label: "变更文件", value })), traceId: "risk-git-dirty" });
    if (snapshot.node.backupStatus !== "健康") risks.push({ id: "risk-backup", title: "未发现近期真实备份", level: "中危", status: "待处理", target: "本机备份", owner: "本机工作台", impact: snapshot.node.backup, detected: "实时采样", suggestion: "配置备份目录并确认近期备份可读。", traceId: "risk-backup" });
    return risks;
  }

  private taskPage(tasks: OverviewTaskRecord[], shown: string, collectedAt: string) { return { title: "任务流", subtitle: `设备与 Agent 任务，最近采集：${shown}`, searchPlaceholder: "搜索设备任务、服务、计划任务、目标或日志", filters: [{ id: "all", label: "全部", statuses: [] }, { id: "queued", label: "队列中", statuses: ["运行中", "等待"] }, { id: "success", label: "成功", statuses: ["成功"] }, { id: "failed", label: "异常", statuses: ["失败", "取消", "过期"] }], metrics: [{ label: "任务总数", value: String(tasks.length), icon: "calendar", tone: "blue" }, { label: "队列中", value: String(tasks.filter((task) => ["运行中", "等待"].includes(task.status)).length), icon: "bell", tone: "orange" }, { label: "异常任务", value: String(tasks.filter((task) => ["失败", "取消", "过期"].includes(task.status)).length), icon: "shield", tone: "red" }], context: { eyebrow: "工作台 / 设备任务", title: "任务流", chips: [`采集 ${tasks.length} 条`, `采集时间 ${shown}`] }, collectedAt }; }
  private aggregateResources(snapshot: PlatformSnapshot, nodes: AgentNodeState[]): ResourceAggregate {
    const telemetry = nodes.map((node) => node.telemetry!);
    const localAvailability = snapshot.node.availability;
    const cpuSamples = [localAvailability.cpu ? snapshot.cpuCorePercents : [], ...telemetry.map((item) => item.cpu?.coreUsagePercents ?? [])].flat();
    const cpu = cpuSamples.length ? Math.round(cpuSamples.reduce((sum, value) => sum + value, 0) / cpuSamples.length) : null;
    const localMemoryTotal = localAvailability.memory ? snapshot.totalMemoryBytes : 0;
    const memoryTotal = localMemoryTotal + telemetry.reduce((sum, item) => sum + (item.memory?.totalBytes ?? 0), 0);
    const memoryUsed = (localAvailability.memory ? snapshot.totalMemoryBytes - snapshot.availableMemoryBytes : 0) + telemetry.reduce((sum, item) => sum + (item.memory ? item.memory.totalBytes - item.memory.availableBytes : 0), 0);
    const volumes = [...(localAvailability.disk ? snapshot.disks : []), ...telemetry.flatMap((item) => item.disks)];
    const diskTotal = volumes.reduce((sum, item) => sum + item.totalBytes, 0); const diskUsed = volumes.reduce((sum, item) => sum + item.usedBytes, 0);
    const loads = [...(snapshot.loadAverages.length ? [snapshot.loadAverages] : []), ...telemetry.flatMap((item) => item.loadAverage ? [item.loadAverage] : [])];
    const loadAverages = loads.length ? [0, 1, 2].map((index) => loads.reduce((sum, item) => sum + (item[index] ?? 0), 0) / loads.length) : [];
    const localWindowsEquivalent = snapshot.platformLabel.startsWith("win32 ") && snapshot.loadAverages.length ? 1 : 0;
    const windowsEquivalentNodes = localWindowsEquivalent + nodes.filter((node) => node.platform === "win32" && node.telemetry?.loadAverage).length;
    return { cpuSamples, cpu, memoryTotal, memoryUsed, memory: percent(memoryUsed, memoryTotal), diskTotal, diskUsed, disk: percent(diskUsed, diskTotal), diskVolumes: volumes.length, loadAverages, liveNodes: loads.length, windowsEquivalentNodes };
  }
  private resources(snapshot: PlatformSnapshot, nodes: AgentNodeState[], aggregate: ResourceAggregate, collectedAt: string): Record<string, OverviewResourceRecord[]> {
    const meta = { collectedAt, freshness: "current" as const };
    const localLoadDelta = snapshot.loadAverages.length ? (snapshot.platformLabel.startsWith("win32 ") ? "Windows 等效负载" : snapshot.platformLabel) : "等待采集";
    const clusterLoadDelta = aggregate.loadAverages.length ? `${aggregate.liveNodes} 个实时节点${aggregate.windowsEquivalentNodes ? ` · ${aggregate.windowsEquivalentNodes} 个 Windows 等效值` : ""}` : "等待采集";
    const local = [{ label: "CPU 使用率", value: snapshot.node.availability.cpu ? `${snapshot.cpuPercent}%` : "暂不可用", delta: snapshot.node.availability.cpu ? `${snapshot.cpuCorePercents.length} 核心` : "等待采集", values: snapshot.node.availability.cpu ? snapshot.cpuCorePercents : [], ...meta }, { label: "内存使用率", value: snapshot.node.availability.memory ? `${snapshot.memoryPercent}%` : "暂不可用", delta: snapshot.node.availability.memory ? `${formatGb(snapshot.totalMemoryBytes)} 总量` : "等待采集", values: snapshot.node.availability.memory ? spark(snapshot.memoryPercent) : [], ...meta }, { label: "磁盘使用率", value: snapshot.node.availability.disk ? `${snapshot.diskPercent}%` : "暂不可用", delta: snapshot.node.availability.disk ? `${snapshot.disks.length} 个本地盘` : "等待采集", values: snapshot.node.availability.disk ? spark(snapshot.diskPercent) : [], ...meta }, { label: "系统负载", value: snapshot.loadAverages.length ? (snapshot.loadAverages[0] ?? 0).toFixed(2) : "暂不可用", delta: localLoadDelta, values: snapshot.loadAverages, ...meta }];
    const cluster = [{ label: "CPU 使用率", value: aggregate.cpu === null ? "暂不可用" : `${aggregate.cpu}%`, delta: aggregate.cpu === null ? "等待采集" : `${aggregate.cpuSamples.length} 核心样本`, values: aggregate.cpuSamples, ...meta }, { label: "内存使用率", value: aggregate.memory === null ? "暂不可用" : `${aggregate.memory}%`, delta: aggregate.memory === null ? "等待采集" : `${formatGb(aggregate.memoryTotal)} 总量`, values: aggregate.memory === null ? [] : spark(aggregate.memory), ...meta }, { label: "磁盘使用率", value: aggregate.disk === null ? "暂不可用" : `${aggregate.disk}%`, delta: aggregate.disk === null ? "等待采集" : `${aggregate.diskVolumes} 个实时卷`, values: aggregate.disk === null ? [] : spark(aggregate.disk), ...meta }, { label: "系统负载", value: aggregate.loadAverages.length ? (aggregate.loadAverages[0] ?? 0).toFixed(2) : "暂不可用", delta: clusterLoadDelta, values: aggregate.loadAverages, ...meta }];
    return Object.fromEntries([["cluster", cluster], ["node-local", local], ...nodes.map((node) => [node.nodeId, this.remoteResources(node)])]);
  }
  private remoteResources(node: AgentNodeState): OverviewResourceRecord[] { const telemetry = node.telemetry; if (!telemetry) return []; const meta = { collectedAt: telemetry.collectedAt, freshness: this.freshness(node) }; const memory = telemetry.memory ? percent(telemetry.memory.totalBytes - telemetry.memory.availableBytes, telemetry.memory.totalBytes) : null; const disk = percent(telemetry.disks.reduce((sum, item) => sum + item.usedBytes, 0), telemetry.disks.reduce((sum, item) => sum + item.totalBytes, 0)); const loadDelta = !telemetry.loadAverage ? "等待采集" : node.platform === "win32" ? "Windows 等效负载" : telemetry.hostname; return [{ label: "CPU 使用率", value: telemetry.cpu ? `${Math.round(telemetry.cpu.usagePercent)}%` : "暂不可用", delta: telemetry.cpu ? `${telemetry.cpu.coreUsagePercents.length} 核心` : "等待采集", values: telemetry.cpu?.coreUsagePercents ?? [], ...meta }, { label: "内存使用率", value: memory === null ? "暂不可用" : `${memory}%`, delta: telemetry.memory ? `${formatGb(telemetry.memory.totalBytes)} 总量` : "等待采集", values: memory === null ? [] : spark(memory), ...meta }, { label: "磁盘使用率", value: disk === null ? "暂不可用" : `${disk}%`, delta: `${telemetry.disks.length} 个卷`, values: disk === null ? [] : spark(disk), ...meta }, { label: "系统负载", value: telemetry.loadAverage?.[0]?.toFixed(2) ?? "暂不可用", delta: loadDelta, values: telemetry.loadAverage ?? [], ...meta }]; }
  private diskDetails(snapshot: PlatformSnapshot, telemetry: AgentTelemetrySnapshot[]) { return [...snapshot.disks.map((disk) => ({ label: `${disk.label} (${disk.mount})`, value: `${disk.percent}%`, detail: `已用 ${formatGb(disk.usedBytes)} / ${formatGb(disk.totalBytes)}` })), ...telemetry.flatMap((item) => item.disks.map((disk) => ({ label: `${item.hostname} · ${disk.label} (${disk.mount})`, value: `${percent(disk.usedBytes, disk.totalBytes) ?? 0}%`, detail: `已用 ${formatGb(disk.usedBytes)} / ${formatGb(disk.totalBytes)}` })))]; }
  private agentAudits(events: AuditEvent[], nodes: AgentNodeState[]): OverviewSummaryPayload["audits"] { return events.slice(-50).reverse().map((event) => [event.timestamp, "agent", event.requester, event.event, nodes.find((node) => node.nodeId === event.nodeId)?.nodeName ?? event.nodeId ?? "controller", event.toStatus === "failed" ? "失败" : "成功", event.traceId]); }
}
