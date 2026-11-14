import { ResourceNavigation } from "../features/hosts/ResourceNavigation";
import { Activity, CircleAlert, CircleCheck, CircleHelp, CircleX, Database, Eye, Plus, Shield } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Permission } from "@stackpilot/contracts";
import { fetchDatabases } from "../api/databasesApi";
import { databasePagePreset } from "../app/pagePresets";
import { resolvePageMeta } from "../app/navigation";
import { consumePendingDatabaseFocus, readDatabaseFocusParam } from "../app/routing";
import { ModulePageShell } from "../components/layout/ModulePageShell";
import { MetricTile, ModuleSearch, PanelCard } from "../components/ui/Cards";
import { DataTable } from "../components/ui/DataTable";
import { FieldSelect } from "../components/ui/FormControls";
import type { DatabaseInstance } from "../features/databases/types";
import { databaseBackupTone, databaseHealthLabel, databaseHealthTone, databaseInstanceFromApi, isDatabaseAlert, isDatabaseHealthy } from "../features/databases/model";
import { AccessSummary, BackupSummary, HealthMini, SlowInstanceList } from "../features/databases/OverviewWidgets";
import { DatabaseCreateDialog } from "../features/databases/DatabaseCreateDialog";
import { DatabaseCredentialsDrawer } from "../features/databases/DatabaseCredentialsDrawer";
import { DatabaseInstanceDrawer } from "../features/databases/DatabaseInstanceDrawer";
import { useAutoRefresh } from "../hooks/useAutoRefresh";
import type { Notify, PageKey, SetPage } from "../types/app";
import { formatBackendDateTime } from "../utils/time";

function DatabasesPage({ page, setPage, notify, permissions = [] }: { page: PageKey; setPage: SetPage; notify: Notify; permissions?: Permission[] }) {
  const preset = databasePagePreset(page);
  const initialFocusName = page === "databases" ? readDatabaseFocusParam() : null;
  const [search, setSearch] = useState(initialFocusName ?? preset.search);
  const [typeFilter, setTypeFilter] = useState(preset.type);
  const [statusFilter, setStatusFilter] = useState(preset.status);
  const [hostFilter, setHostFilter] = useState(preset.host);
  const [rows, setRows] = useState<DatabaseInstance[]>([]);
  const [available, setAvailable] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [credentials, setCredentials] = useState<Record<string, string> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [collectedAt, setCollectedAt] = useState("等待后端采集");
  const [collectionNote, setCollectionNote] = useState("等待 Agent 上报数据库服务清单");
  const requestRef = useRef<AbortController | null>(null);
  const inFlightRef = useRef<Promise<void> | null>(null);
  const hasDataRef = useRef(false);
  const focusAppliedRef = useRef(false);
  const rowsRef = useRef(rows);
  const selected = rows.find((row) => row.id === selectedId) ?? null;

  useEffect(() => { rowsRef.current = rows; }, [rows]);

  const loadDatabases = useCallback((externalSignal?: AbortSignal, silent = false) => {
    if (inFlightRef.current) return inFlightRef.current;
    if (!silent) { setLoading(true); setError(null); }
    const controller = new AbortController();
    const abort = () => controller.abort();
    externalSignal?.addEventListener("abort", abort, { once: true });
    requestRef.current = controller;
    const request = fetchDatabases(controller.signal).then((payload) => {
      if (controller.signal.aborted) return;
      const nextRows = payload.instances.map(databaseInstanceFromApi);
      hasDataRef.current = true; setAvailable(payload.collectionStatus !== "unavailable"); setRows(nextRows);
      const focusName = focusAppliedRef.current ? null : initialFocusName ?? readDatabaseFocusParam();
      const focusId = focusName ? nextRows.find((row) => row.name === focusName)?.id ?? null : null;
      if (focusId) focusAppliedRef.current = true;
      setSelectedId((current) => {
        if (current) return nextRows.some((row) => row.id === current) ? current : null;
        return focusId;
      });
      setCollectedAt(formatBackendDateTime(payload.collectedAt));
      const status = payload.collectionStatus === "complete" ? "采集完整" : payload.collectionStatus === "partial" ? "部分采集" : "等待采集";
      setCollectionNote(payload.warnings.length ? `${status} · ${payload.warnings.join("；")}` : status);
      setError(null);
    }).catch((caught: unknown) => {
      if (controller.signal.aborted) return;
      if (!silent || !hasDataRef.current) setError(caught instanceof Error ? caught.message : "数据库实例后端加载失败");
    }).finally(() => {
      externalSignal?.removeEventListener("abort", abort);
      if (requestRef.current === controller) requestRef.current = null;
      if (inFlightRef.current === request) inFlightRef.current = null;
      if (!controller.signal.aborted && !silent) setLoading(false);
    });
    inFlightRef.current = request;
    return request;
  }, [initialFocusName]);

  useEffect(() => {
    let disposed = false;
    queueMicrotask(() => { if (!disposed) void loadDatabases(); });
    return () => { disposed = true; requestRef.current?.abort(); };
  }, [loadDatabases]);
  useAutoRefresh((signal) => loadDatabases(signal, true), undefined, !loading);

  useEffect(() => {
    const focusDatabase = () => {
      const name = consumePendingDatabaseFocus() ?? readDatabaseFocusParam();
      if (!name) return;
      focusAppliedRef.current = true;
      const target = rowsRef.current.find((row) => row.name === name);
      setSearch(name); setTypeFilter("全部"); setStatusFilter("全部"); setHostFilter("全部主机");
      setSelectedId(target?.id ?? null);
      if (!target && hasDataRef.current) notify(`未找到 ${name}，已保留实例搜索条件`, "warning");
    };
    window.addEventListener("stackpilot:database-focus", focusDatabase);
    window.addEventListener("hashchange", focusDatabase);
    window.addEventListener("popstate", focusDatabase);
    return () => {
      window.removeEventListener("stackpilot:database-focus", focusDatabase);
      window.removeEventListener("hashchange", focusDatabase);
      window.removeEventListener("popstate", focusDatabase);
    };
  }, [notify]);

  const hostOptions = ["全部主机", ...Array.from(new Set(rows.map((row) => row.nodeName ?? row.host)))];
  const filteredRows = rows.filter((row) => {
    const keyword = search.trim().toLowerCase();
    const searchable = `${row.name} ${row.engine} ${row.host} ${row.nodeName ?? ""} ${row.owner} ${row.access} ${row.region}`.toLowerCase();
    const matchSearch = !keyword || searchable.includes(keyword);
    const matchType = typeFilter === "全部" || row.engine.includes(typeFilter);
    const matchStatus = statusFilter === "全部" || (statusFilter === "告警" ? isDatabaseAlert(row) : isDatabaseHealthy(row));
    return matchSearch && matchType && matchStatus && (hostFilter === "全部主机" || (row.nodeName ?? row.host) === hostFilter);
  });
  const count = (value: number) => available ? String(value) : "等待采集";
  const postgresCount = rows.filter((row) => row.engine.includes("PostgreSQL")).length;
  const mysqlCount = rows.filter((row) => row.engine.includes("MySQL") || row.engine.includes("MariaDB")).length;
  const healthyCount = rows.filter(isDatabaseHealthy).length;
  const alertCount = rows.filter(isDatabaseAlert).length;
  const knownBackups = rows.filter((row) => row.backupStatus !== "暂不可用");
  const backupSuccessRate = knownBackups.length ? Math.round((knownBackups.filter((row) => row.backupStatus === "成功").length / knownBackups.length) * 100) : null;
  const knownSlowRows = rows.filter((row) => row.slowQueries !== null);
  const slowQueryCount = knownSlowRows.reduce((sum, row) => sum + (row.slowQueries ?? 0), 0);
  const healthFocus = [...filteredRows].sort((left, right) => databaseLatency(right) - databaseLatency(left))[0] ?? null;

  const copyEndpoint = async (instance: DatabaseInstance) => {
    if (instance.port === "待采集") { notify("实例端口尚未采集，无法复制端点", "warning"); return; }
    try {
      await navigator.clipboard.writeText(`${instance.host}:${instance.port}`);
      notify(`${instance.name} 端点已复制`, "info");
    } catch { notify("浏览器未允许复制端点", "warning"); }
  };

  return <>
    <ModulePageShell
      title={resolvePageMeta(page).title}
      subtitle={loading ? "正在从后端采集数据库服务清单" : preset.subtitle}
      page={page}
      className="resource-cloudpulse module-page-databases"
      viewContext={false} tabs={<ResourceNavigation module="databases" page={page} />}
      actions={permissions.includes("databases:install") ? <button className="primary" type="button" onClick={() => setCreating(true)}><Plus size={15} /> 创建数据库实例</button> : undefined}
      filters={<><ModuleSearch value={search} placeholder="搜索数据库、主机、节点或权限" onChange={setSearch} /><FieldSelect label="类型" value={typeFilter} options={["全部", "PostgreSQL", "MySQL", "MariaDB"]} onChange={setTypeFilter} /><FieldSelect label="状态" value={statusFilter} options={["全部", "正常", "告警"]} onChange={setStatusFilter} /><FieldSelect label="主机" value={hostFilter} options={hostOptions} onChange={setHostFilter} /></>}
      metrics={<><MetricTile icon={Database} label="PostgreSQL" value={count(postgresCount)} tone="blue" /><MetricTile icon={Database} label="MySQL / MariaDB" value={count(mysqlCount)} tone="blue" /><MetricTile icon={Activity} label="运行中" value={count(healthyCount)} tone="green" /><MetricTile icon={Shield} label="告警" value={count(alertCount)} tone={alertCount ? "orange" : "green"} /><BackupRateMetric value={backupSuccessRate} /><MetricTile icon={CircleAlert} label="慢查询" value={knownSlowRows.length ? `${slowQueryCount}` : "待采集"} tone={slowQueryCount ? "orange" : knownSlowRows.length ? "green" : "gray"} /></>}
      side={selected ? <DatabaseInstanceDrawer instance={selected} permissions={permissions} onClose={() => setSelectedId(null)} onCopy={() => void copyEndpoint(selected)} notify={notify} /> : null}
      sideModal={Boolean(selected)}
    >
      {loading && <span className="sr-only" role="status" aria-live="polite">正在从 /api/databases 采集数据库实例</span>}
      {error && <div className="overview-error-state database-error-state"><Shield size={18} /><span>{error}</span><button type="button" disabled={loading} onClick={() => void loadDatabases()}>重试</button></div>}
      {!loading && !error && <p className="database-collection-note"><CircleHelp size={15} aria-hidden="true" /><span>后端采集于 {collectedAt}</span><span>{collectionNote}</span></p>}
      <div className="database-instance-content">
        <DataTable
          columns={[
            { key: "name", label: "名称", width: "172px", sortValue: (row) => row.name, render: (row) => <button className="module-row-link database-instance-name" type="button" title={row.name} aria-label={`查看数据库 ${row.name}`} onClick={() => setSelectedId(row.id)}><Database size={15} aria-hidden="true" /><b>{row.name}</b></button> },
            { key: "engine", label: "类型", width: "126px", sortValue: (row) => row.engine, render: (row) => <span className="database-engine"><Database size={15} aria-hidden="true" /> {row.engine}</span> },
            { key: "endpoint", label: "主机 / 端口", width: "150px", sortValue: (row) => `${row.host}:${row.port}`, render: (row) => <code className="database-endpoint" title={`${row.host}:${row.port}`}>{row.host}:{row.port}</code> },
            { key: "health", label: "运行状态", width: "110px", sortValue: (row) => databaseLatency(row), render: (row) => <ConnectionStatus instance={row} /> },
            { key: "backup", label: "备份", width: "100px", sortValue: (row) => row.backupStatus, render: (row) => <BackupStatus status={row.backupStatus} /> },
            { key: "slow", label: "慢查询", width: "74px", sortValue: (row) => row.slowQueries, render: (row) => row.slowQueries === null ? "暂不可用" : <b className={row.slowQueries > 0 ? "orange-text" : "green-text"}>{row.slowQueries}</b> },
            { key: "collected", label: "采集时间", width: "150px", sortValue: (row) => row.collectedAt, render: (row) => formatBackendDateTime(row.collectedAt) },
            { key: "access", label: "权限", width: "118px", render: (row) => <span className="database-pill-group"><span className={`pill ${row.access === "读写" ? "blue" : row.access === "只读" ? "gray" : "orange"}`}>{row.access}</span><span className="pill green">{row.owner}</span></span> },
            { key: "ops", label: "操作", width: "64px", control: true, render: (row) => <span className="table-icon-actions database-table-actions"><button type="button" title="查看详情" aria-label={`查看 ${row.name} 详情`} onClick={() => setSelectedId(row.id)}><Eye size={15} /></button></span> },
          ]}
          rows={filteredRows}
          emptyText={error ? "实时采集失败，未显示示例数据库" : loading ? "正在采集数据库实例" : "没有匹配的真实数据库实例，系统将继续自动采集"}
          getRowKey={(row) => row.id}
          mobileCard={(row) => <DatabaseMobileCard instance={row} onOpen={() => setSelectedId(row.id)} />}
          pageSize={100}
        />
        {filteredRows.length > 0 && <section className="database-instance-lower"><PanelCard title="当前备份状态" action="查看备份计划" onAction={() => setPage("databases-backups", { message: "已打开数据库 / 备份计划", tone: "info" })}><BackupSummary rows={filteredRows} /></PanelCard><PanelCard title={`连接健康（${healthFocus?.name ?? "不可用"})`} action={healthFocus ? "查看监控详情" : undefined} onAction={healthFocus ? () => setSelectedId(healthFocus.id) : undefined}><HealthMini instance={healthFocus} collectedAt={collectedAt} /></PanelCard><PanelCard title="慢查询实例"><SlowInstanceList rows={filteredRows} onOpen={setSelectedId} /></PanelCard><PanelCard title="权限分布"><AccessSummary rows={filteredRows} /></PanelCard></section>}
      </div>
    </ModulePageShell>{creating && <DatabaseCreateDialog onClose={() => setCreating(false)} onComplete={(value) => { setCreating(false); setCredentials(value); notify("数据库实例已创建", "success"); void loadDatabases(); }} />}{credentials && <DatabaseCredentialsDrawer credentials={credentials} onClose={() => setCredentials(null)} />}
  </>;
}

function databaseLatency(instance: DatabaseInstance) { const value = Number.parseInt(instance.latency, 10); return Number.isFinite(value) ? value : -1; }

function ConnectionStatus({ instance }: { instance: DatabaseInstance }) {
  const label = databaseHealthLabel(instance);
  const Icon = label === "运行中" ? CircleCheck : label === "未知" || label === "数据已过期" ? CircleHelp : CircleAlert;
  return <span className={`database-semantic-status ${databaseHealthTone(instance)}`}><Icon size={15} aria-hidden="true" /><span>{label}</span></span>;
}

function BackupStatus({ status }: { status: DatabaseInstance["backupStatus"] }) {
  const Icon = status === "成功" ? CircleCheck : status === "失败" ? CircleX : status === "运行中" ? Activity : status === "暂不可用" ? CircleHelp : CircleAlert;
  return <span className={`database-semantic-status ${databaseBackupTone(status)}`}><Icon size={15} aria-hidden="true" /><span>{status}</span></span>;
}

function BackupRateMetric({ value }: { value: number | null }) {
  if (value === null) return <article aria-label="备份成功率 待采集"><CircleHelp size={20} aria-hidden="true" /><span>备份成功率</span><strong>待采集</strong></article>;
  const radius = 18; const circumference = 2 * Math.PI * radius; const display = `${value}%`; const tone = value >= 95 ? "green" : "orange";
  return <article className="database-rate-metric"><span className={`database-rate-ring ${tone}`} aria-label={`备份成功率 ${display}`}><svg viewBox="0 0 44 44" aria-hidden="true"><circle className="database-rate-track" cx="22" cy="22" r={radius} /><circle className="database-rate-value" cx="22" cy="22" r={radius} strokeDasharray={circumference} strokeDashoffset={value === null ? circumference : circumference * (1 - value / 100)} /></svg><b>{display}</b></span><span>备份成功率</span><strong>{display}</strong></article>;
}

function DatabaseMobileCard({ instance, onOpen }: { instance: DatabaseInstance; onOpen: () => void }) {
  return <><div className="module-card-head database-mobile-head"><button className="module-row-link database-mobile-name" type="button" title={instance.name} aria-label={`查看数据库 ${instance.name}`} onClick={onOpen}><Database size={16} aria-hidden="true" /><b>{instance.name}</b></button><ConnectionStatus instance={instance} /></div><code className="module-card-code">{instance.host}:{instance.port}</code><div className="module-card-meta"><span><b>引擎</b><em>{instance.engine}</em></span><span><b>备份</b><em><BackupStatus status={instance.backupStatus} /></em></span><span><b>慢查询</b><em>{instance.slowQueries === null ? "暂不可用" : `${instance.slowQueries} 条`}</em></span><span><b>采集</b><em>{formatBackendDateTime(instance.collectedAt)}</em></span><span><b>节点</b><em>{instance.nodeName ?? instance.host}</em></span><span><b>存储 / 连接</b><em>{instance.storage} · {instance.connections}</em></span></div><div className="module-card-footer database-mobile-actions"><button className="ghost small" type="button" aria-label={`查看 ${instance.name} 详情`} onClick={onOpen}><Eye size={14} /> 详情</button></div></>;
}

export { DatabasesPage };
