import { fetchOverviewHealth } from "../api/overviewApi";
import { createAgentEnrollment, listAgentNodes, listRemoteTasks, type EnrollmentCredential } from "../api/agentApi";
import type { AgentNodeRecord, RemoteTaskRecord } from "@stackpilot/contracts";
import type { OverviewNode } from "../api/overviewApi";
import { Activity, CheckCircle2, Eye, KeyRound, RefreshCw, Server, ShieldAlert, X } from "lucide-react";
import { useState } from "react";
import { ModulePageShell } from "../components/layout/ModulePageShell";
import { MetricTile, ModuleSearch } from "../components/ui/Cards";
import { DataTable } from "../components/ui/DataTable";
import { latencyValue, uniqueSorted } from "../utils/data";
import { DetailDrawer } from "../components/ui/DetailDrawer";
import { FieldSelect } from "../components/ui/FormControls";
import { Bar, StatusLight } from "../components/ui/StatusVisuals";
import { averageLatency, isCleanUpdate, percentValue } from "../features/hosts/model";
import { useOptionalOverviewData } from "../features/overview/OverviewDataProvider";
import { healthProbeTone, overviewNodeFieldAvailable, reportApiError } from "../features/overview/model";
import { useOverviewResource } from "../features/overview/useOverviewResource";
import { OverviewDiskUsage, OverviewFreshness, OverviewNavigation, OverviewNodeStatus, OverviewState, OverviewUsageRing } from "../features/overview/OverviewUI";
import { NodeDetailContent } from "./OverviewPage";
import type { Notify } from "../types/app";
import { reauthenticate } from "../api/identityApi";

function OverviewHealthPage({ notify }: { notify: Notify }) {
  const shared = useOptionalOverviewData();
  const local = useOverviewResource(fetchOverviewHealth, !shared, (reason) => reportApiError(reason, notify, "集群状态后端加载失败"));
  const [search, setSearch] = useState("");
  const [envFilter, setEnvFilter] = useState("全部");
  const [statusFilter, setStatusFilter] = useState("全部");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [agentOpen, setAgentOpen] = useState(false);
  const nodes = shared?.overview?.nodes ?? local.data?.nodes ?? [];
  const hasData = Boolean(shared?.overview || local.data);
  const loading = (shared?.loading ?? local.loading) && !hasData;
  const error = shared?.error ?? local.error;
  const collectedAt = shared?.overview?.collectedAt ?? local.data?.collectedAt;
  const selected = nodes.find((node) => node.id === selectedId) ?? null;
  if (selectedId && !selected) setSelectedId(null);
  const filteredNodes = nodes.filter((node) => {
    const query = search.trim().toLowerCase();
    const matchSearch = !query
      || node.name.toLowerCase().includes(query)
      || node.ip.includes(query)
      || node.owner.toLowerCase().includes(query)
      || node.version.toLowerCase().includes(query)
      || node.services.some((service) => [
        service.name,
        service.target,
        service.status,
        service.detail,
      ].join(" ").toLowerCase().includes(query));
    const matchEnv = envFilter === "全部" || node.env === envFilter;
    const matchStatus = statusFilter === "全部" || node.status === statusFilter;
    return matchSearch && matchEnv && matchStatus;
  });
  const warningCount = nodes.filter((node) => node.status !== "健康").length;
  const updateCount = nodes.filter((node) => overviewNodeFieldAvailable(node, "update") && !isCleanUpdate(node.update)).length;
  const envOptions = ["全部", ...uniqueSorted(nodes.map((node) => node.env))];
  const statusOptions = ["全部", ...uniqueSorted(nodes.map((node) => node.status))];
  const retry = () => { void (shared ? shared.reload() : local.reload()); };

  return (
    <ModulePageShell
      title="集群状态"
      subtitle="从整体健康到单个节点，掌握每一处运行状态。"
      page="overview-health"
      viewContext={false}
      tabs={<OverviewNavigation active="overview-health" />}
      actions={<><OverviewFreshness value={collectedAt} /><button className="ghost" type="button" onClick={() => setAgentOpen(true)}><KeyRound size={16} /> Agent 管理</button></>}
      filters={<><ModuleSearch value={search} placeholder="搜索节点、IP、服务、版本" onChange={setSearch} /><FieldSelect label="环境" value={envFilter} options={envOptions} onChange={setEnvFilter} /><FieldSelect label="状态" value={statusFilter} options={statusOptions} onChange={setStatusFilter} /></>}
      metrics={<><MetricTile icon={Server} label="全部节点" value={hasData ? `${nodes.length}` : "—"} tone="blue" /><MetricTile icon={CheckCircle2} label="健康节点" value={hasData ? `${nodes.filter((node) => node.status === "健康").length}` : "—"} tone="green" /><MetricTile icon={Activity} label="需要关注" value={hasData ? `${warningCount}` : "—"} tone={warningCount ? "orange" : "green"} /><MetricTile icon={ShieldAlert} label="离线节点" value={hasData ? `${nodes.filter((node) => node.status === "离线").length}` : "—"} tone={nodes.some((node) => node.status === "离线") ? "red" : "blue"} /></>}
    >
      {loading && <OverviewState loading title="正在采集节点状态" />}
      {error && <OverviewState error={error} title="集群状态暂不可用" onRetry={retry} />}
      <div className="health-workspace">
        <DataTable
          columns={[
            { key: "name", label: "节点", width: "28%", render: (row) => <span className="health-node-name" title={row.name}><b>{row.name}</b><code>{row.ip}</code></span> },
            { key: "status", label: "状态", width: "14%", render: (row) => <NodeStatus status={row.status} /> },
            { key: "latency", label: "延迟", width: "14%", sortValue: (row) => overviewNodeFieldAvailable(row, "latency") ? latencyValue(row.latency) : null, render: (row) => overviewNodeFieldAvailable(row, "latency") ? <span><StatusLight tone={healthProbeTone(row.latencyStatus)} /> {row.latency}</span> : <span>暂不可用</span> },
            { key: "cpu", label: "CPU", width: "18%", sortValue: (row) => overviewNodeFieldAvailable(row, "cpu") ? percentValue(row.cpu) : null, render: (row) => overviewNodeFieldAvailable(row, "cpu") ? <Bar value={row.cpu} tone={resourceTone(row, "orange")} /> : <span>暂不可用</span> },
            { key: "memory", label: "内存", width: "18%", sortValue: (row) => overviewNodeFieldAvailable(row, "memory") ? percentValue(row.memory) : null, render: (row) => overviewNodeFieldAvailable(row, "memory") ? <Bar value={row.memory} tone={resourceTone(row, "red")} /> : <span>暂不可用</span> },
            { key: "actions", label: "操作", width: "8%", render: (row) => (
              <div className="table-icon-actions health-node-actions">
                <button type="button" aria-label={`查看 ${row.name} 节点详情`} title="查看详情" onClick={() => setSelectedId(row.id)}>
                  <Eye size={15} />
                </button>
              </div>
            ) },
          ]}
          rows={filteredNodes}
          emptyText={error ? "节点数据暂不可用" : loading ? "正在采集节点状态" : nodes.length ? "没有匹配的集群节点" : "尚未采集到节点，自动采集将继续运行"}
          getRowKey={(row) => row.id}
          mobileCard={(row) => (
            <>
              <header className="module-card-head">
                <span className="module-card-title health-node-name"><strong>{row.name}</strong></span>
                <NodeStatus status={row.status} />
              </header>
              <div className="module-card-meta">
                <span><b>IP</b><em>{row.ip}</em></span>
                <span><b>环境</b><em>{row.env}</em></span>
                <span><b>延迟</b><em>{overviewNodeFieldAvailable(row, "latency") ? <><StatusLight tone={healthProbeTone(row.latencyStatus)} /> {row.latency}</> : "暂不可用"}</em></span>
                <span><b>版本</b><em>{row.version}</em></span>
              </div>
              <div className="health-mobile-resources"><div><span>CPU</span>{row.availability.cpu ? <OverviewUsageRing value={row.cpu} label="CPU 使用率" /> : <span>暂不可用</span>}</div><div><span>内存</span>{row.availability.memory ? <OverviewUsageRing value={row.memory} label="内存使用率" tone="purple" /> : <span>暂不可用</span>}</div><div><span>全部磁盘</span><OverviewDiskUsage node={row} /></div></div>
              <footer className="module-card-footer"><span>{row.owner}</span><button className="ghost small" type="button" onClick={() => setSelectedId(row.id)}><Eye size={13} /> 查看详情</button></footer>
            </>
          )}
        />
        <p className="overview-caption">待更新 {updateCount} 个节点 · 筛选结果 {filteredNodes.length} / {nodes.length}</p>
        <HealthSummaryPanel nodes={filteredNodes} allNodes={nodes} onSelect={(node) => setSelectedId(node.id)} />
      </div>
      {selected && (
        <DetailDrawer
          title={selected.name}
          subtitle={`${selected.ip} · ${selected.env}`}
          onClose={() => setSelectedId(null)}
          className="health-node-drawer"
          modal
          autoFocus={false}
        >
          <NodeDetailContent node={selected} />
        </DetailDrawer>
      )}
      {agentOpen && <AgentControlDrawer notify={notify} onClose={() => setAgentOpen(false)} />}
    </ModulePageShell>
  );
}

function NodeStatus({ status }: { status: OverviewNode["status"] }) {
  return <OverviewNodeStatus node={{ status }} />;
}

function nodeTone(status: OverviewNode["status"]) {
  return status === "健康" ? "green" : status === "警告" ? "orange" : status === "离线" ? "red" : "gray";
}

function resourceTone(node: OverviewNode, warning: "orange" | "red") {
  if (node.freshness === "stale" || node.status === "离线") return "blue";
  return node.status === "警告" ? warning : "green";
}

function AgentControlDrawer({ notify, onClose }: { notify: Notify; onClose: () => void }) {
  const [nodeName, setNodeName] = useState("");
  const [adminPassword, setAdminPassword] = useState("");
  const [nodes, setNodes] = useState<AgentNodeRecord[]>([]);
  const [tasks, setTasks] = useState<RemoteTaskRecord[]>([]);
  const [credential, setCredential] = useState<EnrollmentCredential | null>(null);
  const [busy, setBusy] = useState(false);
  const load = async () => {
    setBusy(true);
    try { const [nodePayload, taskPayload] = await Promise.all([listAgentNodes(), listRemoteTasks()]); setNodes(nodePayload.nodes); setTasks(taskPayload.tasks); }
    catch (error) { reportApiError(error, notify, "Agent 状态加载失败"); }
    finally { setBusy(false); }
  };
  const enroll = async () => {
    if (!nodeName.trim() || !adminPassword) { notify("请输入节点名称并确认当前密码"); return; }
    setBusy(true);
    try { const proof=await reauthenticate(adminPassword);setAdminPassword("");setCredential(await createAgentEnrollment({ nodeName: nodeName.trim(), expiresInSeconds: 300 },proof.proof)); notify("一次性注册凭据已创建"); }
    catch (error) { reportApiError(error, notify, "注册凭据创建失败"); }
    finally { setBusy(false); }
  };
  const close = () => { setCredential(null); onClose(); };
  return (
    <DetailDrawer title="Agent 节点" subtitle="节点注册与任务状态" onClose={close} className="agent-control-drawer" modal>
      <div className="agent-control-auth"><button className="primary" type="button" onClick={() => void load()} disabled={busy}><RefreshCw size={14} /> 加载</button></div>
      <div className="agent-enrollment-form">
        <label><span>节点名称</span><input value={nodeName} maxLength={120} onChange={(event) => setNodeName(event.target.value)} /></label>
        <label><span>当前密码确认</span><input type="password" autoComplete="current-password" value={adminPassword} onChange={(event)=>setAdminPassword(event.target.value)} /></label>
        <button type="button" onClick={() => void enroll()} disabled={busy || !nodeName.trim() || !adminPassword}><KeyRound size={14} /> 创建注册凭据</button>
      </div>
      {credential && <div className="agent-enrollment-result"><button type="button" aria-label="隐藏注册凭据" onClick={() => setCredential(null)}><X size={14} /></button><strong>一次性凭据</strong><code>{credential.token}</code><span>{new Date(credential.expiresAt).toLocaleString("zh-CN", { hour12: false })} 前有效</span></div>}
      <section className="agent-control-list"><header><strong>节点</strong><span>{nodes.length}</span></header>{nodes.length ? nodes.map((node) => <article key={node.nodeId}><StatusLight tone={node.status === "online" ? "green" : node.status === "revoked" ? "gray" : "orange"} /><span><b>{node.nodeName}</b><em>{node.platform} · Agent {node.agentVersion}</em></span><strong>{node.status}</strong></article>) : <p>尚未加载节点</p>}</section>
      <section className="agent-control-list"><header><strong>任务</strong><span>{tasks.length}</span></header>{tasks.slice(0, 20).map((task) => <article key={task.taskId}><StatusLight tone={task.status === "succeeded" ? "green" : task.status === "failed" ? "red" : task.status === "running" ? "blue" : "orange"} /><span><b>{task.type}</b><em>{task.targetNodeId}</em></span><strong>{task.status}</strong></article>)}</section>
    </DetailDrawer>
  );
}

function HealthSummaryPanel({
  nodes,
  allNodes,
  onSelect,
}: {
  nodes: OverviewNode[];
  allNodes: OverviewNode[];
  onSelect: (node: OverviewNode) => void;
}) {
  const envNames = uniqueSorted(allNodes.map((node) => node.env));
  const envGroups = (envNames.length > 0 ? envNames : ["未采集"]).map((env) => {
    const count = nodes.filter((node) => node.env === env).length;
    return { env, count, value: allNodes.length > 0 ? `${Math.round((count / allNodes.length) * 100)}%` : "0%" };
  });
  const attentionNodes = nodes
    .filter((node) => node.status !== "健康" || (overviewNodeFieldAvailable(node, "update") && !isCleanUpdate(node.update)))
    .slice(0, 3);
  const healthyNodes = nodes.filter((node) => node.status === "健康").length;
  const serviceCount = nodes.reduce((total, node) => total + node.services.length, 0);

  return (
    <aside className="health-side-panel" aria-label="集群状态摘要">
      <section>
        <header>
          <span>节点分布</span>
          <strong>{healthyNodes}/{nodes.length} 健康</strong>
        </header>
        <div className="health-env-list">
          {envGroups.map((group) => (
            <p key={group.env}>
              <span>{group.env}</span>
              <i><b style={{ width: group.value }} /></i>
              <em>{group.count}</em>
            </p>
          ))}
        </div>
      </section>
      <section>
        <header>
          <span>需要关注</span>
          <strong>{attentionNodes.length || "无"}</strong>
        </header>
        <div className="health-attention-list">
          {attentionNodes.length > 0 ? attentionNodes.map((node) => (
            <button key={node.id} type="button" onClick={() => onSelect(node)}>
              <StatusLight tone={nodeTone(node.status)} />
              <span title={node.name}><b>{node.name}</b><em>{node.status} · {node.update}</em></span>
            </button>
          )) : <p><StatusLight tone="green" /> 当前筛选内节点稳定</p>}
        </div>
      </section>
      <section className="health-side-stats">
        <p><span>服务实例</span><b>{serviceCount}</b></p>
        <p><span>平均延迟</span><b>{averageLatency(nodes)}</b></p>
      </section>
    </aside>
  );
}

export { OverviewHealthPage, HealthSummaryPanel };
