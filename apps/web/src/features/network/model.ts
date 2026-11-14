import { AlertTriangle, CheckCircle2, CircleDashed, CircleSlash, ShieldCheck, Timer } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { MESH_HANDSHAKE_TIMEOUT_SECONDS } from "@stackpilot/contracts";
import type { NetworkMeshHandshake, NetworkMeshNodeState, NetworkMeshPlanResponse } from "@stackpilot/contracts";
import type { Tone } from "../../types/app";

/** A link report older than this relative to the plan it shipped with cannot describe the current session. */
const LINK_STALE_SECONDS = 300;

type HandshakeState = "ok" | "silent" | "stale" | "idle" | "unknown";

type MeshNodeView = {
  nodeId: string;
  nodeName: string;
  status: NetworkMeshNodeState["status"];
  statusLabel: string;
  statusTone: Tone;
  statusIcon: LucideIcon;
  overlayAddress: string;
  configuredRevision: string;
  handshake: { state: HandshakeState; label: string; detail: string; tone: Tone; icon: LucideIcon };
  firewall: { label: string; detail: string; tone: "green" | "red" | "gray"; icon: LucideIcon; port: string | null };
  peerCount: number;
  activePeerCount: number;
};

type MeshView = {
  revision: number;
  overlayCidr: string;
  listenPort: number;
  updatedAt: string;
  nodes: MeshNodeView[];
  warnings: string[];
  readyCount: number;
  attentionCount: number;
  activePeerLinks: number;
  latestHandshake: string;
};

const statusMeta: Record<NetworkMeshNodeState["status"], { label: string; tone: Tone; icon: LucideIcon }> = {
  ready: { label: "已生效", tone: "green", icon: CheckCircle2 },
  stale: { label: "待应用", tone: "orange", icon: AlertTriangle },
  pending: { label: "待下发", tone: "blue", icon: Timer },
  disabled: { label: "未授权", tone: "gray", icon: CircleSlash },
};

const handshakeIcons: Record<HandshakeState, LucideIcon> = {
  ok: CheckCircle2, silent: AlertTriangle, stale: AlertTriangle, idle: CircleSlash, unknown: CircleDashed,
};

function formatHandshakeAge(seconds: number) {
  if (seconds < 60) return `${seconds} 秒前`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)} 分钟前`;
  return `${Math.floor(seconds / 3_600)} 小时前`;
}

function describeHandshake(handshake: NetworkMeshHandshake | null, updatedAt: string): MeshNodeView["handshake"] {
  const withIcon = (state: HandshakeState, label: string, detail: string, tone: Tone) => ({ state, label, detail, tone, icon: handshakeIcons[state] });
  if (!handshake) return withIcon("unknown", "等待上报", "Agent 还没有上报过链路数据", "gray");
  if (handshake.peerCount === 0) return withIcon("idle", "无对端", "组网内还没有其他成员需要建链", "gray");
  if (handshake.ageSeconds === null) return withIcon("silent", "从未握手", "检查对端是否放通 UDP 端口与公钥是否一致", "red");
  const linkAge = Math.max(0, Math.floor((Date.parse(updatedAt) - Date.parse(handshake.collectedAt)) / 1_000));
  if (Number.isFinite(linkAge) && linkAge > LINK_STALE_SECONDS) return withIcon("stale", "数据过期", `最近一次链路采集在 ${formatHandshakeAge(linkAge)}`, "orange");
  if (handshake.ageSeconds > MESH_HANDSHAKE_TIMEOUT_SECONDS) return withIcon("silent", formatHandshakeAge(handshake.ageSeconds), `超过 ${MESH_HANDSHAKE_TIMEOUT_SECONDS} 秒没有握手，链路可能已中断`, "red");
  return withIcon("ok", formatHandshakeAge(handshake.ageSeconds), "", "green");
}

function describeFirewall(node: NetworkMeshNodeState): MeshNodeView["firewall"] {
  const port = node.dataPlanePort === null ? null : `TCP ${node.dataPlanePort}`;
  if (node.firewallEnforced === true) return { label: "已生效", detail: "overlay 入向只放行数据面端口与 ICMP", tone: "green", icon: ShieldCheck, port };
  if (node.firewallEnforced === false) return { label: "未生效", detail: "该节点未能写入 nft 白名单，overlay 入向端口未受限", tone: "red", icon: AlertTriangle, port };
  return { label: "未上报", detail: "Agent 还没有上报端口白名单状态", tone: "gray", icon: CircleDashed, port: null };
}

/** A recorded revision is not a live link: a fail-closed rollback leaves the device down. */
function describeStatus(node: NetworkMeshNodeState) {
  if (node.status === "ready" && node.interfaceUp === false) return { statusLabel: "接口未启用", statusTone: "orange" as Tone, statusIcon: AlertTriangle };
  const meta = statusMeta[node.status];
  return { statusLabel: meta.label, statusTone: meta.tone, statusIcon: meta.icon };
}

function toMeshView(plan: NetworkMeshPlanResponse): MeshView {
  const nodes = plan.nodes.map((node): MeshNodeView => ({
    nodeId: node.nodeId,
    nodeName: node.nodeName,
    status: node.status,
    ...describeStatus(node),
    overlayAddress: node.overlayAddress ?? "未分配",
    configuredRevision: node.configuredRevision === null ? "未上报" : `r${node.configuredRevision}`,
    handshake: describeHandshake(node.handshake, plan.updatedAt),
    firewall: describeFirewall(node),
    peerCount: node.handshake?.peerCount ?? 0,
    activePeerCount: node.handshake?.activePeerCount ?? 0,
  }));
  const newest = plan.nodes
    .map((node) => node.handshake?.ageSeconds ?? null)
    .filter((age): age is number => age !== null)
    .reduce<number | null>((min, age) => (min === null || age < min ? age : min), null);
  return {
    revision: plan.revision,
    overlayCidr: plan.overlayCidr,
    listenPort: plan.listenPort,
    updatedAt: plan.updatedAt,
    nodes,
    warnings: plan.warnings,
    readyCount: nodes.filter((node) => node.status === "ready").length,
    attentionCount: nodes.filter((node) => node.status !== "ready" && node.status !== "disabled").length,
    activePeerLinks: nodes.reduce((sum, node) => sum + node.activePeerCount, 0),
    latestHandshake: newest === null ? "等待首次握手" : formatHandshakeAge(newest),
  };
}

function meshHandshakeIssues(view: MeshView | null) {
  if (!view) return 0;
  return view.nodes.filter((node) => node.handshake.state === "silent" || node.handshake.state === "stale").length;
}

export { meshHandshakeIssues, toMeshView };
export type { HandshakeState, MeshNodeView, MeshView };
