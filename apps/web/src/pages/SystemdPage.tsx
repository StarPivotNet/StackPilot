import type { SystemdServiceRecord, SystemdServicesPayload } from "@stackpilot/contracts";
import { CheckCircle2, CircleOff, CirclePause, CircleX, Clock3, CloudOff, MemoryStick, RotateCcw, ScrollText, ServerCog, TriangleAlert } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { systemdPagePreset } from "../app/pagePresets";
import { resolvePageMeta } from "../app/navigation";
import { ModulePageShell } from "../components/layout/ModulePageShell";
import { MetricTile, ModuleSearch } from "../components/ui/Cards";
import { DataTable } from "../components/ui/DataTable";
import { DetailDrawer } from "../components/ui/DetailDrawer";
import { FieldSelect } from "../components/ui/FormControls";
import { useSystemdServices } from "../features/services/useSystemdServices";
import type { Notify, PageKey } from "../types/app";
import { formatBackendDateTime } from "../utils/time";

type DisplayStatus = "active" | "failed" | "inactive";
type SystemdPageProps = {
  page: PageKey;
  notify: Notify;
  canOperate?: boolean;
  initialPayload?: SystemdServicesPayload | null;
};

function displayStatus(row: SystemdServiceRecord): DisplayStatus {
  if (row.activeState === "failed") return "failed";
  if (["active", "reloading", "activating"].includes(row.activeState)) return "active";
  return "inactive";
}

function statusMeta(row: SystemdServiceRecord) {
  const status = displayStatus(row);
  if (row.activeState === "reloading") return { label: "重载中", tone: "orange", icon: Clock3 };
  if (row.activeState === "activating") return { label: "启动中", tone: "orange", icon: Clock3 };
  if (status === "failed") return { label: "故障", tone: "red", icon: CircleX };
  if (status === "active") return { label: "运行中", tone: "green", icon: CheckCircle2 };
  return { label: row.activeState === "deactivating" ? "停止中" : "未运行", tone: "gray", icon: CirclePause };
}

function ServiceStatus({ row, nativeLabel = false }: { row: SystemdServiceRecord; nativeLabel?: boolean }) {
  const status = statusMeta(row); const Icon = status.icon;
  return <span className={`systemd-status ${status.tone}`}><Icon size={14} /><span>{nativeLabel ? `${row.activeState}/${row.subState}` : status.label}</span></span>;
}

function ServiceIdentity({ row }: { row: SystemdServiceRecord }) {
  return <span className="systemd-service-identity"><ServerCog size={16} /><b className="systemd-service-name" title={row.unit}>{row.unit}</b></span>;
}

function bytes(value: number | null) {
  if (value === null) return "暂不可用";
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB", "TB"]; let amount = value / 1024; let unit = units[0]!;
  for (let index = 1; index < units.length && amount >= 1024; index += 1) { amount /= 1024; unit = units[index]!; }
  return `${amount >= 10 ? amount.toFixed(0) : amount.toFixed(1)} ${unit}`;
}

function Journal({ row }: { row: SystemdServiceRecord }) {
  if (!row.journal.length) return <p className="systemd-journal-empty">当前快照没有可读日志</p>;
  return <div className="systemd-journal" role="log" aria-label={`${row.unit} journal 摘要`}>{row.journal.map((entry) => (
    <p key={entry.cursor}><time dateTime={entry.timestamp}>{formatBackendDateTime(entry.timestamp)}</time><span>{entry.identifier ? `${entry.identifier}${entry.pid ? `[${entry.pid}]` : ""}: ` : ""}{entry.message || "(空消息)"}</span></p>
  ))}</div>;
}

function SystemdPage({ page, initialPayload = null }: SystemdPageProps) {
  const servicePreset = systemdPagePreset(page); const { data: payload, loading, error, backgroundError, retry } = useSystemdServices(initialPayload);
  const [searchByPage, setSearchByPage] = useState<Record<string, string>>({}); const [statusByPage, setStatusByPage] = useState<Record<string, string>>({});
  const [drawerId, setDrawerId] = useState<string | null>(null); const logTriggerRef = useRef<HTMLButtonElement | null>(null); const previousDrawerIdRef = useRef<string | null>(null);
  const rows = useMemo(() => payload?.services ?? [], [payload]); const search = searchByPage[page] ?? servicePreset.search; const statusFilter = statusByPage[page] ?? servicePreset.status;
  const drawer = drawerId ? rows.find((row) => row.id === drawerId) ?? null : null;
  const filteredRows = rows.filter((row) => (!search.trim() || `${row.unit} ${row.description} ${row.host}`.toLowerCase().includes(search.trim().toLowerCase())) && (statusFilter === "全部" || displayStatus(row) === statusFilter));
  const visibleLogRows = filteredRows.slice(0, 100);
  const openLogs = (row: SystemdServiceRecord, trigger: HTMLButtonElement) => { logTriggerRef.current = trigger; setDrawerId(row.id); };

  useEffect(() => { if (!drawerId || !payload || rows.some((row) => row.id === drawerId)) return; let active = true; queueMicrotask(() => { if (active) setDrawerId(null); }); return () => { active = false; }; }, [drawerId, payload, rows]);
  useLayoutEffect(() => {
    const previousDrawerId = previousDrawerIdRef.current; previousDrawerIdRef.current = drawerId;
    if (!previousDrawerId || drawerId) return; const trigger = logTriggerRef.current; logTriggerRef.current = null;
    if (trigger && document.contains(trigger)) trigger.focus({ preventScroll: true });
  }, [drawerId]);

  const collectionMessage = backgroundError ? `后台刷新失败，保留上次数据：${backgroundError}` : payload?.warnings[0] ?? (payload?.collectionStatus === "complete" ? "数据来自 Agent 的只读 systemd 快照" : "等待 Agent 采集 systemd 数据");
  return <ModulePageShell title={resolvePageMeta(page).title} subtitle={servicePreset.subtitle} page={page} className="systemd-page" viewContext={false} sideModal tabs={<nav className="module-tabs" aria-label="服务视图">{([["systemd", "全部服务"], ["systemd-active", "运行中"], ["systemd-failed", "故障服务"], ["systemd-logs", "服务日志"]] as const).map(([route, label]) => <a key={route} href={`#${route}`} className={page === route ? "active" : undefined} aria-current={page === route ? "page" : undefined}>{label}</a>)}</nav>}
    filters={<><ModuleSearch value={search} placeholder="搜索服务、说明或主机" onChange={(value) => setSearchByPage((current) => ({ ...current, [page]: value }))} /><FieldSelect label="状态" value={statusFilter} options={[{ value: "全部", label: "全部状态" }, { value: "active", label: "运行中" }, { value: "failed", label: "故障" }, { value: "inactive", label: "未运行" }]} onChange={(value) => setStatusByPage((current) => ({ ...current, [page]: value }))} /></>}
    metrics={<><MetricTile icon={CheckCircle2} label="运行中" value={payload ? `${rows.filter((row) => displayStatus(row) === "active").length}` : "—"} tone="green" /><MetricTile icon={TriangleAlert} label="故障" value={payload ? `${rows.filter((row) => displayStatus(row) === "failed").length}` : "—"} tone="red" /><MetricTile icon={CircleOff} label="未运行" value={payload ? `${rows.filter((row) => displayStatus(row) === "inactive").length}` : "—"} tone="gray" /></>}
    side={drawer && <DetailDrawer title={servicePreset.mode === "logs" ? "服务日志详情" : drawer.unit} subtitle={`${drawer.unit} · ${drawer.host} · ${statusMeta(drawer).label}`} className={`systemd-service-drawer ${servicePreset.mode === "logs" ? "systemd-log-drawer" : ""}`} modal onClose={() => setDrawerId(null)}>
      <div className="systemd-drawer-content"><section className={`systemd-detail-summary ${statusMeta(drawer).tone}`} aria-label="服务当前状态"><ServiceStatus row={drawer} /><p>{drawer.description}</p></section>
        <dl className="systemd-detail-grid"><div><dt><ServerCog size={15} />主机</dt><dd title={drawer.host}>{drawer.host}</dd></div><div><dt><MemoryStick size={15} />内存</dt><dd>{bytes(drawer.memoryCurrentBytes)}</dd></div><div><dt><RotateCcw size={15} />重启次数</dt><dd>{drawer.restartCount ?? "暂不可用"}</dd></div><div><dt><Clock3 size={15} />采集时间</dt><dd>{formatBackendDateTime(drawer.sourceCollectedAt)}</dd></div></dl>
        <section className="systemd-drawer-journal"><header><span><ScrollText size={17} />journal 摘要</span><time>{formatBackendDateTime(drawer.sourceCollectedAt)}</time></header><Journal row={drawer} /></section>
      </div></DetailDrawer>}>
    {loading && !payload && <span className="sr-only" role="status">正在读取 systemd 服务</span>}
    {error && !payload && <div className="overview-error-state"><CloudOff size={18} /><span>{error}</span><button type="button" onClick={() => void retry()}>重试</button></div>}
    <div className="systemd-freshness"><Clock3 size={18} /><div><strong>采集时间 {formatBackendDateTime(payload?.collectedAt)}</strong><span>{collectionMessage}</span></div></div>
    <div className={`systemd-content ${servicePreset.mode === "logs" ? "logs-mode" : ""}`}>
      {servicePreset.mode === "logs" ? <section className="systemd-log-stream" aria-label="服务日志流"><header className="systemd-log-head"><span><ScrollText size={18} /><span><h2>服务日志流</h2><em>{filteredRows.length > 100 ? `显示前 100 / ${filteredRows.length} 个服务` : `${filteredRows.length} 个服务`}</em></span></span><time role="status" aria-label={`最新采集 ${formatBackendDateTime(payload?.collectedAt)}`}><Clock3 size={14} />最新采集 {formatBackendDateTime(payload?.collectedAt)}</time></header>
        <div className="systemd-log-list">{visibleLogRows.map((row) => <article key={row.id}><header><ServiceStatus row={row} nativeLabel /><strong title={row.unit}>{row.unit}</strong><code title={row.host}>{row.host}</code></header><Journal row={row} /><button type="button" aria-label={`打开服务 ${row.unit} 日志详情`} onClick={(event) => openLogs(row, event.currentTarget)}><ScrollText size={14} />打开详情</button></article>)}
          {!filteredRows.length && <p className="systemd-log-empty">{payload?.collectionStatus === "unavailable" ? "systemd 数据暂不可用" : "没有匹配的服务日志"}</p>}</div></section>
        : <DataTable columns={[{ key: "service", label: "服务", width: "180px", render: (row) => <button className="systemd-unit-button" type="button" aria-label={`查看服务 ${row.unit} 详情`} onClick={(event) => openLogs(row, event.currentTarget)}><ServiceIdentity row={row} /></button> }, { key: "description", label: "说明", render: (row) => <span className="systemd-description" title={row.description}>{row.description}</span> }, { key: "host", label: "主机", width: "120px", render: (row) => <code className="systemd-hostname" title={row.host}>{row.host}</code> }, { key: "status", label: "状态", width: "100px", render: (row) => <ServiceStatus row={row} /> }, { key: "restarts", label: "重启次数", width: "80px", render: (row) => row.restartCount ?? "-" }, { key: "memory", label: "内存", width: "90px", render: (row) => bytes(row.memoryCurrentBytes) }, { key: "logs", label: "日志", width: "60px", render: (row) => <button className="icon-action" type="button" title="日志详情" aria-label={`查看服务 ${row.unit} 日志`} onClick={(event) => openLogs(row, event.currentTarget)}><ScrollText size={15} /></button> }]} rows={filteredRows} pageSize={100} emptyText={payload?.collectionStatus === "unavailable" ? "systemd 数据暂不可用" : "没有匹配的服务"} getRowKey={(row) => row.id}
          mobileCard={(row) => <><div className="module-card-head"><ServiceIdentity row={row} /><ServiceStatus row={row} /></div><code className="module-card-code" title={row.host}>{row.host}</code><div className="module-card-meta"><span><b>重启</b><em>{row.restartCount ?? "-"}</em></span><span><b>内存</b><em>{bytes(row.memoryCurrentBytes)}</em></span><span><b>日志</b><em>{row.journal.length} 条</em></span></div><div className="module-card-footer"><button className="ghost" type="button" onClick={(event) => openLogs(row, event.currentTarget)}><ScrollText size={15} />查看日志</button></div></>} />}
    </div>
  </ModulePageShell>;
}

export { SystemdPage };
