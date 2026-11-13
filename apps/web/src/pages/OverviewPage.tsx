import { checkOverviewUpdates, fetchOverview } from "../api/overviewApi";
import type { OverviewNode } from "../api/overviewApi";
import { ArrowRight, CheckCircle2, Clock3, PackageSearch, ShieldAlert } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useId, useState } from "react";
import { emptyOverviewSummary, overviewMetricIcons, reportApiError } from "../features/overview/model";
import { useOptionalOverviewData } from "../features/overview/OverviewDataProvider";
import { AuditTable, HostTable, ResourceOverview, RiskList, ServiceSummary, TaskTable, WorkbenchProgress } from "../features/overview/OverviewTables";
import { OverviewFreshness, OverviewNavigation, OverviewState, OverviewUsageRing } from "../features/overview/OverviewUI";
import { useOverviewResource } from "../features/overview/useOverviewResource";
import type { Notify, SetPage } from "../types/app";

function OverviewPage({ setPage, notify }: { setPage: SetPage; notify: Notify }) {
  const shared = useOptionalOverviewData();
  const local = useOverviewResource(fetchOverview, !shared, (error) => reportApiError(error, notify, "工作台数据加载失败"));
  const data = shared?.overview ?? local.data;
  const overview = data ?? emptyOverviewSummary();
  const loading = (shared?.loading ?? local.loading) && !data;
  const error = shared?.error ?? local.error;
  const [taskTab, setTaskTab] = useState("全部任务");
  const [resourceTab, setResourceTab] = useState("cluster");
  const [checkingUpdates, setCheckingUpdates] = useState(false);
  const resourceTabs = buildResourceTabs(overview.nodes, Object.keys(overview.resources));
  const activeResourceTab = resourceTabs.some((tab) => tab.key === resourceTab) ? resourceTab : resourceTabs[0]?.key ?? "cluster";
  const pendingRisks = overview.risks.filter((risk) => risk.status === "待处理");
  const queuedTasks = overview.tasks.filter((task) => ["运行中", "等待"].includes(task.status));
  const hasOverview = overview.nodes.length > 0 || overview.metrics.length > 0;
  const healthy = hasOverview && overview.cluster.health === "健康";
  const StatusIcon = healthy ? CheckCircle2 : hasOverview ? ShieldAlert : Clock3;
  const retry = () => { void (shared ? shared.reload() : local.reload()); };
  const checkUpdates = async () => {
    if (checkingUpdates) return;
    setCheckingUpdates(true);
    try {
      const payload = await checkOverviewUpdates();
      if (shared) shared.replace(payload.overview); else local.replace(payload.overview);
      notify(payload.message, payload.tone ?? "info");
    } catch (reason) { reportApiError(reason, notify, "检查更新失败"); }
    finally { setCheckingUpdates(false); }
  };
  const see = (page: Parameters<SetPage>[0], label = "查看全部") => <button className="overview-section-link" type="button" onClick={() => setPage(page)}>{label}<ArrowRight size={16} aria-hidden="true" /></button>;

  return <div className="overview-page cloudpulse-overview" role="region" aria-label="实时工作台状态">
    <header className="overview-page-heading">
      <div><p className="overview-eyebrow">INFRASTRUCTURE OVERVIEW</p><h1>工作台</h1><p className="overview-intro">{hasOverview ? `${overview.nodes.length} 个节点，${pendingRisks.length} 项风险需要关注。` : "从节点到服务，掌握基础设施运行状态。"}</p></div>
      <div className="overview-heading-meta"><span className={`overview-semantic-status ${healthy ? "green" : hasOverview ? "orange" : "gray"}`}><StatusIcon size={16} aria-hidden="true" />{hasOverview ? overview.cluster.health : "等待采集"}</span><OverviewFreshness value={data?.collectedAt || data?.lastRefresh} /><button className="ghost" type="button" disabled={checkingUpdates || !data} onClick={() => void checkUpdates()}><PackageSearch size={16} />{checkingUpdates ? "正在检查" : "检查更新"}</button></div>
    </header>
    <OverviewNavigation active="overview" />
    {loading && <OverviewState loading title="正在采集工作台数据" />}
    {error && <OverviewState error={error} title="工作台数据暂不可用" onRetry={retry} />}
    {!loading && !error && !hasOverview && <OverviewState description="后端暂未返回工作台数据，系统将继续自动采集。" />}
    {overview.metrics.length > 0 && <section className="metric-row" aria-label="资源与运行指标">{overview.metrics.map((metric) => <MetricCard key={metric.label} {...metric} icon={overviewMetricIcons[metric.icon]} />)}</section>}
    {hasOverview && <>
      <div className="overview-primary-grid">
        <section className="overview-section"><header><div><h2>集群状态</h2><span className="overview-caption">{overview.nodes.length} 个节点</span></div>{see("overview-health")}</header><HostTable nodes={overview.nodes.slice(0, 6)} allNodes={overview.nodes} notify={notify} /><div className="overview-section-foot"><span>展示 {Math.min(6, overview.nodes.length)} / {overview.nodes.length} 个节点</span><OverviewFreshness value={data?.collectedAt} /></div></section>
        <section className="overview-section"><header><h2>需要关注</h2>{see("overview-risks", "风险中心")}</header><RiskList risks={overview.risks} /></section>
      </div>
      <div className="overview-primary-grid">
        <section className="overview-section"><header><h2>近期动态</h2>{see("audit")}</header><AuditTable rows={overview.audits} /></section>
        <section className="overview-section"><header><h2>服务健康</h2><span className="overview-caption">授权范围内</span></header><ServiceSummary nodes={overview.nodes} /></section>
      </div>
      <div className="overview-primary-grid">
        <section className="overview-section"><header><h2>处置建议</h2>{see("overview-tasks")}</header><div className="overview-local-tabs" role="group" aria-label="任务范围">{["全部任务", `待处理 (${queuedTasks.length})`].map((tab) => <button type="button" key={tab} aria-pressed={taskTab === "全部任务" ? tab === "全部任务" : tab !== "全部任务"} onClick={() => setTaskTab(tab)}>{tab}</button>)}</div><TaskTable tasks={overview.tasks} queued={taskTab !== "全部任务"} /></section>
        <section className="overview-section"><header><h2>当前目标</h2></header><WorkbenchProgress node={overview.nodes[0] ?? null} taskCount={queuedTasks.length} riskCount={pendingRisks.length} /></section>
      </div>
      <section className="overview-section"><header><h2>资源概览</h2>{resourceTabs.length > 0 && <label className="overview-resource-select"><span className="sr-only">资源范围</span><select value={activeResourceTab} onChange={(event) => setResourceTab(event.target.value)}>{resourceTabs.map((tab) => <option key={tab.key} value={tab.key}>{tab.label}</option>)}</select></label>}</header><ResourceOverview resources={overview.resources[activeResourceTab] ?? []} /></section>
    </>}
  </div>;
}

function buildResourceTabs(nodes: OverviewNode[], keys: string[]) {
  const labels = keys.map((key) => key === "cluster" ? "集群" : key === "node-local" ? nodes.find((node) => node.source === "controller")?.name ?? "Controller" : nodes.find((node) => node.id === key)?.name ?? key);
  return keys.map((key, index) => ({ key, label: labels.filter((label) => label === labels[index]).length > 1 ? `${labels[index]} (${key.slice(0, 8)})` : labels[index] }));
}

function MetricCard({ label, value, suffix, delta, icon: Icon, tone, details }: { label: string; value: string; suffix: string; delta: string; icon: LucideIcon; tone: string; line: number[]; details?: Array<{ label: string; value: string; detail: string }> }) {
  const id = useId();
  const percentage = suffix === "%" && Number.isFinite(Number(value));
  const resourceTone = label.includes("内存") ? "purple" : label.includes("磁盘") ? "teal" : "blue";
  return <article className={`metric-card cp-metric-card ${tone} ${details?.length ? "has-details" : ""}`} tabIndex={details?.length ? 0 : undefined} aria-describedby={details?.length ? id : undefined}>
    <div className="cp-metric-label"><span>{label}</span><Icon size={20} aria-hidden="true" /></div>
    <div className="cp-metric-value">{percentage ? <OverviewUsageRing value={`${value}%`} label={label} tone={resourceTone} /> : <strong>{value}<small>{suffix}</small></strong>}<p>{delta}</p></div>
    {details?.length ? <div className="metric-details-tooltip" id={id} role="tooltip"><header><strong>磁盘明细</strong><span>{details.length} 个盘</span></header><div>{details.map((detail) => <p key={`${detail.label}-${detail.value}`}><span><b>{detail.label}</b><small>{detail.detail}</small></span><strong>{detail.value}</strong></p>)}</div></div> : null}
  </article>;
}

export { OverviewPage, MetricCard };
export { NodeDetailContent } from "../features/overview/OverviewTables";
