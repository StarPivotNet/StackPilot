import { AlertTriangle, CheckCircle2, Network, ShieldAlert, Timer, Users } from "lucide-react";
import { useMemo } from "react";
import { fetchMeshPlan } from "../api/meshApi";
import { ModulePageShell } from "../components/layout/ModulePageShell";
import { MetricTile } from "../components/ui/Cards";
import { DataTable } from "../components/ui/DataTable";
import { ResourceNavigation } from "../features/hosts/ResourceNavigation";
import { meshHandshakeIssues, toMeshView, type MeshNodeView, type MeshView } from "../features/network/model";
import { usePollingResource } from "../hooks/usePollingResource";
import type { PageKey } from "../types/app";
import { formatBackendDateTime } from "../utils/time";

const page: PageKey = "hosts-mesh";

function MeshMetrics({ view }: { view: MeshView | null }) {
  const issues = meshHandshakeIssues(view);
  const count = (value: number) => (view ? String(value) : "等待采集");
  return (
    <>
      <MetricTile icon={Users} label="组网节点" value={count(view?.nodes.length ?? 0)} tone="blue" />
      <MetricTile icon={CheckCircle2} label="配置已生效" value={count(view?.readyCount ?? 0)} tone="green" />
      <MetricTile icon={Timer} label="待应用" value={count(view?.attentionCount ?? 0)} tone="orange" />
      <MetricTile icon={ShieldAlert} label="握手异常" value={count(issues)} tone={issues > 0 ? "red" : "gray"} />
    </>
  );
}

function MeshOverlayCard({ view }: { view: MeshView }) {
  const issues = meshHandshakeIssues(view);
  const healthy = issues === 0;
  return (
    <section className="mesh-overlay-card" aria-labelledby="mesh-overlay-title">
      <header className="mesh-overlay-head">
        <div>
          <p className="mesh-overlay-eyebrow">共享网络</p>
          <h2 id="mesh-overlay-title">{view.overlayCidr}</h2>
        </div>
        <span className={`mesh-chip ${healthy ? "healthy" : "degraded"}`}>
          {healthy ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}
          {healthy ? "链路正常" : `${issues} 个节点握手异常`}
        </span>
      </header>
      <dl className="mesh-overlay-stats">
        <div><dt>配置版本</dt><dd>r{view.revision}</dd></div>
        <div><dt>握手端口</dt><dd className="mesh-address">UDP {view.listenPort}</dd></div>
        <div><dt>最近握手</dt><dd>{view.latestHandshake}</dd></div>
        <div><dt>在线对端</dt><dd>{view.activePeerLinks} 个</dd></div>
      </dl>
      {view.warnings.length > 0 && (
        <ul className="mesh-warnings" aria-label="组网告警">
          {view.warnings.map((warning) => <li key={warning}><AlertTriangle size={14} /><span>{warning}</span></li>)}
        </ul>
      )}
    </section>
  );
}

function MeshStatusChip({ row }: { row: MeshNodeView }) {
  const Icon = row.statusIcon;
  return <span className={`mesh-chip ${row.statusTone}`}><Icon size={14} />{row.statusLabel}</span>;
}

function MeshHandshakeCell({ row }: { row: MeshNodeView }) {
  const Icon = row.handshake.icon;
  return (
    <span className={`mesh-handshake ${row.handshake.tone}`} title={row.handshake.detail}>
      <Icon size={14} />
      <span>{row.handshake.label}</span>
      {row.handshake.detail && <small>{row.handshake.detail}</small>}
    </span>
  );
}

function MeshFirewallCell({ row }: { row: MeshNodeView }) {
  const Icon = row.firewall.icon;
  const tone = row.firewall.tone === "gray" ? "mesh-muted" : row.firewall.tone === "red" ? "red-text" : "green-text";
  return (
    <span className={`mesh-firewall ${tone}`} title={row.firewall.detail}>
      <Icon size={14} />
      <span>{row.firewall.label}</span>
      {row.firewall.port && <small>{row.firewall.port}</small>}
    </span>
  );
}

function MeshPeerCell({ row }: { row: MeshNodeView }) {
  if (row.peerCount === 0) return <span className="mesh-muted">无对端</span>;
  return <span className={row.activePeerCount === row.peerCount ? "green-text" : row.activePeerCount === 0 ? "red-text" : "orange-text"}>{row.activePeerCount}/{row.peerCount} 在线</span>;
}

const columns = [
  { key: "node", label: "节点", width: "200px", render: (row: MeshNodeView) => <span className="mesh-node-name" title={row.nodeName}>{row.nodeName}</span> },
  { key: "overlay", label: "共享地址", width: "132px", render: (row: MeshNodeView) => <code className="mesh-address">{row.overlayAddress}</code> },
  { key: "status", label: "组网状态", width: "116px", render: (row: MeshNodeView) => <MeshStatusChip row={row} /> },
  { key: "handshake", label: "握手", width: "248px", render: (row: MeshNodeView) => <MeshHandshakeCell row={row} /> },
  { key: "firewall", label: "端口白名单", width: "132px", render: (row: MeshNodeView) => <MeshFirewallCell row={row} /> },
  { key: "peers", label: "对端", width: "104px", render: (row: MeshNodeView) => <MeshPeerCell row={row} /> },
  { key: "revision", label: "配置版本", width: "96px", render: (row: MeshNodeView) => <span className="mesh-muted">{row.configuredRevision}</span> },
];

function MeshTopologyPage() {
  const { data, loading, error, backgroundError, retry } = usePollingResource(fetchMeshPlan, null, true, "network-mesh");
  const view = useMemo(() => (data ? toMeshView(data) : null), [data]);
  const subtitle = loading && !view
    ? "正在读取共享网络配置与链路状态"
    : "所有 Agent 通过同一条私有网络互连，握手超过 3 分钟即视为链路异常";

  return (
    <ModulePageShell
      title="组网拓扑"
      subtitle={subtitle}
      page={page}
      className="resource-cloudpulse mesh-topology"
      viewContext={false}
      tabs={<ResourceNavigation module="hosts" page={page} />}
      metrics={<MeshMetrics view={view} />}
    >
      <p className="resource-freshness">后端采集于 {formatBackendDateTime(view?.updatedAt)}</p>
      {loading && !view && <span className="sr-only" role="status" aria-live="polite">正在从 /api/network/mesh 读取组网状态</span>}
      {error && (
        <div className="overview-error-state hosts-error-state">
          <ShieldAlert size={18} />
          <span>{error}</span>
          <button type="button" disabled={loading} onClick={() => void retry()}>重试</button>
        </div>
      )}
      {backgroundError && view && <p className="resource-freshness"><span className="red-text">最近一次刷新失败，展示上次成功数据</span></p>}
      {view && <MeshOverlayCard view={view} />}
      {view && view.nodes.length === 0 && (
        <div className="mesh-empty">
          <Network size={20} />
          <div>
            <strong>还没有节点加入组网</strong>
            <p>节点完成注册、声明 network.mesh.configure 能力并上报组网公钥后，会自动出现在这里。本页每 10 秒自动刷新。</p>
          </div>
        </div>
      )}
      {view && view.nodes.length > 0 && (
        <DataTable
          columns={columns}
          rows={view.nodes}
          emptyText="没有匹配的节点，系统会继续自动刷新"
          getRowKey={(row) => row.nodeId}
          mobileCard={(row) => (
            <>
              <div className="module-card-head host-mobile-head">
                <span className="mesh-node-name" title={row.nodeName}>{row.nodeName}</span>
                <MeshStatusChip row={row} />
              </div>
              <code className="module-card-code mesh-address">{row.overlayAddress}</code>
              <div className="mesh-handshake-mobile"><MeshHandshakeCell row={row} /></div>
              <div className="module-card-meta">
                <span><b>对端</b><em>{row.peerCount === 0 ? "无对端" : `${row.activePeerCount}/${row.peerCount} 在线`}</em></span>
                <span><b>白名单</b><em>{row.firewall.label}{row.firewall.port ? ` · ${row.firewall.port}` : ""}</em></span>
                <span><b>配置版本</b><em>{row.configuredRevision}</em></span>
              </div>
            </>
          )}
        />
      )}
    </ModulePageShell>
  );
}

export { MeshTopologyPage };
