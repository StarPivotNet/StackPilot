import { AlertTriangle, CheckCircle2, Database, HardDrive, ShieldAlert, Timer } from "lucide-react";
import { useMemo } from "react";
import { fetchCachePlan } from "../api/cacheApi";
import { ModulePageShell } from "../components/layout/ModulePageShell";
import { MetricTile } from "../components/ui/Cards";
import { DataTable } from "../components/ui/DataTable";
import { ResourceNavigation } from "../features/hosts/ResourceNavigation";
import { toCacheView, type CacheNodeView, type CacheView } from "../features/network/cacheModel";
import { usePollingResource } from "../hooks/usePollingResource";
import type { PageKey } from "../types/app";
import { formatBackendDateTime } from "../utils/time";

const page: PageKey = "hosts-cache";

function CacheMetrics({ view }: { view: CacheView | null }) {
  const count = (value: string) => (view ? value : "等待采集");
  return (
    <>
      <MetricTile icon={Database} label="缓存节点" value={count(String(view?.participantCount ?? 0))} tone="blue" />
      <MetricTile icon={CheckCircle2} label="指标就绪" value={count(`${view?.readyCount ?? 0} 个`)} tone="green" />
      <MetricTile icon={HardDrive} label="已用容量" value={count(view?.usageLabel ?? "")} tone="purple" />
      <MetricTile icon={Timer} label="淘汰条目" value={count(`${view?.evictions ?? 0} 条`)} tone={(view?.evictions ?? 0) > 0 ? "orange" : "gray"} />
    </>
  );
}

function CachePoolCard({ view }: { view: CacheView }) {
  const reporting = view.reportingCount;
  const total = view.nodes.length;
  return (
    <section className="mesh-overlay-card" aria-labelledby="cache-pool-title">
      <header className="mesh-overlay-head">
        <div>
          <p className="mesh-overlay-eyebrow">内容寻址缓存</p>
          <h2 id="cache-pool-title">{view.usageLabel}</h2>
        </div>
        <span className={`mesh-chip ${reporting > 0 && reporting === total ? "healthy" : "degraded"}`}>
          {reporting > 0 && reporting === total ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}
          {reporting} / {total} 个节点已上报
        </span>
      </header>
      <dl className="mesh-overlay-stats">
        <div><dt>命中率</dt><dd>{view.hitRateLabel}</dd></div>
        <div><dt>命中与回源</dt><dd>{view.hitLabel}</dd></div>
        <div><dt>缓存对象</dt><dd>{view.entryCount} 条</dd></div>
        <div><dt>淘汰条目</dt><dd>{view.evictions} 条</dd></div>
      </dl>
      {view.warnings.length > 0 && (
        <ul className="mesh-warnings" aria-label="缓存告警">
          {view.warnings.map((warning) => <li key={warning}><AlertTriangle size={14} /><span>{warning}</span></li>)}
        </ul>
      )}
    </section>
  );
}

function CacheStatusChip({ row }: { row: CacheNodeView }) {
  const Icon = row.statusIcon;
  return <span className={`mesh-chip ${row.statusTone}`}><Icon size={14} />{row.statusLabel}</span>;
}

const columns = [
  { key: "node", label: "节点", width: "200px", render: (row: CacheNodeView) => <span className="mesh-node-name" title={row.nodeName}>{row.nodeName}</span> },
  { key: "status", label: "状态", width: "120px", render: (row: CacheNodeView) => <CacheStatusChip row={row} /> },
  { key: "usage", label: "占用", width: "176px", render: (row: CacheNodeView) => <code className="mesh-address" title={`${row.usageLabel} · ${row.entryLabel}`}>{row.usageLabel}</code> },
  { key: "hit", label: "命中率", width: "168px", render: (row: CacheNodeView) => <span className="mesh-handshake-mobile" title={row.hitLabel}><span>{row.hitRateLabel}</span><small className="mesh-muted">{row.hitLabel}</small></span> },
  { key: "evictions", label: "淘汰", width: "88px", render: (row: CacheNodeView) => <span className="mesh-muted">{row.evictionLabel}</span> },
  { key: "free", label: "磁盘剩余", width: "120px", render: (row: CacheNodeView) => <span className="mesh-muted">{row.diskFreeLabel}</span> },
  { key: "collected", label: "采集时间", width: "188px", render: (row: CacheNodeView) => <span className="mesh-muted">{row.collectedLabel}</span> },
];

function MeshCachePage() {
  const { data, loading, error, backgroundError, retry } = usePollingResource(fetchCachePlan, null, true, "network-cache");
  const view = useMemo(() => (data ? toCacheView(data) : null), [data]);
  const subtitle = loading && !view
    ? "正在读取各节点的内容寻址缓存指标"
    : "缓存按内容寻址保存，同一节点重复拉取不再回源；节点之间互传尚未启用，指标每 10 秒自动刷新，超过 5 分钟未更新视为过期";

  return (
    <ModulePageShell
      title="共享缓存"
      subtitle={subtitle}
      page={page}
      className="resource-cloudpulse mesh-topology"
      viewContext={false}
      tabs={<ResourceNavigation module="hosts" page={page} />}
      metrics={<CacheMetrics view={view} />}
    >
      <p className="resource-freshness">后端采集于 {formatBackendDateTime(view?.updatedAt)}</p>
      {loading && !view && <span className="sr-only" role="status" aria-live="polite">正在从 /api/network/cache 读取缓存指标</span>}
      {error && (
        <div className="overview-error-state hosts-error-state">
          <ShieldAlert size={18} />
          <span>{error}</span>
          <button type="button" disabled={loading} onClick={() => void retry()}>重试</button>
        </div>
      )}
      {backgroundError && view && <p className="resource-freshness"><span className="red-text">最近一次刷新失败，展示上次成功数据</span></p>}
      {view && <CachePoolCard view={view} />}
      {view && view.nodes.length === 0 && (
        <div className="mesh-empty">
          <Database size={20} />
          <div>
            <strong>还没有节点启用共享缓存</strong>
            <p>节点完成注册、声明 network.cache.read 能力并上报缓存指标后，会自动出现在这里。本页每 10 秒自动刷新。</p>
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
                <CacheStatusChip row={row} />
              </div>
              <code className="module-card-code mesh-address">{row.usageLabel}</code>
              <div className="module-card-meta">
                <span><b>命中率</b><em>{row.hitRateLabel}</em></span>
                <span><b>对象</b><em>{row.entryLabel}</em></span>
                <span><b>淘汰</b><em>{row.evictionLabel}</em></span>
                <span><b>磁盘剩余</b><em>{row.diskFreeLabel}</em></span>
                <span><b>采集时间</b><em>{row.collectedLabel}</em></span>
              </div>
            </>
          )}
        />
      )}
    </ModulePageShell>
  );
}

export { MeshCachePage };
