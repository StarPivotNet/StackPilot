import { randomUUID } from "node:crypto";
import {
  EGRESS_PROBE_INTERVAL_MS, EGRESS_PROBE_MAX_TARGETS, EGRESS_SAMPLE_STALE_SECONDS, MESH_DATA_PLANE_PORT,
  NetworkCacheDownloadJobSchema, NetworkCacheFetchResultSchema, NetworkCacheFetchTaskParametersSchema,
  NetworkEgressProbeResultSchema, NetworkEgressProbeTaskParametersSchema,
  type AgentCapability, type CreateRemoteTaskRequest, type MeshPeerDirectoryResponse, type NetworkCacheDownloadJob, type NetworkCacheDownloadJobListResponse, type NetworkCacheDownloadRequest, type NetworkCacheDownloadResponse,
  type NetworkEgressNode, type NetworkEgressPlanResponse, type NetworkEgressSelection, type NetworkEgressSelectionReason, type NetworkEgressDisabledReason,
  type NodeScope, type Permission, type RemoteTaskRecord, type RemoteTaskStatus,
} from "@stackpilot/contracts";
import type { AgentControlRepository, AgentNodeState, AuditEvent } from "../../repositories/agentControlRepository.js";
import {
  downloadTrafficTotal, MemoryNetworkObservabilityRepository,
  type DownloadJobRecord, type DownloadSegmentRecord, type NetworkObservabilityRepository,
} from "../../repositories/networkObservabilityRepository.js";
import { isNodeLive } from "../nodes/nodeLiveness.js";
import { terminalTaskStatuses, type RemoteTaskService } from "../remote-tasks/remoteTaskService.js";
import { ServiceError } from "../serviceError.js";

export const EGRESS_CAPABILITY: AgentCapability = "network.transfer";
/**
 * Below this rate a bounded read mostly measured body size, not link capacity, so the sample ranks as
 * latency evidence only. A 256 KiB read at this rate already takes sixteen seconds.
 */
const EGRESS_MEASURED_BYTES_PER_SECOND = 16 * 1024;

const audit = (timestamp: string, event: Omit<AuditEvent, "eventId" | "timestamp">): AuditEvent => ({ eventId: randomUUID(), timestamp, ...event });
/** One page of jobs is enough to watch; older fills stay in the audit log. */
const DOWNLOAD_JOB_LIMIT = 100;
/** The monthly meter needs a full month; a quarter of history also covers a long investigation. */
const DOWNLOAD_JOB_RETENTION_DAYS = 90;
const ACTIVE_JOB_STATUSES: readonly RemoteTaskStatus[] = ["queued", "dispatched", "running"];

/** A job view never invents a byte: every figure is the Agent's own report or absent. */
function downloadJob(task: RemoteTaskRecord, nodeName: string | null): NetworkCacheDownloadJob {
  const parameters = NetworkCacheFetchTaskParametersSchema.safeParse(task.parameters);
  if (!parameters.success) throw new ServiceError(500, "INTERNAL_ERROR", "下载任务参数不可读");
  const parsed = task.result?.data ? NetworkCacheFetchResultSchema.safeParse(task.result.data) : null;
  const result = parsed?.success ? parsed.data : null;
  const live = task.status === "queued" || task.status === "dispatched" || task.status === "running";
  const elapsedSeconds = result ? Math.max(result.elapsedMs / 1000, 0.001) : 0;
  return NetworkCacheDownloadJobSchema.parse({
    taskId: task.taskId, nodeId: task.targetNodeId, nodeName,
    url: parameters.data.url, host: new URL(parameters.data.url).hostname,
    status: task.status, createdAt: task.createdAt, updatedAt: task.updatedAt, expiresAt: task.expiresAt,
    bytesReceived: task.progress?.bytesReceived ?? (result && task.status === "succeeded" ? result.sizeBytes : 0),
    totalBytes: task.progress?.totalBytes ?? result?.sizeBytes ?? null,
    // A finished job reports the average the Agent measured, not the last live sample. A cache hit
    // carried no bytes over the network, so dividing its size by a millisecond would print a fiction.
    bytesPerSecond: live ? task.progress?.bytesPerSecond ?? null
      : result && task.status === "succeeded" ? (result.hit ? null : Math.round(result.sizeBytes / elapsedSeconds))
      : task.progress?.bytesPerSecond ?? null,
    segmented: result?.segmented ?? parameters.data.segments !== undefined,
    partsDone: task.progress?.partsDone ?? 0,
    partsTotal: task.progress?.partsTotal ?? 0,
    segmentCount: result?.segmentCount ?? parameters.data.segments?.sources.length ?? 0,
    segmentSources: result?.segmentSources?.length ?? parameters.data.segments?.sources.length ?? 0,
    // Per-part counters only while the job runs: a finished part has no current speed to report.
    parts: live && task.progress?.parts
      ? task.progress.parts.map((part) => ({
        index: part.index, sourceNodeId: part.sourceNodeId, bytes: part.bytes, totalBytes: part.totalBytes, bytesPerSecond: part.bytesPerSecond,
      }))
      : [],
    resumedBytes: result?.resumedBytes ?? 0,
    hit: result?.hit ?? null, viaEgress: result?.viaEgress ?? null, originBytes: result?.originBytes ?? null,
    sizeBytes: result?.sizeBytes ?? null, digest: result?.digest ?? parameters.data.digest ?? null,
    failureReason: task.errorCode ?? null,
    retryable: task.status === "failed" || task.status === "expired" || task.status === "cancelled",
    attempt: task.attempt,
  });
}

const jobRecord = (view: NetworkCacheDownloadJob): DownloadJobRecord => ({
  taskId: view.taskId, nodeId: view.nodeId, url: view.url, host: view.host, digest: view.digest, status: view.status,
  bytesReceived: view.bytesReceived, totalBytes: view.totalBytes, partsDone: view.partsDone, partsTotal: view.partsTotal,
  segmented: view.segmented, segmentCount: view.segmentCount, segmentSources: view.segmentSources,
  bytesPerSecond: view.bytesPerSecond, resumedBytes: view.resumedBytes,
  hit: view.hit, viaEgress: view.viaEgress, originBytes: view.originBytes, sizeBytes: view.sizeBytes,
  failureReason: view.failureReason, attempt: view.attempt,
  createdAt: view.createdAt, updatedAt: view.updatedAt, expiresAt: view.expiresAt,
});

/**
 * The stored row is re-read as the same view the task produced. An unfinished row whose lifetime ran
 * out is reported expired, and its update time becomes the moment it lapsed: the task service would
 * have recorded the moment it noticed instead, but a read never writes just to say so.
 */
function storedJob(row: DownloadJobRecord, nodeName: string | null, now: Date): NetworkCacheDownloadJob {
  const expired = ACTIVE_JOB_STATUSES.includes(row.status as RemoteTaskStatus) && Date.parse(row.expiresAt) <= now.getTime();
  return NetworkCacheDownloadJobSchema.parse({
    taskId: row.taskId, nodeId: row.nodeId, nodeName,
    url: row.url, host: row.host,
    status: expired ? "expired" : row.status,
    createdAt: row.createdAt, updatedAt: expired ? row.expiresAt : row.updatedAt, expiresAt: row.expiresAt,
    bytesReceived: row.bytesReceived, totalBytes: row.totalBytes, bytesPerSecond: row.bytesPerSecond,
    segmented: row.segmented, partsDone: row.partsDone, partsTotal: row.partsTotal,
    segmentCount: row.segmentCount, segmentSources: row.segmentSources, resumedBytes: row.resumedBytes,
    hit: row.hit, viaEgress: row.viaEgress, originBytes: row.originBytes, sizeBytes: row.sizeBytes, digest: row.digest,
    failureReason: row.failureReason ?? (expired ? "TASK_EXPIRED" : null),
    retryable: row.status === "failed" || row.status === "expired" || row.status === "cancelled" || expired,
    attempt: row.attempt,
  });
}

/** Which peer carried which part. Only the Agent's own report counts: `parts` when it sent them,
 * otherwise the one peer its `viaEgress`/`egressNodeId` names for a whole-object fill. */
function jobSegments(task: RemoteTaskRecord): DownloadSegmentRecord[] {
  if (task.status !== "succeeded" || !task.result?.data) return [];
  const parsed = NetworkCacheFetchResultSchema.safeParse(task.result.data);
  if (!parsed.success) return [];
  const result = parsed.data;
  if (result.parts && result.parts.length > 0) {
    return result.parts.map((part) => ({ jobId: task.taskId, partIndex: part.index, sourceNodeId: part.sourceNodeId, bytes: part.bytes, resumed: part.resumed }));
  }
  // A whole-object egress fill is one stream from one peer, so that peer carried all of it.
  if (result.egressNodeId && result.viaEgress !== false) {
    return [{ jobId: task.taskId, partIndex: 0, sourceNodeId: result.egressNodeId, bytes: result.sizeBytes, resumed: false }];
  }
  return [];
}

const monthStartOf = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();

type Sample = { host: string; ttfbMs: number; bytesPerSecond: number; collectedAt: string };
type NodeSamples = { samples: Map<string, Sample>; updatedAt: string };

export type EgressServiceOptions = {
  /** Probed sources; empty disables probing and leaves the table empty instead of inventing paths. */
  targets?: readonly string[];
  now?: () => Date;
  probeIntervalMs?: number;
  /** Durable job and traffic rows; in memory when the Controller runs without a database. */
  store?: NetworkObservabilityRepository;
  /** Month-to-date transferred bytes per node above which sharding and egress are switched off. 0 = off. */
  trafficQuotaBytes?: number;
};

/**
 * Collects each node's own measurement of its path to a source and answers "who should fetch this
 * host for that node". Nothing here touches packets: the Agent measures, the Controller ranks.
 */
export class EgressService {
  private readonly table = new Map<string, NodeSamples>();
  private readonly ingestedTaskIds = new Set<string>();
  private readonly lastProbeAt = new Map<string, number>();
  /** Per-part rates of running jobs: live telemetry, never a row, so a GET stays a pure read. */
  private readonly liveParts = new Map<string, NetworkCacheDownloadJob["parts"]>();
  private readonly store: NetworkObservabilityRepository;
  private readonly stopObserving: () => void;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly repository: AgentControlRepository,
    private readonly remoteTasks: RemoteTaskService,
    private readonly options: EgressServiceOptions = {},
  ) {
    this.store = options.store ?? new MemoryNetworkObservabilityRepository();
    // The task record stays authoritative; the row is the index the panel and the meter read.
    this.stopObserving = this.remoteTasks.observe((task) => { if (task.type === "network.cache.fetch") this.recordJob(task); });
  }

  private now() { return (this.options.now ?? (() => new Date()))(); }
  private get targets() { return [...new Set((this.options.targets ?? []).map((value) => value.trim()).filter(Boolean))].slice(0, EGRESS_PROBE_MAX_TARGETS); }
  private port(node: AgentNodeState) { return node.meshLink?.dataPlanePort ?? (node.meshAssignment ? MESH_DATA_PLANE_PORT : null); }

  /**
   * Which piece keeps a node out of routing — the first one missing, in the order an operator would fix it.
   * One `disabled` label for four different causes leaves nothing to act on.
   */
  private disabledReason(node: AgentNodeState): NetworkEgressDisabledReason | null {
    if (node.revokedAt) return "revoked";
    if (node.meshAssignment === undefined) return "no-overlay";
    if (!node.allowedCapabilities.includes(EGRESS_CAPABILITY)) return "not-allowed";
    if (!node.declaredCapabilities.includes(EGRESS_CAPABILITY)) return "not-declared";
    return null;
  }

  private isEligible(node: AgentNodeState) { return this.disabledReason(node) === null; }

  /** Bytes per second per millisecond of latency; higher wins, and a slow link never outranks a fast one. */
  private measured(sample: Sample) { return sample.bytesPerSecond >= EGRESS_MEASURED_BYTES_PER_SECOND; }
  private score(sample: Sample) { return this.measured(sample) ? Math.round((sample.bytesPerSecond / Math.max(sample.ttfbMs, 1)) * 1_000) / 1_000 : null; }
  /**
   * A probe of a tiny body proves latency, not throughput. Those samples rank below every node that
   * did measure bytes, and among themselves by time to first byte alone.
   */
  private compare(left: Sample, right: Sample) {
    const leftMeasured = this.measured(left), rightMeasured = this.measured(right);
    if (leftMeasured !== rightMeasured) return leftMeasured ? -1 : 1;
    if (!leftMeasured) return left.ttfbMs - right.ttfbMs;
    return (this.score(right) ?? 0) - (this.score(left) ?? 0) || left.ttfbMs - right.ttfbMs;
  }
  /** Clock skew of a minute is tolerated; a sample dated further ahead is not evidence of anything fresh. */
  private fresh(sample: Sample) {
    const age = (this.now().getTime() - Date.parse(sample.collectedAt)) / 1_000;
    return age <= EGRESS_SAMPLE_STALE_SECONDS && age >= -60;
  }
  private ageSeconds(sample: Sample) { return Math.max(0, Math.floor((this.now().getTime() - Date.parse(sample.collectedAt)) / 1_000)); }

  record(nodeId: string, samples: readonly Sample[]) {
    if (samples.length === 0) return;
    const entry = this.table.get(nodeId) ?? { samples: new Map<string, Sample>(), updatedAt: new Date().toISOString() };
    for (const sample of samples) entry.samples.set(sample.host, sample);
    entry.updatedAt = this.now().toISOString();
    this.table.set(nodeId, entry);
  }

  /** Persists one task as a job row, and its finished part attribution once the job ends. */
  private recordJob(task: RemoteTaskRecord) {
    try {
      const view = downloadJob(task, null);
      this.store.saveJob(jobRecord(view));
      // Part rates are live telemetry, not history: they live in memory and are dropped with the job.
      if (view.parts.length > 0) this.liveParts.set(task.taskId, view.parts);
      else this.liveParts.delete(task.taskId);
      const segments = jobSegments(task);
      if (segments.length > 0) this.store.saveSegments(task.taskId, segments);
    } catch { /* a projection failure must never fail the task path */ }
  }

  /** Fills the store from tasks that predate it, so an upgrade does not blank the panel. */
  async hydrate() {
    const tasks = await this.remoteTasks.listReadOnly(undefined, "all", DOWNLOAD_JOB_LIMIT, (task) => task.type === "network.cache.fetch");
    for (const task of tasks) this.recordJob(task);
  }

  /**
   * Month-to-date traffic for one node. Zero quota means the meter records but never restricts:
   * a limit the operator did not set must not silently turn acceleration off.
   */
  private quota(nodeId: string) {
    const quotaBytes = this.options.trafficQuotaBytes ?? 0;
    const now = this.now();
    const monthStart = monthStartOf(now);
    if (quotaBytes <= 0) return { degraded: false, quotaBytes: 0, monthStart, totalBytes: 0 };
    const record = this.store.trafficSince(monthStart, [nodeId]).find((row) => row.nodeId === nodeId);
    const totalBytes = record ? downloadTrafficTotal(record) : 0;
    return { degraded: totalBytes >= quotaBytes, quotaBytes, monthStart, totalBytes };
  }

  private project(node: AgentNodeState, now: number): NetworkEgressNode {
    const entry = this.table.get(node.nodeId);
    const samples = entry ? [...entry.samples.values()].sort((left, right) => left.host.localeCompare(right.host)).map((sample) => ({
      host: sample.host, ttfbMs: sample.ttfbMs, bytesPerSecond: sample.bytesPerSecond, collectedAt: sample.collectedAt, ageSeconds: this.ageSeconds(sample),
    })) : [];
    const disabledReason = this.disabledReason(node);
    const status = disabledReason !== null ? "disabled"
      // A dead process is not an egress. Selection already skips it, so a fresh sample must not make it look ready.
      : !isNodeLive(node, now) ? "offline"
      : samples.length === 0 ? "pending"
      // Same freshness rule as selection, so the table never advertises a node that routing skips.
      : samples.some((sample) => this.fresh(sample)) ? "ready"
      : "stale";
    return {
      nodeId: node.nodeId, nodeName: node.nodeName, status, disabledReason,
      overlayAddress: node.meshAssignment?.overlayAddress ?? null, dataPlanePort: this.port(node), samples,
    };
  }

  async plan(): Promise<NetworkEgressPlanResponse> {
    const nodes = (await this.repository.read({ sections: ["nodes"] })).nodes;
    const now = this.now().getTime();
    const projected = nodes.map((node) => this.project(node, now));
    const warnings: string[] = [];
    if (this.targets.length === 0) warnings.push("未配置探测源（STACKPILOT_EGRESS_PROBE_TARGETS），出口质量表为空，所有下载都会本地直取");
    for (const node of projected) {
      if (node.status === "offline" && node.samples.length > 0) warnings.push(`节点 ${node.nodeName} 已离线，不参与选路（样本新旧都不改变这个结论）`);
      else if (node.status === "pending") warnings.push(`节点 ${node.nodeName} 尚未完成出口探测，暂不参与选路`);
      else if (node.status === "stale") warnings.push(`节点 ${node.nodeName} 的出口探测数据已过期，选路时会跳过该节点`);
      else if (node.status === "ready" && node.samples.every((sample) => sample.bytesPerSecond < EGRESS_MEASURED_BYTES_PER_SECOND)) warnings.push(`节点 ${node.nodeName} 的探测样本只测出延迟、没有测出吞吐，选路时排在已测出吞吐的节点之后`);
      else if (node.status === "ready" && node.samples.every((sample) => sample.ttfbMs > 1_500)) warnings.push(`节点 ${node.nodeName} 到所有探测源的首字节时间都超过 1.5 秒`);
    }
    return { updatedAt: this.now().toISOString(), nodes: projected, warnings: warnings.slice(0, 20) };
  }

  /** `selfNodeId` is excluded: a node never routes its own download through itself. */
  async select(host: string, selfNodeId: string): Promise<NetworkEgressSelection> {
    const nodes = (await this.repository.read({ sections: ["nodes"] })).nodes;
    const eligible = nodes.filter((node) => this.isEligible(node));
    const others = eligible.filter((node) => node.nodeId !== selfNodeId);
    // A live sample from an offline node would only buy a socket timeout before the fallback.
    const now = this.now().getTime();
    const online = others.filter((node) => isNodeLive(node, now));
    const candidates = online.flatMap((node) => {
      const sample = this.table.get(node.nodeId)?.samples.get(host);
      return sample && this.fresh(sample) ? [{ node, sample }] : [];
    });
    const selectedAt = this.now().toISOString();
    const base = { host, nodeId: null, nodeName: null, overlayAddress: null, dataPlanePort: null, score: null } as const;
    if (candidates.length === 0) {
      const selfSample = this.table.get(selfNodeId)?.samples.get(host);
      const hasStale = online.some((node) => {
        const sample = this.table.get(node.nodeId)?.samples.get(host);
        return sample !== undefined && !this.fresh(sample);
      });
      const reason: NetworkEgressSelectionReason = selfSample && this.fresh(selfSample) ? "self"
        : others.length > 0 && online.length === 0 ? "offline"
        : hasStale ? "stale"
        : others.length > 0 ? "no-sample"
        : "disabled";
      return { ...base, reason, selectedAt };
    }
    candidates.sort((left, right) => this.compare(left.sample, right.sample));
    const best = candidates[0]!;
    return {
      host, nodeId: best.node.nodeId, nodeName: best.node.nodeName,
      overlayAddress: best.node.meshAssignment?.overlayAddress ?? null, dataPlanePort: this.port(best.node),
      score: this.score(best.sample), reason: "selected", selectedAt,
    };
  }

  /** Reads completed probe tasks; the Agent's numbers are the only source of the table. */
  async collect() {
    const tasks = await this.remoteTasks.listReadOnly(undefined, "all", 200, (task) => task.type === "network.egress.probe" && terminalTaskStatuses.includes(task.status));
    for (const task of tasks) {
      if (this.ingestedTaskIds.has(task.taskId)) continue;
      this.ingestedTaskIds.add(task.taskId);
      if (task.status !== "succeeded" || !task.result?.data) continue;
      const parsed = NetworkEgressProbeResultSchema.safeParse(task.result.data);
      if (!parsed.success) continue;
      this.record(task.targetNodeId, parsed.data.samples
        .filter((sample) => sample.ok && sample.ttfbMs !== null)
        .map((sample) => ({ host: sample.host, ttfbMs: sample.ttfbMs!, bytesPerSecond: sample.bytesPerSecond ?? 0, collectedAt: parsed.data.collectedAt })));
    }
    if (this.ingestedTaskIds.size > 1_000) {
      // Only recent task ids can reappear in the 200-row read, so the set never needs to grow forever.
      const keep = new Set(tasks.map((task) => task.taskId));
      for (const taskId of this.ingestedTaskIds) if (!keep.has(taskId)) this.ingestedTaskIds.delete(taskId);
    }
  }

  /** Enqueues one probe per eligible node per interval; the Controller never measures from its own host. */
  async probe() {
    const targets = this.targets.map((url) => ({ url }));
    if (targets.length === 0) return;
    const parameters = NetworkEgressProbeTaskParametersSchema.parse({ targets });
    const nodes = (await this.repository.read({ sections: ["nodes"] })).nodes;
    const nowMs = this.now().getTime();
    const window = Math.floor(nowMs / (this.options.probeIntervalMs ?? EGRESS_PROBE_INTERVAL_MS));
    for (const node of nodes.filter((value) => this.isEligible(value) && isNodeLive(value))) {
      const last = this.lastProbeAt.get(node.nodeId) ?? 0;
      if (nowMs - last < (this.options.probeIntervalMs ?? EGRESS_PROBE_INTERVAL_MS)) continue;
      this.lastProbeAt.set(node.nodeId, nowMs);
      const input: CreateRemoteTaskRequest = {
        type: "network.egress.probe", parameters, expiresInSeconds: 120,
        idempotencyKey: `egress-probe:${node.nodeId}:${window}`,
      };
      await this.remoteTasks.create(node.nodeId, input, "controller:egress", randomUUID()).catch(() => undefined);
    }
  }

  /** Runs a collection pass: ingest finished probes, then schedule the next round. */
  async tick() {
    await this.collect().catch(() => undefined);
    await this.probe().catch(() => undefined);
    // Job rows are a window, not an archive: the meter only needs the current month.
    try { this.store.pruneJobs(new Date(this.now().getTime() - DOWNLOAD_JOB_RETENTION_DAYS * 86_400_000).toISOString()); } catch { /* retention is housekeeping */ }
    try { this.pruneLiveParts(); } catch { /* telemetry is housekeeping */ }
  }

  /**
   * Part rates are telemetry for a running job, so a job that stopped running must lose them: an
   * abandoned task is expired by the read path without any further observation to clear the map.
   */
  private pruneLiveParts() {
    if (this.liveParts.size === 0) return;
    const now = this.now().getTime();
    const live = new Set(this.store.listJobs(DOWNLOAD_JOB_LIMIT)
      .filter((row) => ACTIVE_JOB_STATUSES.includes(row.status as RemoteTaskStatus) && Date.parse(row.expiresAt) > now)
      .map((row) => row.taskId));
    for (const taskId of this.liveParts.keys()) if (!live.has(taskId)) this.liveParts.delete(taskId);
  }

  start() {
    if (this.timer !== null) return;
    const interval = this.options.probeIntervalMs ?? EGRESS_PROBE_INTERVAL_MS;
    this.timer = setInterval(() => { void this.tick(); }, interval);
    this.timer.unref?.();
    void this.hydrate().catch(() => undefined);
    void this.tick();
  }

  shutdown() { this.stopObserving(); if (this.timer !== null) { clearInterval(this.timer); this.timer = null; } }

  /**
   * Peers that may serve one range each. Sorted by node id so the same mesh produces the same part
   * layout twice, which is what lets an interrupted job resume instead of starting over.
   */
  private segmentSources(nodes: readonly AgentNodeState[], selfNodeId: string, maxNodes: number) {
    return nodes
      .filter((node) => node.nodeId !== selfNodeId && this.isEligible(node) && isNodeLive(node) && node.meshAssignment)
      .map((node) => ({ nodeId: node.nodeId, overlayAddress: node.meshAssignment!.overlayAddress, port: this.port(node) }))
      .flatMap((source) => source.port === null ? [] : [{ nodeId: source.nodeId, overlayAddress: source.overlayAddress, port: source.port }])
      .sort((left, right) => left.nodeId.localeCompare(right.nodeId))
      .slice(0, maxNodes);
  }

  /**
   * Creates the fill task. A segmented job names the peers that may serve parts; otherwise the
   * audit records the egress choice and its reason. A node over its monthly quota keeps the cache
   * and its own direct path but loses both acceleration paths, which is where the cost came from.
   */
  async download(input: NetworkCacheDownloadRequest, requester: string, traceId: string,
    access: { permissions: ReadonlySet<Permission>; nodeScope: NodeScope }, authorize: () => void) {
    const host = new URL(input.url).hostname;
    const base = { url: input.url, ...(input.digest ? { digest: input.digest } : {}), ...(input.maxBytes ? { maxBytes: input.maxBytes } : {}) };
    const quota = this.quota(input.nodeId);
    const sources = input.segments && !quota.degraded
      ? this.segmentSources((await this.repository.read({ sections: ["nodes"] })).nodes, input.nodeId, input.segments.maxNodes)
      : [];

    if (sources.length > 0) {
      const task: RemoteTaskRecord = await this.remoteTasks.createWithEgress(input.nodeId, {
        type: "network.cache.fetch",
        parameters: { ...base, segments: { sources } },
        expiresInSeconds: input.expiresInSeconds ?? 900,
        idempotencyKey: input.idempotencyKey ?? randomUUID(),
      }, requester, traceId, access, authorize);
      await this.repository.update((state) => {
        state.audits.push(audit(this.now().toISOString(), {
          requester, nodeId: input.nodeId, taskId: task.taskId, event: "network.segments.plan", taskType: "network.cache.fetch",
          parameters: { host, sourceCount: sources.length, sources: sources.map((source) => source.nodeId), reason: "selected" },
          fromStatus: null, toStatus: "queued", resultSummary: null, traceId,
        }));
      }, { sections: ["audits"] });
      return { taskId: task.taskId, nodeId: task.targetNodeId, selection: null, segments: { sources } };
    }

    const selection = await this.select(host, input.nodeId);
    const egress = !quota.degraded && selection.nodeId && selection.overlayAddress && selection.dataPlanePort
      ? { nodeId: selection.nodeId, overlayAddress: selection.overlayAddress, port: selection.dataPlanePort }
      : undefined;
    const task: RemoteTaskRecord = await this.remoteTasks.createWithEgress(input.nodeId, {
      type: "network.cache.fetch",
      parameters: { ...base, ...(egress ? { egress } : {}) },
      expiresInSeconds: input.expiresInSeconds ?? 900,
      idempotencyKey: input.idempotencyKey ?? randomUUID(),
    }, requester, traceId, access, authorize);
    await this.repository.update((state) => {
      // A caller that asked for segments and got none still needs to know why the plan was dropped.
      if (input.segments) state.audits.push(audit(this.now().toISOString(), {
        requester, nodeId: input.nodeId, taskId: task.taskId, event: "network.segments.plan", taskType: "network.cache.fetch",
        parameters: { host, sourceCount: 0, sources: [], reason: quota.degraded ? "quota" : "no-source" },
        fromStatus: null, toStatus: "queued", resultSummary: null, traceId,
      }));
      state.audits.push(audit(this.now().toISOString(), {
        requester, nodeId: input.nodeId, taskId: task.taskId, event: selection.nodeId && egress ? "egress.selected" : "egress.local",
        taskType: "network.cache.fetch",
        parameters: { host, egressNodeId: egress ? selection.nodeId : null, reason: quota.degraded ? "quota" : selection.reason, score: selection.score },
        fromStatus: null, toStatus: "queued", resultSummary: null, traceId,
      }));
      if (quota.degraded) state.audits.push(audit(this.now().toISOString(), {
        requester, nodeId: input.nodeId, taskId: task.taskId, event: "network.traffic.quota", taskType: "network.cache.fetch",
        parameters: {
          host, monthStart: quota.monthStart, quotaBytes: quota.quotaBytes, totalBytes: quota.totalBytes,
          dropped: [input.segments ? "segments" : null, selection.nodeId ? "egress" : null].filter(Boolean),
        },
        fromStatus: null, toStatus: "queued", resultSummary: null, traceId,
      }));
    }, { sections: ["audits"] });
    return { taskId: task.taskId, nodeId: task.targetNodeId, selection: quota.degraded ? null : selection, segments: null };
  }

  /**
   * The panel reads durable job rows: a job is a `network.cache.fetch` task plus the fill result it
   * carries once it ends. The monthly meter is summed from the same rows and their part attribution.
   */
  async jobs(access: { permissions: ReadonlySet<Permission>; nodeScope: NodeScope }): Promise<NetworkCacheDownloadJobListResponse> {
    if (!access.permissions.has("tasks:read")) throw new ServiceError(403, "FORBIDDEN", "缺少任务读取权限");
    const now = this.now();
    const scope = access.nodeScope === "all" ? undefined : access.nodeScope;
    const state = await this.repository.read({ sections: ["nodes"] });
    const names = new Map(state.nodes.map((node) => [node.nodeId, node.nodeName]));
    const jobs = this.store.listJobs(DOWNLOAD_JOB_LIMIT, scope).map((row) => {
      const view = storedJob(row, names.get(row.nodeId) ?? null, now);
      // The row decides whether a job is still running, including a lifetime that lapsed unnoticed;
      // a job that stopped running has no live rates to carry.
      return ACTIVE_JOB_STATUSES.includes(view.status as RemoteTaskStatus)
        ? { ...view, parts: this.liveParts.get(row.taskId) ?? [] }
        : view;
    });
    const quotaBytes = this.options.trafficQuotaBytes ?? 0;
    const monthStart = monthStartOf(now);
    const traffic = this.store.trafficSince(monthStart, scope)
      .map((record) => ({
        nodeId: record.nodeId, nodeName: names.get(record.nodeId) ?? null,
        receivedBytes: record.receivedBytes, originBytes: record.originBytes, servedBytes: record.servedBytes,
        degraded: quotaBytes > 0 && downloadTrafficTotal(record) >= quotaBytes,
      }))
      .sort((left, right) => (right.receivedBytes + right.servedBytes) - (left.receivedBytes + left.servedBytes) || left.nodeId.localeCompare(right.nodeId));
    return { jobs, traffic: { monthStart, quotaBytes, nodes: traffic }, collectedAt: now.toISOString() };
  }

  /**
   * A retry re-runs a finished job's own parameters against the current mesh, so it introduces no
   * URL the Controller has not already accepted. The idempotency key is derived from the source
   * task, which makes a double click return the same replacement instead of queueing two.
   */
  async retry(taskId: string, requester: string, traceId: string,
    access: { permissions: ReadonlySet<Permission>; nodeScope: NodeScope }): Promise<NetworkCacheDownloadResponse> {
    const source = await this.remoteTasks.getReadOnly(taskId);
    if (!source || source.type !== "network.cache.fetch") throw new ServiceError(404, "NOT_FOUND", "下载任务不存在");
    if (!terminalTaskStatuses.includes(source.status)) throw new ServiceError(409, "BAD_REQUEST", "任务尚未结束，不能重试");
    const parameters = NetworkCacheFetchTaskParametersSchema.parse(source.parameters);
    const lifetime = Math.round((Date.parse(source.expiresAt) - Date.parse(source.createdAt)) / 1000);
    const response = await this.download({
      nodeId: source.targetNodeId, url: parameters.url,
      ...(parameters.digest ? { digest: parameters.digest } : {}),
      ...(parameters.maxBytes ? { maxBytes: parameters.maxBytes } : {}),
      ...(parameters.segments ? { segments: { maxNodes: Math.max(2, parameters.segments.sources.length) } } : {}),
      expiresInSeconds: Math.min(900, Math.max(30, lifetime)),
      idempotencyKey: `retry-${source.taskId}`,
    }, requester, traceId, access, () => undefined);
    await this.repository.update((state) => {
      state.audits.push(audit(this.now().toISOString(), {
        requester, nodeId: source.targetNodeId, taskId: response.taskId, event: "network.cache.retry", taskType: "network.cache.fetch",
        parameters: { sourceTaskId: source.taskId, host: new URL(parameters.url).hostname, segments: response.segments?.sources.length ?? 0 },
        fromStatus: null, toStatus: "queued", resultSummary: null, traceId,
      }));
    }, { sections: ["audits"] });
    return response;
  }

  /**
   * Node-to-node directory: peers sign with their enrolled Agent key and this is the only place an
   * egress learns which public key belongs to a caller.
   */
  async peerDirectory(nodeId: string): Promise<MeshPeerDirectoryResponse> {
    const state = await this.repository.read({ sections: ["nodes", "credentials"] });
    const self = state.nodes.find((node) => node.nodeId === nodeId);
    const controllerTime = this.now().toISOString();
    if (!self || self.revokedAt || !self.meshAssignment || !this.isEligible(self)) return { self: null, peers: [], controllerTime };
    const credentialFor = (target: AgentNodeState) => state.credentials.find((credential) => credential.nodeId === target.nodeId && credential.revokedAt === null)?.publicKey ?? null;
    return {
      self: { overlayAddress: self.meshAssignment.overlayAddress, revision: self.meshAssignment.revision, dataPlanePort: this.port(self)! },
      peers: state.nodes.filter((node) => node.nodeId !== nodeId && this.isEligible(node)).flatMap((node) => {
        const publicKey = credentialFor(node);
        return publicKey === null ? [] : [{
          nodeId: node.nodeId, nodeName: node.nodeName, overlayAddress: node.meshAssignment!.overlayAddress,
          publicKey, dataPlanePort: this.port(node)!,
        }];
      }),
      controllerTime,
    };
  }
}
