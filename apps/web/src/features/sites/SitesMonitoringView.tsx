import { SiteNavigation } from "./SiteNavigation";
import {
  Activity, CheckCircle2, CircleHelp, CircleStop, Clock3, Code2, Eye, Globe2, Info, Server, Shield, TriangleAlert,
} from "lucide-react";
import { useCallback, useState } from "react";
import { resolvePageMeta } from "../../app/navigation";
import { ModulePageShell } from "../../components/layout/ModulePageShell";
import { MetricTile, ModuleSearch } from "../../components/ui/Cards";
import { DataTable } from "../../components/ui/DataTable";
import type { TableColumn } from "../../components/ui/DataTable";
import { DetailDrawer } from "../../components/ui/DetailDrawer";
import { FieldSelect } from "../../components/ui/FormControls";
import { StatusDot, StatusLight } from "../../components/ui/StatusVisuals";
import type { PageKey } from "../../types/app";
import { uniqueSorted } from "../../utils/data";
import { formatBackendDateTime } from "../../utils/time";
import {
  isSiteCertDue, runtimeGroupHealth, runtimeGroupsFromSites, siteStatusTone, siteTrafficGb, sitesPagePreset,
} from "./model";
import type { SiteRuntimeGroup, SiteRuntimeView } from "./types";
import { useSitesData } from "./useSitesData";
import { SiteOperationsDrawer } from "./SiteOperationsDrawer";

type SiteMode = "inventory" | "running" | "runtime";

function SitesMonitoringView({ page, canReadLogs, canOperate, canDeploy = false }: { page: PageKey; canReadLogs: boolean; canOperate: boolean; canDeploy?: boolean }) {
  const preset = sitesPagePreset(page);
  const mode: SiteMode = page === "sites-runtime" ? "runtime" : page === "sites-running" ? "running" : "inventory";
  const [searchByPage, setSearchByPage] = useState<Record<string, string>>({});
  const [statusByPage, setStatusByPage] = useState<Record<string, string>>({});
  const [runtimeByPage, setRuntimeByPage] = useState<Record<string, string>>({});
  const search = searchByPage[page] ?? preset.search;
  const statusFilter = statusByPage[page] ?? preset.status;
  const runtimeFilter = runtimeByPage[page] ?? preset.runtime;
  const setSearch = (value: string) => setSearchByPage((current) => ({ ...current, [page]: value }));
  const setStatusFilter = (value: string) => setStatusByPage((current) => ({ ...current, [page]: value }));
  const setRuntimeFilter = (value: string) => setRuntimeByPage((current) => ({ ...current, [page]: value }));
  const [selectedRuntime, setSelectedRuntime] = useState<string | null>(null);
  const [selectedSiteId, setSelectedSiteId] = useState<string | null>(null);
  const reconcileRows = useCallback((nextRows: SiteRuntimeView[]) => {
    setSelectedRuntime((current) => current && nextRows.some((row) => row.runtime === current) ? current : null);
    setSelectedSiteId((current) => current && nextRows.some((row) => row.id === current) ? current : null);
  }, []);
  const { rows, payload, loading, error, retry } = useSitesData(reconcileRows);
  const filteredRows = rows.filter((row) => {
    const query = search.trim().toLowerCase();
    const matchSearch = !query || [row.domain, row.runtime, row.host, row.upstream, row.source].join(" ").toLowerCase().includes(query);
    const matchStatus = statusFilter === "全部" || (statusFilter === "活跃"
      ? row.status === "运行中" || row.status === "告警" || row.status === "待采集" : row.status === statusFilter);
    return matchSearch && matchStatus && (runtimeFilter === "全部" || row.runtime === runtimeFilter);
  });
  const runtimeGroups = runtimeGroupsFromSites(filteredRows);
  const selectedGroup = selectedRuntime ? runtimeGroupsFromSites(rows).find((group) => group.runtime === selectedRuntime) ?? null : null;
  const selectedSite = selectedSiteId ? rows.find((row) => row.id === selectedSiteId) ?? null : null;
  const latencySamples = filteredRows.map((row) => row.latencyMs).filter((value): value is number => value !== null);
  const averageLatency = latencySamples.length
    ? `${Math.round(latencySamples.reduce((sum, value) => sum + value, 0) / latencySamples.length)}ms` : "暂不可用";
  const certDataAvailable = rows.some((row) => row.certDays !== null);
  const initialError = Boolean(error && !payload);
  const count = (value: number) => payload ? payload.collectionStatus === "unavailable" ? "暂不可用" : String(value) : "等待采集";

  const metrics = mode === "runtime"
    ? <><MetricTile icon={Code2} label="服务组" value={count(runtimeGroups.length)} tone="blue" /><MetricTile icon={Globe2} label="覆盖站点" value={count(filteredRows.length)} tone="green" /><MetricTile icon={Shield} label="证书风险" value={certDataAvailable ? `${filteredRows.filter(isSiteCertDue).length}` : "暂不可用"} tone="orange" /></>
    : mode === "running"
      ? <><MetricTile icon={Activity} label="已发现站点" value={count(filteredRows.length)} tone="green" /><MetricTile icon={Clock3} label="平均延迟" value={averageLatency} tone="blue" /><MetricTile icon={Shield} label="异常站点" value={count(filteredRows.filter((row) => row.status === "告警").length)} tone="orange" /></>
      : <><MetricTile icon={Globe2} label="站点" value={count(rows.length)} tone="blue" /><MetricTile icon={CheckCircle2} label="运行中" value={count(rows.filter((row) => row.status === "运行中").length)} tone="green" /><MetricTile icon={Shield} label="证书告警" value={certDataAvailable ? `${rows.filter(isSiteCertDue).length}` : "暂不可用"} tone="orange" /></>;
  const emptyText = error ? "实时采集失败，未显示示例站点" : loading ? "正在采集站点状态" : "未发现匹配的 Nginx 站点，系统将继续自动采集";

  return <ModulePageShell className="resource-cloudpulse"
    title={resolvePageMeta(page).title}
    subtitle={loading ? "正在加载已保存的站点快照" : `${preset.subtitle} · 后端采集于 ${formatBackendDateTime(payload?.collectedAt)}`}
    page={page}
    viewContext={false} tabs={<SiteNavigation page={page} canDeploy={canDeploy} />}
    filters={initialError ? undefined : <><ModuleSearch value={search} placeholder="搜索域名、上游、主机或数据源" onChange={setSearch} /><FieldSelect label="状态" value={statusFilter} options={mode === "running" ? ["活跃", "运行中", "告警", "待采集"] : ["全部", "运行中", "告警", "已停止", "待采集"]} onChange={setStatusFilter} /><FieldSelect label="服务" value={runtimeFilter} options={["全部", ...uniqueSorted(rows.map((row) => row.runtime))]} onChange={setRuntimeFilter} /></>}
    metrics={initialError ? undefined : metrics}
    side={selectedGroup ? <RuntimeDetail group={selectedGroup} onClose={() => setSelectedRuntime(null)} /> : selectedSite ? <SiteOperationsDrawer site={selectedSite} onClose={() => setSelectedSiteId(null)} onChanged={() => retry(undefined, true)} canReadLogs={canReadLogs} canOperate={canOperate} /> : null}
  >
    <SitesLoadState loading={loading} error={error} payload={payload} retry={() => void retry()} showCollectionNote={mode !== "runtime"} />
    {!initialError && mode === "runtime" && runtimeGroups.length > 0 && <section className="site-runtime-cards" aria-label="运行时分组">{runtimeGroups.map((group) => <article className="site-runtime-card" key={group.runtime}><h2><Code2 size={20} />{group.runtime}</h2><strong>{group.sites.length}<small>个站点</small></strong><StatusDot tone={runtimeGroupHealth(group).tone} text={runtimeGroupHealth(group).label} /><dl><div><dt>所属主机</dt><dd>{group.hosts || "暂不可用"}</dd></div><div><dt>平均延迟</dt><dd>{group.avgLatency}</dd></div><div><dt>证书风险</dt><dd>{group.certificateDataAvailable ? `${group.certDue} 个待检查` : "暂不可用"}</dd></div></dl><button className="ghost" type="button" onClick={() => setSelectedRuntime(group.runtime)}>查看分组详情</button></article>)}</section>}
    {!initialError && (mode === "runtime"
      ? <DataTable columns={runtimeColumns(setSelectedRuntime)} rows={runtimeGroups} emptyText={emptyText} getRowKey={(group) => group.runtime} mobileCard={(group) => <RuntimeMobileCard group={group} onOpen={setSelectedRuntime} />} />
      : <DataTable columns={siteColumns(mode, setSelectedSiteId)} rows={filteredRows} emptyText={emptyText} getRowKey={(row) => row.id} mobileCard={(row) => <SiteMobileCard row={row} mode={mode} onOpen={setSelectedSiteId} />} />)}
  </ModulePageShell>;
}

function SitesLoadState({ loading, error, payload, retry, showCollectionNote = true }: { loading: boolean; error: string | null; payload: ReturnType<typeof useSitesData>["payload"]; retry: () => void; showCollectionNote?: boolean }) {
  if (loading) return <span className="sr-only" role="status">正在从 /api/sites 加载站点快照</span>;
  if (error) return <div className="overview-error-state"><Shield size={18} /><span>{error}</span><button type="button" onClick={retry}>重试</button></div>;
  if (!showCollectionNote) return null;
  const status = payload?.collectionStatus === "complete" ? "采集完整" : payload?.collectionStatus === "partial" ? "部分采集" : "采集不可用";
  return <div className="runtime-collection-note" role="status"><Info size={16} /><span><strong>数据来源：Controller 本机与授权 Agent 的已保存快照</strong><small>{status} · 后端采集于 {formatBackendDateTime(payload?.collectedAt)}{payload?.warnings[0] ? ` · ${payload.warnings[0]}` : ""}</small></span></div>;
}

function siteStatus(row: SiteRuntimeView) {
  const Icon = row.status === "运行中" ? CheckCircle2 : row.status === "告警" ? TriangleAlert : row.status === "已停止" ? CircleStop : CircleHelp;
  return <span className={`site-status ${siteStatusTone(row.status)}`}><Icon size={14} /><span>{row.status}</span></span>;
}

function siteColumns(mode: SiteMode, onOpen: (id: string) => void): Array<TableColumn<SiteRuntimeView>> {
  const openColumn: TableColumn<SiteRuntimeView> = { key: "ops", label: "操作", width: "64px", control: true, render: (row) => <span className="table-icon-actions"><button type="button" title="查看操作" aria-label={`查看 ${row.domain} 站点操作`} onClick={() => onOpen(row.id)}><Eye size={16} /></button></span> };
  if (mode === "running") return [
    { key: "domain", label: "域名", width: "208px", render: (row) => <SiteIdentity row={row} /> },
    { key: "status", label: "状态", width: "96px", render: siteStatus },
    { key: "upstream", label: "上游", width: "180px", render: (row) => <code className="site-truncate" title={row.upstream}>{row.upstream}</code> },
    { key: "latency", label: "延迟", width: "104px", sortValue: (row) => row.latencyMs, render: (row) => <span className={row.latencyMs === null ? "gray-text" : row.latencyMs > 120 ? "orange-text" : "green-text"}>{row.latency}</span> },
    { key: "traffic", label: "流量", width: "112px", sortValue: (row) => row.trafficBytes, render: (row) => row.traffic },
    { key: "host", label: "主机", width: "160px", render: (row) => <span className="site-truncate" title={row.host}>{row.host}</span> },
    { key: "source", label: "数据源", render: (row) => row.source },
    openColumn,
  ];
  return [
    { key: "domain", label: "域名", width: "208px", render: (row) => <SiteIdentity row={row} /> },
    { key: "status", label: "状态", width: "96px", render: siteStatus },
    { key: "runtime", label: "服务", width: "152px", render: (row) => row.runtime },
    { key: "host", label: "主机", width: "160px", render: (row) => <span className="site-truncate" title={row.host}>{row.host}</span> },
    { key: "cert", label: "证书", width: "112px", sortValue: (row) => row.certDays, render: (row) => row.certDays === null ? <span className="gray-text">暂不可用</span> : <span className={isSiteCertDue(row) ? "orange-text" : "green-text"}>{row.certDays < 0 ? `过期 ${Math.abs(row.certDays)} 天` : `${row.certDays} 天`}</span> },
    { key: "traffic", label: "流量", width: "112px", sortValue: siteTrafficGb, render: (row) => row.traffic },
    { key: "source", label: "数据源", render: (row) => row.source },
    openColumn,
  ];
}

function runtimeColumns(onOpen: (runtime: string) => void): Array<TableColumn<SiteRuntimeGroup>> {
  return [
    { key: "runtime", label: "服务", width: "176px", render: (group) => <span className="runtime-group-title"><Code2 size={16} /><b>{group.runtime}</b></span> },
    { key: "health", label: "健康状态", width: "104px", render: (group) => { const health = runtimeGroupHealth(group); return <StatusDot tone={health.tone} text={health.label} />; } },
    { key: "sites", label: "站点容量", width: "104px", sortValue: (group) => group.sites.length, render: (group) => <strong>{group.sites.length} 个</strong> },
    { key: "running", label: "运行态", width: "208px", render: (group) => <span className="runtime-state-summary"><span><CheckCircle2 size={14} />{group.running} 运行</span><span className={group.warning + group.unknown ? "orange-text" : "gray-text"}><TriangleAlert size={14} />{group.warning + group.unknown} 关注</span><span className="gray-text"><CircleStop size={14} />{group.stopped} 停止</span></span> },
    { key: "hosts", label: "主机", width: "160px", render: (group) => <span className="runtime-hosts" title={group.hosts}>{group.hosts || "暂不可用"}</span> },
    { key: "traffic", label: "总流量", width: "112px", render: (group) => group.traffic },
    { key: "latency", label: "均延迟", width: "104px", render: (group) => group.avgLatency },
    { key: "ops", label: "详情", width: "64px", control: true, render: (group) => <span className="table-icon-actions"><button type="button" title="查看详情" aria-label={`查看 ${group.runtime} 服务详情`} onClick={() => onOpen(group.runtime)}><Eye size={16} /></button></span> },
  ];
}

function RuntimeDetail({ group, onClose }: { group: SiteRuntimeGroup; onClose: () => void }) {
  const health = runtimeGroupHealth(group);
  return <DetailDrawer className="runtime-detail-drawer" title={group.runtime} subtitle={`${group.sites.length} 个站点 · ${group.hosts || "主机暂不可用"}`} onClose={onClose}><div className="runtime-detail-status"><StatusLight tone={health.tone} /><span><small>服务状态</small><strong>{health.label}</strong></span></div><section className="runtime-detail-section"><header><Activity size={17} /><strong>容量与风险</strong></header><div className="detail-kv runtime-detail-facts"><p><span>运行站点</span><b>{group.running} 个</b></p><p><span>告警站点</span><b>{group.warning} 个</b></p><p><span>待采集</span><b>{group.unknown} 个</b></p><p><span>证书风险</span><b>{group.certificateDataAvailable ? `${group.certDue} 个` : "暂不可用"}</b></p><p><span>总流量</span><b>{group.traffic}</b></p><p><span>平均延迟</span><b>{group.avgLatency}</b></p></div></section><section className="runtime-detail-section"><header><Server size={17} /><strong>站点实例</strong><span>{group.sites.length} 个</span></header><div className="runtime-site-list">{group.sites.map((site) => <article key={site.id}><StatusLight tone={siteStatusTone(site.status)} /><span><strong title={site.domain}>{site.domain}</strong><small>{site.host} · {site.upstream}</small></span><span><b>{site.status}</b><small>{site.latency} · {site.source}</small></span></article>)}</div></section></DetailDrawer>;
}

function SiteIdentity({ row }: { row: SiteRuntimeView }) { return <span className="site-domain" title={row.domain}><Globe2 size={14} /><b>{row.domain}</b></span>; }
function RuntimeMobileCard({ group, onOpen }: { group: SiteRuntimeGroup; onOpen: (runtime: string) => void }) { const health = runtimeGroupHealth(group); return <><div className="module-card-head"><span className="module-card-title"><Code2 size={16} /><b>{group.runtime}</b></span><StatusDot tone={health.tone} text={health.label} /></div><div className="module-card-meta"><span><b>站点容量</b><em>{group.sites.length} 个</em></span><span><b>运行 / 关注 / 停止</b><em>{group.running} / {group.warning + group.unknown} / {group.stopped}</em></span><span><b>流量 / 延迟</b><em>{group.traffic} / {group.avgLatency}</em></span><span><b>证书风险</b><em>{group.certificateDataAvailable ? `${group.certDue} 个` : "暂不可用"}</em></span></div><div className="module-card-footer"><button className="ghost small" type="button" onClick={() => onOpen(group.runtime)}><Eye size={15} /> 查看详情</button></div></>; }
function SiteMobileCard({ row, mode, onOpen }: { row: SiteRuntimeView; mode: SiteMode; onOpen: (id: string) => void }) { return <><div className="module-card-head"><span className="module-card-title site-mobile-domain"><Globe2 size={16} /><b title={row.domain}>{row.domain}</b></span>{siteStatus(row)}</div><code className="module-card-code" title={mode === "running" ? row.upstream : row.host}>{mode === "running" ? row.upstream : row.host}</code><div className="module-card-meta"><span><b>服务</b><em>{row.runtime}</em></span><span><b>{mode === "running" ? "延迟" : "证书"}</b><em>{mode === "running" ? row.latency : row.certDays === null ? "暂不可用" : `${row.certDays} 天`}</em></span><span><b>流量</b><em>{row.traffic}</em></span><span><b>数据源</b><em>{row.source}</em></span></div><div className="module-card-footer"><button className="ghost small" type="button" onClick={() => onOpen(row.id)}><Eye size={15} /> 查看操作</button></div></>; }

export { SitesLoadState, SitesMonitoringView };
