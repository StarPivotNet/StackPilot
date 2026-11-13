import { createHash, randomUUID } from "node:crypto";
import {
  MESH_HANDSHAKE_TIMEOUT_SECONDS,
  NetworkMeshConfigurationSchema,
  type AgentCapability,
  type NetworkMeshConfiguration,
  type NetworkMeshNodeState,
  type NetworkMeshPeerConfig,
  type NetworkMeshPlanResponse,
} from "@stackpilot/contracts";
import type { AgentControlRepository, AgentNodeState, AuditEvent } from "../../repositories/agentControlRepository.js";
import { ServiceError } from "../serviceError.js";
import type { RemoteTaskService } from "../remote-tasks/remoteTaskService.js";
import { terminalTaskStatuses } from "../remote-tasks/remoteTaskService.js";

export const MESH_CAPABILITY: AgentCapability = "network.mesh.configure";
export const MESH_LISTEN_PORT = 51820;
/** Retries per revision for a member that missed a broadcast; a broken node must not spin the queue. */
const MESH_RECONCILE_ATTEMPTS = 3;
export const MESH_MTU = 1420;
/** Shared CGNAT plan from p2p-mesh-plan.md; the controller never allocates outside it. */
const OVERLAY_BASE = "100.64.0.0";
const OVERLAY_SIZE = 2 ** 22;
const OVERLAY_CIDR = `${OVERLAY_BASE}/10`;

const audit = (event: Omit<AuditEvent, "eventId" | "timestamp">): AuditEvent => ({ eventId: randomUUID(), timestamp: new Date().toISOString(), ...event });

function ipToNumber(address: string) {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
}

function numberToIp(value: number) {
  return [value >>> 24, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff].join(".");
}

const OVERLAY_START = ipToNumber(OVERLAY_BASE)!;
const OVERLAY_END = OVERLAY_START + OVERLAY_SIZE - 1;

const insideOverlay = (address: string | null | undefined) => {
  if (!address) return false;
  const value = ipToNumber(address);
  return value !== null && value >= OVERLAY_START && value <= OVERLAY_END;
};

const isEligible = (node: AgentNodeState) => !node.revokedAt
  && node.allowedCapabilities.includes(MESH_CAPABILITY) && node.declaredCapabilities.includes(MESH_CAPABILITY);

function endpointFor(node: AgentNodeState): string | null {
  const address = node.telemetry?.primaryIp ?? null;
  if (!address || insideOverlay(address) || !address.includes(".")) return null;
  return `${address}:${MESH_LISTEN_PORT}`;
}

/** Deterministic per-node probe so an address never moves when unrelated nodes join. */
function allocate(nodeId: string, taken: ReadonlySet<string>, excluded: ReadonlySet<string>) {
  const seed = createHash("sha256").update(nodeId).digest();
  const start = seed.readUInt32BE(0) % (OVERLAY_SIZE - 2);
  for (let offset = 0; offset < OVERLAY_SIZE - 2; offset += 1) {
    const candidate = numberToIp(OVERLAY_START + 1 + ((start + offset) % (OVERLAY_SIZE - 2)));
    if (!taken.has(candidate) && !excluded.has(candidate)) return candidate;
  }
  throw new ServiceError(409, "BAD_REQUEST", "共享地址池已耗尽");
}

export class MeshService {
  constructor(private readonly repository: AgentControlRepository, private readonly remoteTasks: RemoteTaskService) {}

  /** Assignments are computed the same way for reads and writes; only `apply` persists them. */
  private reserve(nodes: readonly AgentNodeState[]) {
    const taken = new Set(nodes.flatMap((node) => node.meshAssignment ? [node.meshAssignment.overlayAddress] : []));
    const excluded = new Set(nodes.flatMap((node) => insideOverlay(node.telemetry?.primaryIp) ? [node.telemetry!.primaryIp!] : []));
    const addresses = new Map<string, string>();
    for (const node of nodes.filter(isEligible)) {
      const existing = node.meshAssignment?.overlayAddress;
      if (existing) { addresses.set(node.nodeId, existing); continue; }
      const address = allocate(node.nodeId, taken, excluded);
      taken.add(address); addresses.set(node.nodeId, address);
    }
    return addresses;
  }

  private buildConfiguration(node: AgentNodeState, revision: number, members: readonly AgentNodeState[]): NetworkMeshConfiguration {
    const peers: NetworkMeshPeerConfig[] = [];
    for (const member of members) {
      if (member.nodeId === node.nodeId || !member.meshIdentity?.publicKey || !member.meshAssignment?.overlayAddress) continue;
      peers.push({ publicKey: member.meshIdentity.publicKey, overlayAddress: member.meshAssignment.overlayAddress, endpoint: endpointFor(member) });
    }
    return NetworkMeshConfigurationSchema.parse({
      sourceRevision: revision, address: node.meshAssignment!.overlayAddress,
      listenPort: MESH_LISTEN_PORT, mtu: MESH_MTU, peers,
    });
  }

  private project(nodes: readonly AgentNodeState[], addresses: ReadonlyMap<string, string>, now: Date): NetworkMeshNodeState[] {
    return nodes.map((node) => {
      const target = node.meshAssignment?.revision ?? 0;
      const link = node.meshLink;
      return {
        nodeId: node.nodeId, nodeName: node.nodeName,
        status: !isEligible(node) ? "disabled"
          : !node.meshIdentity?.publicKey ? "pending"
          : target === 0 ? "pending"
          : node.meshIdentity.configuredRevision === target ? "ready"
          : "stale",
        overlayAddress: addresses.get(node.nodeId) ?? null,
        publicKey: node.meshIdentity?.publicKey ?? null,
        configuredRevision: node.meshIdentity?.configuredRevision ?? null,
        handshake: link ? {
          collectedAt: link.collectedAt,
          ageSeconds: link.latestHandshakeAt === null ? null : Math.max(0, Math.floor((now.getTime() - Date.parse(link.latestHandshakeAt)) / 1_000)),
          peerCount: link.peerCount, activePeerCount: link.activePeerCount,
        } : null,
        firewallEnforced: link?.firewallEnforced ?? null,
        dataPlanePort: link?.dataPlanePort ?? null,
        interfaceUp: link?.interfaceUp ?? null,
      };
    });
  }

  private warnings(nodeStates: readonly NetworkMeshNodeState[], nodes: readonly AgentNodeState[]): string[] {
    const warnings: string[] = [];
    const byId = new Map(nodes.map((node) => [node.nodeId, node]));
    for (const state of nodeStates) {
      const node = byId.get(state.nodeId);
      if (!node) continue;
      if (state.status === "pending" && node.meshIdentity?.publicKey) warnings.push(`节点 ${node.nodeName} 尚未收到配置 revision，请下发后再检查握手`);
      else if (!node.meshIdentity?.publicKey) warnings.push(`节点 ${node.nodeName} 尚未上报组网公钥，等 Agent 完成心跳后再下发`);
      else if (node.status !== "online") warnings.push(`节点 ${node.nodeName} 当前离线，配置会在恢复后生效`);
      if (insideOverlay(node.telemetry?.primaryIp)) warnings.push(`节点 ${node.nodeName} 的主机地址落在共享网段 100.64.0.0/10 内，需要人工确认是否冲突`);
      if (state.firewallEnforced === false) warnings.push(`节点 ${node.nodeName} 的 overlay 端口白名单未生效，请在该节点确认 nft 可用后重新下发配置`);
      if (state.interfaceUp === false) warnings.push(`节点 ${node.nodeName} 的 wg 接口处于 down，overlay 链路不可用，请重新下发配置`);
      if (state.status !== "ready" || state.handshake === null || state.handshake.peerCount === 0) continue;
      if (state.handshake.ageSeconds === null) warnings.push(`节点 ${node.nodeName} 已配置但从未完成握手，请检查 UDP ${MESH_LISTEN_PORT} 是否放通`);
      else if (state.handshake.ageSeconds > MESH_HANDSHAKE_TIMEOUT_SECONDS) warnings.push(`节点 ${node.nodeName} 最近一次握手在 ${Math.floor(state.handshake.ageSeconds / 60)} 分钟前，链路可能已中断`);
    }
    return warnings.slice(0, 20);
  }

  private planFrom(nodes: readonly AgentNodeState[]): NetworkMeshPlanResponse {
    const now = new Date();
    const revision = nodes.reduce((max, node) => Math.max(max, node.meshAssignment?.revision ?? 0, node.meshIdentity?.configuredRevision ?? 0), 0);
    const nodeStates = this.project(nodes, this.reserve(nodes), now);
    return { revision, overlayCidr: OVERLAY_CIDR, listenPort: MESH_LISTEN_PORT, updatedAt: now.toISOString(), nodes: nodeStates, warnings: this.warnings(nodeStates, nodes) };
  }

  async plan() {
    return this.planFrom((await this.repository.read({ sections: ["nodes"] })).nodes);
  }

  /** One task per target; `members` is the full peer set the configuration is built from. */
  private async dispatch(revision: number, members: readonly AgentNodeState[], targets: readonly AgentNodeState[], requester: string, traceId: string, attempt = 0) {
    const failed: string[] = [];
    for (const node of targets) {
      try {
        await this.remoteTasks.create(node.nodeId, {
          type: "network.mesh.configure",
          parameters: { revision, configuration: this.buildConfiguration(node, revision, members) },
          expiresInSeconds: 120, idempotencyKey: attempt === 0 ? `mesh-${revision}-${node.nodeId}` : `mesh-${revision}-${node.nodeId}-${attempt}`,
        }, requester, traceId);
      } catch { failed.push(node.nodeId); }
    }
    if (failed.length === 0) return;
    await this.repository.update((state) => {
      state.audits.push(audit({
        requester, nodeId: null, taskId: null, event: "network.mesh.dispatch-failed", taskType: "network.mesh.configure",
        parameters: { revision, nodeIds: failed, memberCount: members.length },
        fromStatus: null, toStatus: null, resultSummary: null, traceId,
      }));
    }, { sections: ["audits"] });
  }

  /** Persists stable overlay addresses, bumps the shared revision and dispatches one task per member. */
  async apply(requester: string, traceId: string): Promise<NetworkMeshPlanResponse> {
    let revision = 0;
    await this.repository.update((state) => {
      const candidates = state.nodes.filter(isEligible);
      if (candidates.length === 0) throw new ServiceError(409, "BAD_REQUEST", "没有已授权 network.mesh.configure 的节点，请先授权能力");
      const addresses = this.reserve(state.nodes);
      for (const node of candidates) {
        if (!node.meshAssignment) node.meshAssignment = { overlayAddress: addresses.get(node.nodeId)!, revision: 0 };
      }
      const members = candidates.filter((node) => node.meshIdentity?.publicKey);
      if (members.length === 0) throw new ServiceError(409, "BAD_REQUEST", "已授权节点都还没有上报组网公钥，请等待 Agent 心跳");
      revision = state.nodes.reduce((max, node) => Math.max(max, node.meshAssignment?.revision ?? 0, node.meshIdentity?.configuredRevision ?? 0), 0) + 1;
      for (const node of members) node.meshAssignment!.revision = revision;
      state.audits.push(audit({
        requester, nodeId: null, taskId: null, event: "network.mesh.revision-created", taskType: "network.mesh.configure",
        parameters: { revision, members: members.map((node) => node.nodeId) }, fromStatus: null, toStatus: "queued", resultSummary: null, traceId,
      }));
    }, { sections: ["nodes", "audits"] });
    const nodes = (await this.repository.read({ sections: ["nodes"] })).nodes;
    const members = nodes.filter((node) => isEligible(node) && node.meshIdentity?.publicKey && node.meshAssignment?.revision === revision);
    if (members.length === 0) throw new ServiceError(409, "BAD_REQUEST", "没有可下发的组网节点，请检查节点公钥与在线状态");
    await this.dispatch(revision, members, members, requester, traceId);
    return this.planFrom(nodes);
  }

  /**
   * Catches up a member that missed a broadcast while it was offline. An unfinished task for this
   * revision is left alone, and a finished one is retried under a new key, capped so a node that
   * keeps failing stops after a few rounds instead of spinning the queue.
   */
  async reconcileNode(nodeId: string, traceId: string) {
    try {
      const nodes = (await this.repository.read({ sections: ["nodes"] })).nodes;
      const node = nodes.find((item) => item.nodeId === nodeId);
      if (!node || !isEligible(node) || !node.meshIdentity?.publicKey || !node.meshAssignment) return;
      const revision = node.meshAssignment.revision;
      if (revision === 0 || node.meshIdentity.configuredRevision === revision) return;
      const sent = (await this.remoteTasks.list(nodeId)).filter((task) => task.type === "network.mesh.configure" && (task.parameters as { revision?: number } | null)?.revision === revision);
      // A second copy would race two applies of the same revision against one .conf file.
      if (sent.some((task) => !terminalTaskStatuses.includes(task.status))) return;
      if (sent.length >= MESH_RECONCILE_ATTEMPTS) return;
      const members = nodes.filter((item) => isEligible(item) && item.meshIdentity?.publicKey && item.meshAssignment?.revision === revision);
      await this.dispatch(revision, members, [node], "system:mesh-reconcile", traceId, sent.length);
    } catch { /* a catch-up is a side path: it must never turn a heartbeat into an error */ }
  }

  /**
   * Withdraws a revoked member: everyone still in the mesh gets a new revision whose peer list no
   * longer contains it, so the remaining nodes stop accepting its overlay packets.
   */
  async revokeMember(nodeId: string, requester: string, traceId: string): Promise<number> {
    let revision = 0;
    await this.repository.update((state) => {
      const revoked = state.nodes.find((node) => node.nodeId === nodeId);
      if (!revoked || (!revoked.meshAssignment && !revoked.meshIdentity)) return;
      const members = state.nodes.filter((node) => isEligible(node) && node.meshIdentity?.publicKey && node.meshAssignment);
      if (members.length > 0) {
        revision = state.nodes.reduce((max, node) => Math.max(max, node.meshAssignment?.revision ?? 0, node.meshIdentity?.configuredRevision ?? 0), 0) + 1;
        for (const node of members) node.meshAssignment!.revision = revision;
      }
      state.audits.push(audit({
        requester, nodeId, taskId: null, event: "network.mesh.peer-withdrawn", taskType: "network.mesh.configure",
        parameters: { revokedNodeId: nodeId, revision: revision > 0 ? revision : null, members: members.map((node) => node.nodeId) },
        fromStatus: null, toStatus: revision > 0 ? "queued" : null, resultSummary: null, traceId,
      }));
    }, { sections: ["nodes", "audits"] });
    if (revision === 0) return 0;
    const nodes = (await this.repository.read({ sections: ["nodes"] })).nodes;
    const members = nodes.filter((node) => isEligible(node) && node.meshIdentity?.publicKey && node.meshAssignment?.revision === revision);
    await this.dispatch(revision, members, members, requester, traceId);
    return revision;
  }
}
