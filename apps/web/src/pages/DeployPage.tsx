import type { DeploymentRecord, Permission } from "@stackpilot/contracts";
import { Activity, CheckCircle2, CircleAlert, Clock3, CloudOff, CloudUpload, Eye, GitBranch } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { resolvePageMeta } from "../app/navigation";
import { deployPagePreset } from "../app/pagePresets";
import { pushPageRoute } from "../app/routing";
import { ModulePageShell } from "../components/layout/ModulePageShell";
import { MetricTile, ModuleSearch } from "../components/ui/Cards";
import { DataTable } from "../components/ui/DataTable";
import { DetailDrawer } from "../components/ui/DetailDrawer";
import { deploymentApp, deploymentEnvironmentLabel, deploymentStageLabel, deploymentStatusLabel, deploymentStatusTone, deploymentVersion } from "../features/deployments/model";
import { SiteRollbacksWorkspace } from "../features/deployments/SiteRollbacksWorkspace";
import { useDeployments } from "../features/deployments/useDeployments";
import { DeploymentTabs } from "../features/deployments/DeploymentTabs";
import type { Notify, PageKey } from "../types/app";
import { formatBackendDateTime } from "../utils/time";

const environmentValues = ["production", "staging", "development", "unknown"] as const;
type EnvironmentFilter = "all" | typeof environmentValues[number];

function DeploymentsWorkspace({ page, permissions }: { page: PageKey; permissions: Permission[] }) {
  const canRead = permissions.includes("sites:read");
  const canDeploy = permissions.includes("sites:deploy");
  const preset = deployPagePreset(page);
  const initialEnvironment: EnvironmentFilter = page === "deploy-staging" ? "staging" : page === "deploy-prod" ? "production" : "all";
  const [environment, setEnvironment] = useState<EnvironmentFilter>(initialEnvironment);
  const [search, setSearch] = useState("");
  const [selectedDeploymentId, setSelectedDeploymentId] = useState<string | null>(null);
  const { data, loading, error, backgroundError, retry } = useDeployments(canRead);
  const deployments = useMemo(() => data?.deployments ?? [], [data]);
  const query = search.trim().toLowerCase();
  const filteredDeployments = deployments.filter((row) => (environment === "all" || row.environment === environment) && (!query || `${deploymentApp(row)} ${row.nodeId} ${deploymentVersion(row)} ${row.repositoryRef} ${row.operator ?? ""}`.toLowerCase().includes(query)));
  const selectedDeployment = selectedDeploymentId ? deployments.find((row) => row.planId === selectedDeploymentId) ?? null : null;

  useEffect(() => { if (selectedDeploymentId && data && !selectedDeployment) queueMicrotask(() => setSelectedDeploymentId(null)); }, [data, selectedDeployment, selectedDeploymentId]);
  useEffect(() => { queueMicrotask(() => setEnvironment(initialEnvironment)); }, [initialEnvironment]);

  if (!canRead) return <ModulePageShell title={resolvePageMeta(page).title} page={page} viewContext={false} tabs={<DeploymentTabs page={page} />}><div className="overview-error-state" role="alert"><CircleAlert size={18} /><span>当前账号没有站点读取权限</span></div></ModulePageShell>;
  const freshness = backgroundError ? `后台刷新失败，保留上次数据：${backgroundError}` : `后端采集于 ${formatBackendDateTime(data?.collectedAt)}`;
  const envOptions: EnvironmentFilter[] = ["all", ...environmentValues];

  return <><ModulePageShell title={resolvePageMeta(page).title} subtitle={page === "deploy" ? "查看所有环境的预检、发布进度和执行结果。" : preset.subtitle} page={page} viewContext={false} tabs={<DeploymentTabs page={page} />}
    actions={canDeploy ? <button className="primary" type="button" onClick={() => pushPageRoute("sites-create")}><CloudUpload size={15} /> 创建部署计划</button> : undefined}
    filters={<><ModuleSearch value={search} placeholder="搜索项目、节点、版本或操作人" onChange={setSearch} /><div className="deploy-tabs" aria-label="部署环境">{envOptions.map((item) => <button key={item} className={item === environment ? "active" : ""} aria-pressed={item === environment} type="button" onClick={() => setEnvironment(item)}>{environmentLabel(item)}</button>)}</div></>}
    metrics={<><MetricTile icon={CloudUpload} label="发布任务" value={data ? `${filteredDeployments.length}` : "—"} tone="blue" /><MetricTile icon={Activity} label="进行中" value={data ? `${filteredDeployments.filter((row) => ["queued", "preparing", "deploying"].includes(row.status)).length}` : "—"} tone="orange" /><MetricTile icon={CheckCircle2} label="成功" value={data ? `${filteredDeployments.filter((row) => row.status === "succeeded").length}` : "—"} tone="green" /></>}>
    <p className="module-freshness-note"><Clock3 size={15} />{freshness}</p>
    {loading && !data && <span className="sr-only" role="status">正在读取真实发布队列</span>}
    {error && !data && <div className="overview-error-state"><CloudOff size={18} /><span>{error}</span><button type="button" onClick={() => void retry()}>重试</button></div>}
    <DeploymentTable rows={filteredDeployments} loading={loading} onOpen={setSelectedDeploymentId} />
  </ModulePageShell>
  {selectedDeployment && <DeploymentDrawer row={selectedDeployment} onClose={() => setSelectedDeploymentId(null)} />}
  </>;
}

function DeployPage({ page, notify = () => undefined, permissions = ["sites:read", "sites:deploy"] }: { page: PageKey; notify?: Notify; permissions?: Permission[] }) {
  return page === "deploy-rollbacks"
    ? <SiteRollbacksWorkspace notify={notify} permissions={permissions} />
    : <DeploymentsWorkspace page={page} permissions={permissions} />;
}

function DeploymentTable({ rows, loading, onOpen }: { rows: DeploymentRecord[]; loading: boolean; onOpen: (id: string) => void }) {
  return <DataTable columns={[
    { key: "app", label: "发布项目", width: "220px", render: (row) => <button className="module-row-link deploy-project-link" type="button" title={deploymentApp(row)} onClick={() => onOpen(row.planId)}><CloudUpload size={15} /><b>{deploymentApp(row)}</b></button> },
    { key: "target", label: "目标节点", width: "190px", render: (row) => <code title={row.nodeId}>{row.nodeId}</code> },
    { key: "version", label: "版本", width: "210px", render: (row) => <code title={deploymentVersion(row)}>{deploymentVersion(row)}</code> },
    { key: "status", label: "状态", width: "110px", render: (row) => <span className={`pill status-with-icon ${deploymentStatusTone(row.status)}`}>{statusIcon(row)}{deploymentStatusLabel(row.status)}</span> },
    { key: "operator", label: "操作人", width: "110px", render: (row) => row.operator ?? "系统" },
    { key: "updated", label: "更新时间", width: "180px", render: (row) => formatBackendDateTime(row.updatedAt) },
    { key: "ops", label: "操作", width: "90px", render: (row) => <span className="table-actions actions-1"><button type="button" aria-label={`查看 ${deploymentApp(row)} 发布详情`} onClick={() => onOpen(row.planId)}><Eye size={15} />详情</button></span> },
  ]} rows={rows} emptyText={loading ? "正在读取真实发布队列" : "当前环境还没有真实发布任务"} getRowKey={(row) => row.planId} mobileCard={(row) => <DeploymentCard row={row} onOpen={onOpen} />} />;
}

function DeploymentCard({ row, onOpen }: { row: DeploymentRecord; onOpen: (id: string) => void }) {
  return <><div className="module-card-head"><span className="module-card-title"><CloudUpload size={15} /><b title={deploymentApp(row)}>{deploymentApp(row)}</b></span><span className={`pill status-with-icon ${deploymentStatusTone(row.status)}`}>{statusIcon(row)}{deploymentStatusLabel(row.status)}</span></div><code className="module-card-code" title={deploymentVersion(row)}>{deploymentVersion(row)}</code><div className="module-card-meta"><span><b>环境</b><em>{deploymentEnvironmentLabel(row.environment)}</em></span><span><b>节点</b><em title={row.nodeId}>{row.nodeId}</em></span><span><b>操作人</b><em>{row.operator ?? "系统"}</em></span><span><b>更新时间</b><em>{formatBackendDateTime(row.updatedAt)}</em></span></div><div className="module-card-footer"><div className="table-actions actions-1"><button type="button" onClick={() => onOpen(row.planId)}><Eye size={15} />详情</button></div></div></>;
}

function DeploymentDrawer({ row, onClose }: { row: DeploymentRecord; onClose: () => void }) {
  return <DetailDrawer className="deploy-log-drawer" title="发布详情" subtitle={deploymentApp(row)} modal onClose={onClose}><div className="deploy-detail-summary"><span className={`pill status-with-icon ${deploymentStatusTone(row.status)}`}>{statusIcon(row)}{deploymentStatusLabel(row.status)}</span><strong>{row.progressPercent}%</strong><span>{deploymentStageLabel(row.stage)}</span></div><div className="detail-kv deploy-preview-kv"><p><span>目标节点</span><b title={row.nodeId}>{row.nodeId}</b></p><p><span>Git ref</span><b>{row.repositoryRef}</b></p><p><span>发布版本</span><b title={deploymentVersion(row)}>{deploymentVersion(row)}</b></p><p><span>运行时</span><b>{row.runtime ?? "等待预检"}</b></p><p><span>健康检查</span><b>{row.healthCheckPath ?? "暂不可用"}</b></p><p><span>错误代码</span><b>{row.errorCode ?? "无"}</b></p><p><span>创建时间</span><b>{formatBackendDateTime(row.createdAt)}</b></p><p><span>更新时间</span><b>{formatBackendDateTime(row.updatedAt)}</b></p></div><section className="deploy-source-detail"><h3><GitBranch size={15} /> 仓库来源</h3><code title={row.repositoryUrl}>{row.repositoryUrl}</code></section></DetailDrawer>;
}

function statusIcon(row: DeploymentRecord) { return row.status === "succeeded" ? <CheckCircle2 size={14} /> : row.status === "failed" || row.status === "expired" ? <CircleAlert size={14} /> : <Activity size={14} />; }
function environmentLabel(environment: EnvironmentFilter) { return environment === "all" ? "全部" : deploymentEnvironmentLabel(environment); }

export { DeployPage };
