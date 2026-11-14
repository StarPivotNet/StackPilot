import { Eye, Shield } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { fetchHosts } from "../api/hostsApi";
import { resolvePageMeta } from "../app/navigation";
import { ModulePageShell } from "../components/layout/ModulePageShell";
import { ModuleSearch } from "../components/ui/Cards";
import { DataTable } from "../components/ui/DataTable";
import type { TableColumn } from "../components/ui/DataTable";
import { DetailDrawer } from "../components/ui/DetailDrawer";
import { FieldSelect } from "../components/ui/FormControls";
import {
  DiskMetric, HostDetailContent, HostFocusPanel, HostMetrics, HostName, HostPressureCell,
  HostResourceSummary, HostRiskTags, HostServices, HostStatus, HostUsage, MetricBar,
} from "../features/hosts/HostViews";
import {
  hostHasStaleBackup, hostHealthOptions, hostHighestResource, hostMatchesHealth, hostPagePreset,
  hostPressureScore, isCleanUpdate,
} from "../features/hosts/model";
import { formatTimestamp, toHostView } from "../features/hosts/viewModel";
import type { HostView } from "../features/hosts/viewModel";
import { ResourceNavigation } from "../features/hosts/ResourceNavigation";
import { reportApiError } from "../features/overview/model";
import { useAutoRefresh } from "../hooks/useAutoRefresh";
import type { Notify, PageKey } from "../types/app";
import { uniqueSorted } from "../utils/data";

function HostsPage({ page, notify }: { page: PageKey; notify: Notify }) {
  const preset = hostPagePreset(page);
  const [rows, setRows] = useState<HostView[]>([]);
  const [available, setAvailable] = useState(false);
  const [searchByPage, setSearchByPage] = useState<Record<string, string>>({});
  const [envByPage, setEnvByPage] = useState<Record<string, string>>({});
  const [healthByPage, setHealthByPage] = useState<Record<string, string>>({});
  const [selectedHostId, setSelectedHostId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [collectedAt, setCollectedAt] = useState("等待后端时间");
  const requestRef = useRef<AbortController | null>(null);
  const inFlightRef = useRef<Promise<void> | null>(null);
  const hasDataRef = useRef(false);
  const search = searchByPage[page] ?? preset.search;
  const envFilter = preset.mode === "production" ? preset.env : envByPage[page] ?? preset.env;
  const healthFilter = healthByPage[page] ?? preset.health;
  const selectedHost = rows.find((row) => row.id === selectedHostId) ?? null;
  const filteredRows = rows.filter((row) => {
    const query = search.trim().toLowerCase();
    const searchable = [row.name, row.ip, row.owner, row.version, row.platform, row.status, ...row.services.flatMap((service) => [service.name, service.target])].join(" ").toLowerCase();
    return (!query || searchable.includes(query)) && (envFilter === "全部" || row.env === envFilter) && hostMatchesHealth(row, healthFilter);
  });
  const envOptions = uniqueSorted([preset.env, ...rows.map((row) => row.env)].filter((value) => value !== "全部"));

  const loadHosts = useCallback((externalSignal?: AbortSignal, silent = false) => {
    if (inFlightRef.current) return inFlightRef.current;
    if (!silent) { setLoading(true); setError(null); }
    const controller = new AbortController();
    const abort = () => controller.abort();
    externalSignal?.addEventListener("abort", abort, { once: true });
    requestRef.current = controller;
    const request = fetchHosts(controller.signal)
      .then((payload) => {
        if (controller.signal.aborted) return;
        const nextRows = payload.hosts.map(toHostView);
        hasDataRef.current = true;
        setAvailable(true);
        setRows(nextRows);
        setSelectedHostId((current) => current && nextRows.some((row) => row.id === current) ? current : null);
        setCollectedAt(formatTimestamp(payload.collectedAt));
        setError(null);
      })
      .catch((loadError: unknown) => {
        if (controller.signal.aborted) return;
        if (!silent || !hasDataRef.current) {
          setError(loadError instanceof Error ? loadError.message : "主机监控后端加载失败");
          if (!silent) reportApiError(loadError, notify, "主机监控后端加载失败");
        }
      })
      .finally(() => {
        externalSignal?.removeEventListener("abort", abort);
        if (requestRef.current === controller) requestRef.current = null;
        if (inFlightRef.current === request) inFlightRef.current = null;
        if (!controller.signal.aborted && !silent) setLoading(false);
      });
    inFlightRef.current = request;
    return request;
  }, [notify]);

  useEffect(() => {
    let disposed = false;
    queueMicrotask(() => { if (!disposed) void loadHosts(); });
    return () => { disposed = true; requestRef.current?.abort(); };
  }, [loadHosts]);
  useAutoRefresh((signal) => loadHosts(signal, true), undefined, !loading);

  const detailAction = (row: HostView) => <span className="table-icon-actions host-actions"><button type="button" title="查看详情" aria-label={`查看主机 ${row.name}`} onClick={() => setSelectedHostId(row.id)}><Eye size={15} /></button></span>;
  const columns: Array<TableColumn<HostView>> = preset.mode === "production" ? [
    { key: "name", label: "生产节点", width: "184px", render: (row) => <HostName row={row} /> },
    { key: "ip", label: "IP 地址", width: "128px", render: (row) => row.ip },
    { key: "pressure", label: "资源使用", width: "218px", sortValue: hostPressureScore, render: (row) => <HostResourceSummary row={row} /> },
    { key: "services", label: "关键服务", width: "176px", render: (row) => <HostServices row={row} /> },
    { key: "backup", label: "备份", width: "132px", render: (row) => <span className={hostHasStaleBackup(row) ? "orange-text" : row.backupStatus === "健康" ? "green-text" : "host-neutral-text"}>{row.backup}</span> },
    { key: "update", label: "更新", width: "128px", render: (row) => <span className={isCleanUpdate(row.update) ? "green-text" : "host-neutral-text"}>{row.update}</span> },
    { key: "collected", label: "采集时间", width: "132px", render: (row) => formatTimestamp(row.collectedAt) },
    { key: "status", label: "健康", width: "92px", render: (row) => <HostStatus row={row} /> },
    { key: "ops", label: "操作", width: "64px", control: true, render: detailAction },
  ] : preset.mode === "alerts" ? [
    { key: "issue", label: "告警对象", width: "240px", render: (row) => <div className="host-issue-cell"><HostName row={row} /><HostRiskTags row={row} /></div> },
    { key: "env", label: "环境 / IP", width: "160px", render: (row) => <span className="host-env-ip"><em>{row.env}</em><code>{row.ip}</code></span> },
    { key: "pressure", label: "资源压力", width: "150px", sortValue: hostPressureScore, render: (row) => <HostPressureCell row={row} /> },
    { key: "backup", label: "备份", width: "132px", render: (row) => row.backup },
    { key: "collected", label: "遥测时间", width: "132px", render: (row) => formatTimestamp(row.collectedAt) },
    { key: "status", label: "状态", width: "92px", render: (row) => <HostStatus row={row} /> },
    { key: "ops", label: "操作", width: "64px", control: true, render: detailAction },
  ] : [
    { key: "name", label: "主机名", width: "184px", render: (row) => <HostName row={row} /> },
    { key: "ip", label: "IP 地址", width: "128px", render: (row) => row.ip },
    { key: "env", label: "环境", width: "84px", render: (row) => row.env },
    { key: "collected", label: "采集时间", width: "132px", render: (row) => formatTimestamp(row.collectedAt) },
    { key: "cpu", label: "CPU", width: "112px", sortValue: (row) => row.cpu ?? -1, render: (row) => <MetricBar label="CPU" value={row.cpu} /> },
    { key: "memory", label: "内存", width: "112px", sortValue: (row) => row.memory ?? -1, render: (row) => <MetricBar label="内存" value={row.memory} /> },
    { key: "disk", label: "磁盘", width: "112px", sortValue: (row) => row.disk ?? -1, render: (row) => <DiskMetric row={row} /> },
    { key: "status", label: "健康", width: "92px", render: (row) => <HostStatus row={row} /> },
    { key: "ops", label: "操作", width: "64px", control: true, render: detailAction },
  ];

  return <ModulePageShell title={resolvePageMeta(page).title} subtitle={loading ? "正在采集主机、服务与资源状态" : preset.subtitle} page={page} className="resource-cloudpulse" viewContext={false} tabs={<ResourceNavigation module="hosts" page={page} />} filters={<><ModuleSearch value={search} placeholder="搜索主机名、IP、服务或版本" onChange={(value) => setSearchByPage((current) => ({ ...current, [page]: value }))} /><FieldSelect label="环境" value={envFilter} options={preset.mode === "production" ? [preset.env] : ["全部", ...envOptions]} onChange={(value) => setEnvByPage((current) => ({ ...current, [page]: value }))} /><FieldSelect label="健康" value={healthFilter} options={hostHealthOptions(preset.mode)} onChange={(value) => setHealthByPage((current) => ({ ...current, [page]: value }))} /></>} metrics={<HostMetrics mode={preset.mode} rows={rows} filteredRows={filteredRows} available={available} />}>
    <p className="resource-freshness">后端采集于 {collectedAt}</p>
    {loading && <span className="sr-only" role="status" aria-live="polite">正在从 /api/hosts 实时采集主机状态</span>}
    {error && <div className="overview-error-state hosts-error-state"><Shield size={18} /><span>{error}</span><button type="button" disabled={loading} onClick={() => void loadHosts()}>重试</button></div>}
    {preset.mode !== "inventory" && <HostFocusPanel mode={preset.mode} rows={rows} filteredRows={filteredRows} collectedAt={collectedAt} onOpen={(row) => setSelectedHostId(row.id)} />}
    <DataTable columns={columns} rows={filteredRows} emptyText={error ? "实时采集失败，未显示示例主机" : loading ? "正在采集主机状态" : "没有匹配的主机，系统将继续自动采集"} getRowKey={(row) => row.id} mobileCard={(row) => <><div className="module-card-head host-mobile-head"><button className="module-row-link host-mobile-name" type="button" title={row.name} aria-label={`查看主机 ${row.name}`} onClick={() => setSelectedHostId(row.id)}><HostName row={row} /></button><HostStatus row={row} /></div><code className="module-card-code">{row.ip}</code><div className="host-usage-grid host-mobile-metrics"><HostUsage label="CPU" value={row.cpu} /><HostUsage label="内存" value={row.memory} kind="memory" /><HostUsage label="全部磁盘" value={row.disk} kind="disk" /></div>{preset.mode === "alerts" && <HostRiskTags row={row} />}<div className="module-card-meta"><span><b>环境</b><em>{row.env}</em></span><span><b>版本</b><em>{row.version}</em></span><span><b>高水位</b><em>{hostHighestResource(row)}</em></span><span><b>采集</b><em>{formatTimestamp(row.collectedAt)}</em></span></div><div className="module-card-footer"><span className="host-neutral-text">{row.backup}</span><button className="ghost small" type="button" onClick={() => setSelectedHostId(row.id)}><Eye size={14} /> 查看详情</button></div></>} />
    {selectedHost && <DetailDrawer title={selectedHost.name} subtitle={`${selectedHost.ip} · ${selectedHost.env}`} onClose={() => setSelectedHostId(null)} className="host-detail-drawer" modal><HostDetailContent host={selectedHost} /></DetailDrawer>}
  </ModulePageShell>;
}

export { HostsPage };
