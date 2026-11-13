import { CheckCircle2, Clock3, Download, FileText, Shield } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchAllAuditEvents, fetchAuditEvents, type AuditEvent } from "../api/auditApi";
import { resolvePageMeta } from "../app/navigation";
import { auditPagePreset } from "../app/pagePresets";
import { clearAuditSourceRoute, consumePendingAuditSource, readAuditSourceParam } from "../app/routing";
import { ModulePageShell } from "../components/layout/ModulePageShell";
import { MetricTile, ModuleSearch } from "../components/ui/Cards";
import { ConfirmDialog } from "../components/ui/ConfirmDialog";
import { DataTable } from "../components/ui/DataTable";
import { DetailDrawer } from "../components/ui/DetailDrawer";
import { FieldSelect } from "../components/ui/FormControls";
import { AuditExportActions, AuditExportBody, AuditExportFilters, AuditExportMetrics } from "../features/audit/AuditExportView";
import { useAuditExports } from "../features/audit/useAuditExports";
import { SecurityModuleTabs } from "../components/layout/SecurityModuleTabs";
import { auditRecord, formatAuditParameters } from "../features/audit/model";
import { usePollingResource } from "../hooks/usePollingResource";
import type { Permission } from "@stackpilot/contracts";
import type { AuditSource, Notify, PageKey } from "../types/app";
import { formatBackendDateTime } from "../utils/time";

function AuditPage({ page, notify, permissions = [] }: { page: PageKey; notify: Notify; permissions?: Permission[] }) {
  if (page === "audit-export") return <AuditExportPage page={page} notify={notify} allowed={permissions.includes("audit:read") && permissions.includes("audit:export")} />;
  return <AuditLogPage page={page} notify={notify} canExport={permissions.includes("audit:export")} />;
}

function AuditExportPage({ page, notify, allowed }: { page: PageKey; notify: Notify; allowed: boolean }) {
  const [search, setSearch] = useState("");
  const [format, setFormat] = useState("全部");
  const [status, setStatus] = useState("全部");
  const resource = useAuditExports(allowed);
  return <ModulePageShell
    title={resolvePageMeta(page).title}
    subtitle={auditPagePreset(page).subtitle}
    page={page}
    className="cloudpulse-security"
    tabs={<SecurityModuleTabs module="audit" page={page} canExport={allowed} />}
    viewContext={false}
    actions={allowed ? <AuditExportActions resource={resource} notify={notify} /> : undefined}
    filters={allowed ? <AuditExportFilters search={search} format={format} status={status} onSearch={setSearch} onFormat={setFormat} onStatus={setStatus} /> : undefined}
    metrics={allowed ? <AuditExportMetrics resource={resource} /> : undefined}
  >
    {allowed ? <AuditExportBody resource={resource} search={search} format={format} status={status} notify={notify} /> : <div className="overview-error-state" role="alert"><Shield size={18} /><span>当前账号没有审计导出权限</span></div>}
  </ModulePageShell>;
}

function AuditLogPage({ page, notify, canExport }: { page: PageKey; notify: Notify; canExport: boolean }) {
  const preset = auditPagePreset(page);
  const [auditSource, setAuditSource] = useState<AuditSource | undefined>(() => readAuditSourceParam() ?? undefined);
  const [searchByPage, setSearchByPage] = useState<Record<string, string>>({});
  const [userByPage, setUserByPage] = useState<Record<string, string>>({});
  const [resultByPage, setResultByPage] = useState<Record<string, string>>({});
  const [selectedByPage, setSelectedByPage] = useState<Record<string, string | null>>({});
  const [olderEvents, setOlderEvents] = useState<AuditEvent[]>([]);
  const [olderCursor, setOlderCursor] = useState<number | null | undefined>();
  const [olderLoading, setOlderLoading] = useState(false);
  const [olderError, setOlderError] = useState<string | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const exportController = useRef<AbortController | null>(null);
  const olderController = useRef<AbortController | null>(null);
  const search = searchByPage[page] ?? preset.search;
  const userFilter = userByPage[page] ?? preset.user;
  const resultFilter = resultByPage[page] ?? preset.result;
  const auditQuery = useMemo(() => ({
    ...(auditSource === "database" ? { actionPrefix: "database." } : {}),
    ...(userFilter !== "全部" ? { actor: userFilter } : {}),
    ...(resultFilter === "成功" ? { result: "success" as const } : resultFilter === "失败" ? { result: "failure" as const } : {}),
    ...(search.trim() ? { search: search.trim() } : {}),
  }), [auditSource, resultFilter, search, userFilter]);
  const resourceKey = JSON.stringify(auditQuery);
  const loadAudit = useCallback((signal: AbortSignal) => fetchAuditEvents(auditQuery, signal), [auditQuery]);
  const audit = usePollingResource(loadAudit, null, true, resourceKey);
  const events = useMemo(() => mergeAuditEvents(audit.data?.events ?? [], olderEvents), [audit.data, olderEvents]);
  const records = useMemo(() => events.map(auditRecord), [events]);
  const selectedId = selectedByPage[page] ?? null;
  const selected = records.find((row) => row.id === selectedId) ?? null;
  const actors = Array.from(new Set(records.map((row) => row.user)));
  const users = ["全部", ...(!actors.includes(userFilter) && userFilter !== "全部" ? [userFilter] : []), ...actors];
  const cursor = olderCursor === undefined ? audit.data?.nextCursor : olderCursor;
  const setSelectedId = useCallback((id: string | null) => {
    setSelectedByPage((current) => ({ ...current, [page]: id }));
  }, [page]);

  useEffect(() => {
    olderController.current?.abort();
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      setOlderEvents([]);
      setOlderCursor(undefined);
      setOlderError(null);
    });
    return () => { active = false; };
  }, [resourceKey]);

  useEffect(() => () => {
    exportController.current?.abort();
    olderController.current?.abort();
  }, []);

  useEffect(() => {
    const applyAuditSource = () => {
      const source = consumePendingAuditSource() ?? readAuditSourceParam() ?? undefined;
      setAuditSource(source);
      setSearchByPage((current) => ({ ...current, [page]: "" }));
      setUserByPage((current) => ({ ...current, [page]: "全部" }));
      setResultByPage((current) => ({ ...current, [page]: preset.result }));
      setSelectedId(null);
      if (source === "database") notify("已切换到数据库审计上下文", "info");
    };
    window.addEventListener("stackpilot:audit-source", applyAuditSource);
    window.addEventListener("hashchange", applyAuditSource);
    window.addEventListener("popstate", applyAuditSource);
    return () => {
      window.removeEventListener("stackpilot:audit-source", applyAuditSource);
      window.removeEventListener("hashchange", applyAuditSource);
      window.removeEventListener("popstate", applyAuditSource);
    };
  }, [notify, page, preset.result, setSelectedId]);

  useEffect(() => {
    if (!selectedId || !audit.data || selected) return;
    let active = true;
    queueMicrotask(() => { if (active) setSelectedId(null); });
    return () => { active = false; };
  }, [audit.data, selected, selectedId, setSelectedId]);

  const loadOlder = async () => {
    if (cursor === null || cursor === undefined || olderLoading) return;
    const controller = new AbortController();
    olderController.current?.abort();
    olderController.current = controller;
    setOlderLoading(true);
    setOlderError(null);
    try {
      const next = await fetchAuditEvents({ ...auditQuery, beforeSequence: cursor }, controller.signal);
      setOlderEvents((current) => mergeAuditEvents(current, next.events));
      setOlderCursor(next.nextCursor);
    } catch (error) {
      if (!controller.signal.aborted) setOlderError(error instanceof Error ? error.message : "更早审计日志加载失败");
    } finally {
      if (olderController.current === controller) {
        olderController.current = null;
        setOlderLoading(false);
      }
    }
  };

  const exportAuditRecords = async () => {
    if (!audit.data || exporting) return;
    const controller = new AbortController();
    exportController.current?.abort();
    exportController.current = controller;
    setExporting(true);
    try {
      const result = await fetchAllAuditEvents(auditQuery, controller.signal);
      const blob = new Blob([JSON.stringify({
        collectedAt: result.collectedAt,
        total: result.total,
        exportedCount: result.events.length,
        filters: auditQuery,
        events: result.events,
      }, null, 2)], { type: "application/json;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `stackpilot-audit-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      URL.revokeObjectURL(url);
      setExportOpen(false);
      notify(`已导出全部 ${result.events.length} 条匹配审计日志`, "success");
    } catch (error) {
      if (!controller.signal.aborted) notify(error instanceof Error ? error.message : "审计日志导出失败", "danger");
    } finally {
      if (exportController.current === controller) {
        exportController.current = null;
        setExporting(false);
      }
    }
  };

  const returnToGlobalAudit = () => {
    clearAuditSourceRoute();
    setAuditSource(undefined);
    setSearchByPage((current) => ({ ...current, [page]: "" }));
    setSelectedId(null);
    notify("已返回全部审计日志", "info");
  };
  const emptyText = audit.loading && !audit.data ? "正在读取真实审计日志" : "没有匹配的真实审计日志，系统将继续自动查询";
  const freshness = audit.backgroundError ? `后台刷新失败，保留上次数据：${audit.backgroundError}` : "数据来自 Controller 追加式审计表，每 10 秒自动查询";

  return <>
    <ModulePageShell
      title={resolvePageMeta(page).title}
      subtitle={auditSource === "database" ? "数据库审计视图，只展示数据库相关操作。" : preset.subtitle}
      page={page}
      className="cloudpulse-security"
      tabs={<SecurityModuleTabs module="audit" page={page} canExport={canExport} />}
      viewContext={false}
      actions={<>
        <button className="ghost" type="button" disabled={!audit.data || exporting} onClick={() => setExportOpen(true)}><Download size={15} /> {exporting ? "正在导出" : "导出全部匹配"}</button>
        {auditSource === "database" && <button className="ghost" type="button" onClick={returnToGlobalAudit}>全部审计</button>}
      </>}
      filters={<>
        <ModuleSearch value={search} placeholder="搜索关键字、对象、request id 或 trace id" onChange={(value) => setSearchByPage((current) => ({ ...current, [page]: value }))} />
        <FieldSelect label="操作者" value={userFilter} options={users} onChange={(value) => setUserByPage((current) => ({ ...current, [page]: value }))} />
        <FieldSelect label="结果" value={resultFilter} options={page === "audit-failed" ? ["失败"] : ["全部", "成功", "失败"]} onChange={(value) => setResultByPage((current) => ({ ...current, [page]: value }))} />
      </>}
      metrics={<>
        <MetricTile icon={FileText} label="日志" value={`${records.length}`} tone="blue" />
        <MetricTile icon={CheckCircle2} label="成功" value={`${records.filter((row) => row.result === "成功").length}`} tone="green" />
        <MetricTile icon={Shield} label="失败" value={`${records.filter((row) => row.result === "失败").length}`} tone="red" />
      </>}
      side={selected && <DetailDrawer className="audit-detail-drawer" modal title="审计详情" subtitle={selected.traceId} closeLabel="关闭审计详情" scrimCloseLabel="点击遮罩关闭审计详情" onClose={() => setSelectedId(null)}>
        <div className="detail-kv">
          <p><span>时间</span><b>{selected.time}</b></p><p><span>操作者</span><b>{selected.user}</b></p>
          <p><span>身份类型</span><b>{selected.actorType}</b></p><p><span>来源</span><b>{selected.source}</b></p>
          <p><span>对象</span><b>{selected.object}</b></p><p><span>对象类型</span><b>{selected.targetType}</b></p>
          <p><span>后端结果</span><b>{selected.outcome}</b></p><p><span>授权</span><b>{selected.authorization}</b></p>
          <p><span>Request ID</span><b>{selected.requestId}</b></p><p><span>事件哈希</span><b>{selected.eventHash}</b></p>
          <p><span>参数</span><code>{formatAuditParameters(selected.parameters)}</code></p>
        </div>
      </DetailDrawer>}
      sideModal={Boolean(selected)}
    >
      {audit.loading && !audit.data && <span className="sr-only" role="status">正在读取真实审计日志</span>}
      {audit.error && !audit.data ? <div className="overview-error-state"><Shield size={18} /><span>{audit.error}</span><button type="button" onClick={() => void audit.retry()}>重试</button></div> : <>
        <div className="slow-freshness"><Clock3 size={20} /><div><strong>后端采集于 {formatBackendDateTime(audit.data?.collectedAt, "等待采集")}</strong><span>{freshness} · 匹配 {records.length} 条</span></div></div>
        <DataTable
          columns={[
            { key: "time", label: "时间", width: "154px", sortValue: (row) => row.time, render: (row) => <span className="audit-cell-value" title={row.time}>{row.time}</span> },
            { key: "source", label: "来源", width: "130px", render: (row) => <span className="audit-cell-value" title={row.source}>{row.source}</span> },
            { key: "user", label: "操作者", width: "110px", render: (row) => <span className="audit-cell-value" title={row.user}>{row.user}</span> },
            { key: "action", label: "动作", width: "170px", render: (row) => <span className="audit-cell-value" title={row.action}>{row.action}</span> },
            { key: "object", label: "对象", width: "180px", render: (row) => <span className="audit-cell-value" title={row.object}>{row.object}</span> },
            { key: "result", label: "结果", width: "92px", render: (row) => <span className={`pill ${row.result === "失败" ? "red" : row.result === "成功" ? "green" : "blue"}`}>{row.result}</span> },
            { key: "trace", label: "trace id", width: "150px", render: (row) => <code className="audit-cell-value" title={row.traceId}>{row.traceId}</code> },
            { key: "ops", label: "操作", width: "78px", render: (row) => <span className="table-actions"><button type="button" onClick={() => setSelectedId(row.id)}>详情</button></span> },
          ]}
          rows={records}
          emptyText={emptyText}
          getRowKey={(row) => row.id}
          pageSize={50}
          mobileCard={(row) => <><div className="module-card-head"><span className="module-card-title"><FileText size={15} /><b title={row.action}>{row.action}</b></span><span className={`pill ${row.result === "失败" ? "red" : row.result === "成功" ? "green" : "blue"}`}>{row.result}</span></div><code className="module-card-code">{row.traceId}</code><div className="module-card-meta"><span><b>操作者</b><em>{row.user}</em></span><span><b>对象</b><em>{row.object}</em></span><span><b>来源</b><em>{row.source}</em></span><span><b>时间</b><em>{row.time}</em></span></div><div className="module-card-footer"><div className="table-actions actions-1"><button type="button" onClick={() => setSelectedId(row.id)}>详情</button></div></div></>}
        />
        {olderError && <div className="overview-error-state"><Shield size={18} /><span>{olderError}</span><button type="button" onClick={() => void loadOlder()}>重试加载更早记录</button></div>}
        {cursor !== null && cursor !== undefined && <div className="audit-load-more"><button className="ghost" type="button" disabled={olderLoading} onClick={() => void loadOlder()}>{olderLoading ? "正在加载" : "加载更早记录"}</button></div>}
      </>}
    </ModulePageShell>
    {exportOpen && <ConfirmDialog className="audit-export-confirm" tone="info" title="导出真实审计" message="将读取当前筛选条件下的全部匹配记录，并生成原始 JSON 文件。" confirmLabel={exporting ? "正在导出" : "导出 JSON"} detail={`JSON · 全部匹配 · ${audit.data?.total.toLocaleString("zh-CN") ?? 0} 条记录`} onClose={() => setExportOpen(false)} onConfirm={() => void exportAuditRecords()}><div className="audit-export-confirm-summary"><p><span>格式</span><b>JSON</b></p><p><span>范围</span><b>全部匹配</b></p><p><span>记录数</span><b>{audit.data?.total.toLocaleString("zh-CN") ?? 0}</b></p></div></ConfirmDialog>}
  </>;
}

function mergeAuditEvents(primary: AuditEvent[], secondary: AuditEvent[]) {
  const events = new Map<string, AuditEvent>();
  for (const event of [...primary, ...secondary]) events.set(event.eventId, event);
  return [...events.values()].sort((left, right) => right.sequence - left.sequence);
}

export { AuditPage };
