import { randomUUID } from "node:crypto";
import {
  EGRESS_PROBE_INTERVAL_MS, EGRESS_PROBE_MAX_TARGETS, EGRESS_SAMPLE_STALE_SECONDS, MESH_DATA_PLANE_PORT,
  NetworkEgressProbeResultSchema, NetworkEgressProbeTaskParametersSchema,
  type AgentCapability, type CreateRemoteTaskRequest, type MeshPeerDirectoryResponse, type NetworkCacheDownloadRequest,
  type NetworkEgressNode, type NetworkEgressPlanResponse, type NetworkEgressSelection, type NetworkEgressSelectionReason,
  type NodeScope, type Permission, type RemoteTaskRecord,
} from "@stackpilot/contracts";
import type { AgentControlRepository, AgentNodeState, AuditEvent } from "../../repositories/agentControlRepository.js";
import { terminalTaskStatuses, type RemoteTaskService } from "../remote-tasks/remoteTaskService.js";

export const EGRESS_CAPABILITY: AgentCapability = "network.transfer";
/**
 * Below this rate a bounded read mostly measured body size, not link capacity, so the sample ranks as
 * latency evidence only. A 256 KiB read at this rate already takes sixteen seconds.
 */
const EGRESS_MEASURED_BYTES_PER_SECOND = 16 * 1024;

const audit = (timestamp: string, event: Omit<AuditEvent, "eventId" | "timestamp">): AuditEvent => ({ eventId: randomUUID(), timestamp, ...event });

type Sample = { host: string; ttfbMs: number; bytesPerSecond: number; collectedAt: string };
type NodeSamples = { samples: Map<string, Sample>; updatedAt: string };

export type EgressServiceOptions = {
  /** Probed sources; empty disables probing and leaves the table empty instead of inventing paths. */
  targets?: readonly string[];
  now?: () => Date;
  probeIntervalMs?: number;
};

/**
 * Collects each node's own measurement of its path to a source and answers "who should fetch this
 * host for that node". Nothing here touches packets: the Agent measures, the Controller ranks.
 */
export class EgressService {
  private readonly table = new Map<string, NodeSamples>();
  private readonly ingestedTaskIds = new Set<string>();
  private readonly lastProbeAt = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly repository: AgentControlRepository,
    private readonly remoteTasks: RemoteTaskService,
    private readonly options: EgressServiceOptions = {},
  ) {}

  private now() { return (this.options.now ?? (() => new Date()))(); }
  private get targets() { return [...new Set((this.options.targets ?? []).map((value) => value.trim()).filter(Boolean))].slice(0, EGRESS_PROBE_MAX_TARGETS); }
  private port(node: AgentNodeState) { return node.meshLink?.dataPlanePort ?? (node.meshAssignment ? MESH_DATA_PLANE_PORT : null); }

  private isEligible(node: AgentNodeState) {
    return !node.revokedAt && node.meshAssignment !== undefined
      && node.allowedCapabilities.includes(EGRESS_CAPABILITY) && node.declaredCapabilities.includes(EGRESS_CAPABILITY);
  }

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

  private project(node: AgentNodeState): NetworkEgressNode {
    const entry = this.table.get(node.nodeId);
    const samples = entry ? [...entry.samples.values()].sort((left, right) => left.host.localeCompare(right.host)).map((sample) => ({
      host: sample.host, ttfbMs: sample.ttfbMs, bytesPerSecond: sample.bytesPerSecond, collectedAt: sample.collectedAt, ageSeconds: this.ageSeconds(sample),
    })) : [];
    const status = !this.isEligible(node) ? "disabled"
      : samples.length === 0 ? "pending"
      // Same freshness rule as selection, so the table never advertises a node that routing skips.
      : samples.some((sample) => this.fresh(sample)) ? "ready"
      : "stale";
    return {
      nodeId: node.nodeId, nodeName: node.nodeName, status,
      overlayAddress: node.meshAssignment?.overlayAddress ?? null, dataPlanePort: this.port(node), samples,
    };
  }

  async plan(): Promise<NetworkEgressPlanResponse> {
    const nodes = (await this.repository.read({ sections: ["nodes"] })).nodes;
    const online = new Set(nodes.filter((node) => node.status === "online").map((node) => node.nodeId));
    const projected = nodes.map((node) => this.project(node));
    const warnings: string[] = [];
    if (this.targets.length === 0) warnings.push("未配置探测源（STACKPILOT_EGRESS_PROBE_TARGETS），出口质量表为空，所有下载都会本地直取");
    for (const node of projected) {
      if (node.status === "pending") warnings.push(`节点 ${node.nodeName} 尚未完成出口探测，暂不参与选路`);
      else if (node.status === "stale") warnings.push(`节点 ${node.nodeName} 的出口探测数据已过期，选路时会跳过该节点`);
      else if (node.status === "ready" && !online.has(node.nodeId)) warnings.push(`节点 ${node.nodeName} 已离线，即使样本新鲜也不参与选路`);
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
    const online = others.filter((node) => node.status === "online");
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
    for (const node of nodes.filter((value) => this.isEligible(value) && value.status === "online")) {
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
  async tick() { await this.collect().catch(() => undefined); await this.probe().catch(() => undefined); }

  start() {
    if (this.timer !== null) return;
    const interval = this.options.probeIntervalMs ?? EGRESS_PROBE_INTERVAL_MS;
    this.timer = setInterval(() => { void this.tick(); }, interval);
    this.timer.unref?.();
    void this.tick();
  }

  shutdown() { if (this.timer !== null) { clearInterval(this.timer); this.timer = null; } }

  /** Creates the fill task with the chosen egress; the audit records both the choice and its reason. */
  async download(input: NetworkCacheDownloadRequest, requester: string, traceId: string,
    access: { permissions: ReadonlySet<Permission>; nodeScope: NodeScope }, authorize: () => void) {
    const host = new URL(input.url).hostname;
    const selection = await this.select(host, input.nodeId);
    const egress = selection.nodeId && selection.overlayAddress && selection.dataPlanePort
      ? { nodeId: selection.nodeId, overlayAddress: selection.overlayAddress, port: selection.dataPlanePort }
      : undefined;
    const task: RemoteTaskRecord = await this.remoteTasks.createWithEgress(input.nodeId, {
      type: "network.cache.fetch",
      parameters: { url: input.url, ...(input.digest ? { digest: input.digest } : {}), ...(input.maxBytes ? { maxBytes: input.maxBytes } : {}), ...(egress ? { egress } : {}) },
      expiresInSeconds: input.expiresInSeconds ?? 900,
      idempotencyKey: input.idempotencyKey ?? randomUUID(),
    }, requester, traceId, access, authorize);
    await this.repository.update((state) => {
      state.audits.push(audit(this.now().toISOString(), {
        requester, nodeId: input.nodeId, taskId: task.taskId, event: selection.nodeId ? "egress.selected" : "egress.local",
        taskType: "network.cache.fetch",
        parameters: { host, egressNodeId: selection.nodeId, reason: selection.reason, score: selection.score },
        fromStatus: null, toStatus: "queued", resultSummary: null, traceId,
      }));
    }, { sections: ["audits"] });
    return { taskId: task.taskId, nodeId: task.targetNodeId, selection };
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
