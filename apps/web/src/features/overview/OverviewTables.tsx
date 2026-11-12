import type { OverviewAuditRow, OverviewNode, OverviewResourceRecord, OverviewRiskRecord, OverviewService, OverviewTaskRecord } from "../../api/overviewApi";
import { Activity, AlertTriangle, CheckCircle2, CircleX, Clock3, Eye, HardDrive, KeyRound, LoaderCircle, Server, ShieldAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { DetailDrawer } from "../../components/ui/DetailDrawer";
import { Sparkline } from "../../components/ui/StatusVisuals";
import { OverviewDiskUsage, OverviewNodeStatus, OverviewUsageRing } from "./OverviewUI";
import { formatOverviewBytes, overviewNodeCollectedAt, overviewNodeDisk, overviewNodeFieldAvailable, overviewNodeFreshness, taskTone } from "./model";
import type { Notify } from "../../types/app";
import { formatBackendDateTime } from "../../utils/time";

function freshnessLabel(node: OverviewNode) { return node.freshness === "stale" ? "数据已过期" : node.freshness === "awaiting" ? "等待遥测" : "已采集"; }

function OverviewServiceList({ services }: { services: OverviewService[] }) {
  return <div className="node-service-list">{services.map((service) => {
    const Icon = service.status === "健康" ? CheckCircle2 : service.status === "离线" ? ShieldAlert : AlertTriangle;
    return <article key={service.id}><Icon className={service.status === "健康" ? "green" : service.status === "离线" ? "red" : "orange"} size={20} aria-hidden="true" /><span><strong>{service.name}</strong><small>{service.target}</small>{service.process && <small className="overview-code">PID {service.process.pid} · {service.process.command}</small>}</span><span><b>{service.status}</b><small>{service.detail}</small>{service.latencyMs !== undefined && <small>{service.latencyMs} ms</small>}</span></article>;
  })}{services.length === 0 && <p className="node-detail-empty">未发现服务实例</p>}</div>;
}

function NodeDetailContent({ node }: { node: OverviewNode }) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Read-only details start at the visible close control, before the disk
    // inspection control further down the scrollable drawer.
    const close = root.current?.closest(".detail-drawer")?.querySelector<HTMLButtonElement>(".drawer-close-button");
    const focus = () => close?.focus({ preventScroll: true });
    focus();
    // StrictMode replays the shared drawer's deferred restore-focus cleanup.
    const frame = window.requestAnimationFrame(focus);
    return () => window.cancelAnimationFrame(frame);
  }, []);
  const disk = overviewNodeDisk(node);
  const facts = [
    ["节点 ID", node.id], ["IP 地址", node.ip], ["环境", node.env], ["来源", node.source === "agent" ? "Agent" : "Controller"],
    ["网络延迟", node.availability.latency ? node.latency : "暂不可用"], ["版本", node.version], ["运行时间", node.uptime],
    ["最后备份", node.availability.backup ? node.backup : "暂不可用"], ["更新状态", node.availability.update ? node.update : "暂不可用"], ["负责人", node.owner],
    ["采集时间", formatBackendDateTime(overviewNodeCollectedAt(node), "暂不可用")],
  ];
  return <div className="node-detail-content" ref={root}>
    <section className="node-detail-summary"><span className="node-detail-summary-icon"><Server size={24} aria-hidden="true" /></span><div><span>节点状态</span><OverviewNodeStatus node={node} /></div><div><span>数据状态</span><strong>{freshnessLabel(node)}</strong></div></section>
    <section className="node-detail-section"><header><Server size={20} aria-hidden="true" /><strong>节点信息</strong></header><dl className="overview-node-facts">{facts.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value || "暂不可用"}</dd></div>)}</dl></section>
    <section className="node-detail-section"><header><Activity size={20} aria-hidden="true" /><strong>资源使用</strong></header><div className="overview-node-rings"><div><span>CPU</span>{node.availability.cpu ? <OverviewUsageRing value={node.cpu} label="CPU 使用率" /> : <span>暂不可用</span>}</div><div><span>内存</span>{node.availability.memory ? <OverviewUsageRing value={node.memory} label="内存使用率" tone="purple" /> : <span>暂不可用</span>}</div><div><span>全部磁盘</span><OverviewDiskUsage node={node} /></div></div>{overviewNodeFreshness(node) === "stale" && <p className="overview-caption">资源值来自最近一次成功采集，数据已过期。</p>}</section>
    {node.availability.disk && disk.volumes.length > 0 && <section className="node-detail-section"><header><HardDrive size={20} aria-hidden="true" /><strong>磁盘明细</strong></header><div className="overview-disk-volumes">{disk.volumes.map((volume) => <div key={`${volume.mount}-${volume.label}`}><span><b>{volume.label || volume.mount}</b><small>{volume.mount}</small></span><span>{volume.percent}%<small>{formatOverviewBytes(volume.usedBytes)} / {formatOverviewBytes(volume.totalBytes)}</small></span></div>)}</div><p className="overview-caption">全部卷容量加权 {disk.value} · {formatOverviewBytes(disk.used)} / {formatOverviewBytes(disk.total)}</p></section>}
    <section className="node-detail-section"><header><Server size={20} aria-hidden="true" /><strong>服务列表</strong>{node.availability.services && <span>{node.services.length} 个实例</span>}</header>{node.availability.services ? <OverviewServiceList services={node.services} /> : <p className="node-detail-empty">暂不可用</p>}</section>
  </div>;
}

function HostTable({ nodes, allNodes = nodes }: { nodes: OverviewNode[]; allNodes?: OverviewNode[]; notify: Notify }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = allNodes.find((node) => node.id === selectedId) ?? null;
  // Clear a removed identity rather than reopening it if the ID later returns.
  if (selectedId && !selected) setSelectedId(null);
  const detailButton = (node: OverviewNode) => <button className="icon-action" type="button" onClick={() => setSelectedId(node.id)} aria-label={`查看 ${node.name} 节点详情`} title="查看详情"><Eye size={16} aria-hidden="true" /></button>;
  const resource = (node: OverviewNode, field: "cpu" | "memory") => node.availability[field] ? node[field] : "暂不可用";
  return <><div className="overview-host-desktop"><table className="overview-host-table"><thead><tr><th>节点</th><th>状态</th><th>CPU / 内存</th><th>延迟</th><th><span className="sr-only">操作</span></th></tr></thead><tbody>{nodes.map((node) => <tr key={node.id}><td><div className="overview-host-identity"><strong title={node.name}>{node.name}</strong><code>{node.ip}</code>{node.freshness !== "current" && <small>{freshnessLabel(node)} · {formatBackendDateTime(node.collectedAt, "等待采集")}</small>}</div></td><td><OverviewNodeStatus node={node} /></td><td><div className="overview-host-resources"><span>CPU <b>{resource(node, "cpu")}</b></span><span>内存 <b>{resource(node, "memory")}</b></span></div></td><td>{node.availability.latency ? node.latency : "暂不可用"}</td><td>{detailButton(node)}</td></tr>)}</tbody></table></div>
    <div className="overview-host-mobile">{nodes.map((node) => <article key={node.id}><header><div className="overview-host-identity"><strong>{node.name}</strong><code>{node.ip}</code></div><OverviewNodeStatus node={node} /></header><div className="overview-mobile-resources"><span>CPU <b>{resource(node, "cpu")}</b></span><span>内存 <b>{resource(node, "memory")}</b></span><span>磁盘 <OverviewDiskUsage node={node} compact /></span></div><footer><span className="overview-caption">{node.availability.latency ? `延迟 ${node.latency}` : "延迟暂不可用"} · {freshnessLabel(node)}</span>{detailButton(node)}</footer></article>)}</div>
    {!nodes.length && <p className="feed-empty">等待采集节点</p>}
    {selected && <DetailDrawer title={selected.name} subtitle={`${selected.ip} · ${selected.env}`} onClose={() => setSelectedId(null)} className="health-node-drawer" modal autoFocus={false}><NodeDetailContent node={selected} /></DetailDrawer>}
  </>;
}

function FeedStatusIcon({ status }: { status: OverviewTaskRecord["status"] | OverviewAuditRow[5] }) {
  const Icon = status === "成功" ? CheckCircle2 : status === "失败" || status === "取消" ? CircleX : status === "运行中" ? LoaderCircle : Clock3;
  return <span className={`feed-status-icon ${taskTone(status)}`} aria-hidden="true"><Icon size={20} /></span>;
}
function TaskTable({ tasks, queued }: { tasks: OverviewTaskRecord[]; queued?: boolean }) {
  const rows = (queued ? tasks.filter((task) => ["运行中", "等待"].includes(task.status)) : tasks).slice(0, 6);
  return <div className="task-flow">{rows.map((row) => <div key={row.id}><FeedStatusIcon status={row.status} /><span className="feed-copy"><strong>{row.title}</strong><p>{row.type} · {row.target}</p><time>{row.queuedAt} · 采集 {formatBackendDateTime(row.collectedAt)}</time></span><span className="feed-result"><b className={`${taskTone(row.status)}-text`}>{row.status}</b><small>{row.duration}</small></span></div>)}{!rows.length && <div className="feed-empty" role="status" aria-label="任务采集状态">暂无任务，自动采集将继续运行</div>}</div>;
}
function AuditTable({ rows }: { rows: OverviewAuditRow[] }) {
  return <div className="audit-feed">{rows.slice(0, 6).map((row) => <article key={row[0] + row[6]}><FeedStatusIcon status={row[5]} /><span className="feed-copy"><strong>{row[3]}</strong><span className="feed-context"><span>{row[1]}</span><span>{row[2]}</span><span>{row[4]}</span></span><time>{row[0]}</time></span><span className="feed-result"><b className={row[5] === "失败" ? "red-text" : "green-text"}>{row[5]}</b><code>{row[6]}</code></span></article>)}{!rows.length && <div className="feed-empty">暂无近期动态</div>}</div>;
}
function RiskList({ risks }: { risks: OverviewRiskRecord[] }) {
  return <div className="risk-list">{risks.slice(0, 4).map((row) => <div className="overview-risk-item" key={row.id}><header><KeyRound className={row.level === "高危" ? "red" : row.level === "中危" ? "orange" : "blue"} size={20} aria-hidden="true" /><strong>{row.title}</strong></header><p>{row.target}</p><footer><span className={row.level === "高危" ? "red-text" : row.level === "中危" ? "orange-text" : "blue-text"}>{row.level}</span><time>{row.detected}</time></footer><span className="overview-caption">负责人 · {row.owner}</span></div>)}{!risks.length && <div className="risk-empty"><CheckCircle2 size={20} /><span>当前没有实时风险</span></div>}</div>;
}

function WorkbenchProgress({ node, taskCount, riskCount }: { node: OverviewNode | null; taskCount: number; riskCount: number }) {
  return <div className="workbench-progress"><header><span>{node?.name ?? "等待采集"}</span><strong>{node?.version ?? "版本暂不可用"}</strong></header><p>待处理任务 {taskCount} · 风险 {riskCount} · {node?.owner || "等待采集"}</p><div className="progress-meta"><span>CPU {node?.availability.cpu ? node.cpu : "暂不可用"}</span><span>内存 {node?.availability.memory ? node.memory : "暂不可用"}</span><span>磁盘 {node?.availability.disk ? overviewNodeDisk(node).value : "暂不可用"}</span></div>{node && <p className="overview-caption">{freshnessLabel(node)} · {formatBackendDateTime(node.collectedAt, "等待采集")}</p>}</div>;
}
function ResourceOverview({ resources }: { resources: OverviewResourceRecord[] }) {
  if (!resources.length) return <div className="feed-empty">等待遥测</div>;
  return <div className="resource-grid">{resources.map((resource) => <article key={resource.label}><div><span>{resource.label}</span><em>{resource.freshness === "stale" ? `数据已过期 · ${formatBackendDateTime(resource.collectedAt, "暂不可用")}` : resource.delta}</em></div><strong>{resource.value}</strong>{resource.values.length ? <Sparkline values={resource.values} tone="blue" /> : <span className="resource-unavailable">暂不可用</span>}<time className="overview-caption">采集于 {formatBackendDateTime(resource.collectedAt, "等待采集")}</time></article>)}</div>;
}
function ServiceSummary({ nodes }: { nodes: OverviewNode[] }) {
  const services = nodes.flatMap((node) => overviewNodeFieldAvailable(node, "services") ? node.services.map((service) => ({ ...service, nodeId: node.id })) : []);
  return <div className="overview-service-summary">{services.slice(0, 8).map((service) => <div key={`${service.nodeId}-${service.id}`}><span><Server size={20} aria-hidden="true" /><b>{service.name}</b></span><span className={`overview-semantic-status ${service.status === "健康" ? "green" : service.status === "离线" ? "red" : "orange"}`}>{service.status === "健康" ? <CheckCircle2 size={16} aria-hidden="true" /> : <AlertTriangle size={16} aria-hidden="true" />}{service.status}</span></div>)}{!services.length && <p className="feed-empty">尚无可用服务数据</p>}</div>;
}

export { AuditTable, HostTable, NodeDetailContent, ResourceOverview, RiskList, ServiceSummary, TaskTable, WorkbenchProgress };
