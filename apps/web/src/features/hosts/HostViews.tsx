import { Activity, CheckCircle2, Clock3, Gauge, Server, Shield, TriangleAlert, WifiOff, Wrench } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { MetricTile } from "../../components/ui/Cards";
import { Bar, StatusLight } from "../../components/ui/StatusVisuals";
import type { HostPageMode } from "./types";
import type { HostView } from "./viewModel";
import { formatBytes, formatTimestamp, metricAria, metricText } from "./viewModel";
import {
  hostHasHighResource, hostHasStaleBackup, hostHighestResource, hostNeedsAttention,
  hostResourceTone, hostRiskReasons, hostStatusTone,
} from "./model";
import { uniqueSorted } from "../../utils/data";

function HostMetrics({ mode, rows, filteredRows, available = true }: { mode: HostPageMode; rows: HostView[]; filteredRows: HostView[]; available?: boolean }) {
  const count = (value: number) => available ? String(value) : "等待采集";
  const productionRows = rows.filter((row) => row.env === "生产");
  const currentRows = mode === "inventory" ? rows : filteredRows;
  if (mode === "production") return <><MetricTile icon={Server} label="生产主机" value={count(productionRows.length)} tone="blue" /><MetricTile icon={Activity} label="高水位" value={count(productionRows.filter(hostHasHighResource).length)} tone="orange" /><MetricTile icon={Clock3} label="备份异常" value={count(productionRows.filter(hostHasStaleBackup).length)} tone="orange" /></>;
  if (mode === "alerts") return <><MetricTile icon={Shield} label="待处理" value={count(rows.filter(hostNeedsAttention).length)} tone="orange" /><MetricTile icon={WifiOff} label="离线" value={count(rows.filter((row) => row.status === "离线").length)} tone="red" /><MetricTile icon={Clock3} label="备份异常" value={count(rows.filter(hostHasStaleBackup).length)} tone="orange" /></>;
  return <><MetricTile icon={Server} label="已接入主机" value={count(currentRows.length)} tone="blue" /><MetricTile icon={CheckCircle2} label="健康" value={count(rows.filter((row) => row.status === "健康").length)} tone="green" /><MetricTile icon={Shield} label="需关注" value={count(rows.filter(hostNeedsAttention).length)} tone="orange" /><MetricTile icon={WifiOff} label="当前离线" value={count(rows.filter((row) => row.status === "离线").length)} tone="gray" /></>;
}

function HostName({ row }: { row: HostView }) { return <span className="host-name-cell" title={row.name}><b>{row.name}</b></span>; }

function HostStatus({ row }: { row: HostView }) {
  const Icon = row.status === "健康" ? CheckCircle2 : row.status === "警告" ? TriangleAlert : row.status === "离线" ? WifiOff : row.status === "等待采集" ? Clock3 : Wrench;
  const label = row.status === "等待采集" && row.connectionStatus === "online" ? "在线 · 等待采集" : row.status;
  return <span className={`host-status ${hostStatusTone(row.status)}`}><Icon size={16} aria-hidden="true" />{label}</span>;
}

function MetricBar({ label, value }: { label: string; value: number | null }) {
  if (value === null) return <span className="host-metric-unavailable" aria-label={`${label} 等待采集`}>等待采集</span>;
  return <span aria-label={`${label} ${Math.round(value)}%`}><Bar value={`${Math.round(value)}%`} tone={hostResourceTone(value)} /></span>;
}

function HostPressureCell({ row }: { row: HostView }) {
  const primary = ([{ label: "CPU", value: row.cpu }, { label: "内存", value: row.memory }, { label: "磁盘", value: row.disk }])
    .filter((item): item is { label: string; value: number } => item.value !== null).sort((left, right) => right.value - left.value)[0];
  return primary ? <div className="host-pressure-cell"><span>{primary.label}</span><MetricBar label={primary.label} value={primary.value} /></div> : <span className="host-metric-unavailable">等待采集</span>;
}

function HostResourceSummary({ row }: { row: HostView }) {
  return <span className="host-resource-summary" aria-label={`${metricAria("CPU", row.cpu)}，${metricAria("内存", row.memory)}，${metricAria("磁盘", row.disk)}`}>
    <span><em>CPU</em><MetricBar label="CPU" value={row.cpu} /></span>
    <span><em>内存</em><MetricBar label="内存" value={row.memory} /></span>
    <span><em>磁盘</em><DiskMetric row={row} /></span>
  </span>;
}

function HostRiskTags({ row }: { row: HostView }) { return <span className="host-risk-tags">{hostRiskReasons(row).slice(0, 3).map((reason) => <em key={reason}>{reason}</em>)}</span>; }
function HostServices({ row }: { row: HostView }) { return <span className="host-service-pills">{row.services.length ? row.services.slice(0, 3).map((service) => <em key={service.id}>{service.name}</em>) : <em>不可用</em>}</span>; }

function DiskMetric({ row }: { row: HostView }) {
  const tooltipId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const openTimerRef = useRef<number | null>(null);
  const closeTimerRef = useRef<number | null>(null);
  const [tooltipPosition, setTooltipPosition] = useState<{ left: number; top: number; above: boolean } | null>(null);
  const clearOpenTimer = () => { if (openTimerRef.current !== null) window.clearTimeout(openTimerRef.current); openTimerRef.current = null; };
  const clearCloseTimer = () => { if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current); closeTimerRef.current = null; };
  const showTooltip = () => {
    clearCloseTimer();
    if (!row.diskVolumes.length || openTimerRef.current !== null || tooltipPosition) return;
    openTimerRef.current = window.setTimeout(() => {
      openTimerRef.current = null;
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const tooltipHeight = Math.min(360, window.innerHeight * 0.5);
      const above = rect.top >= tooltipHeight + 16;
      setTooltipPosition({ left: Math.min(Math.max(16, rect.right - 260), window.innerWidth - 276), top: above ? rect.top - 8 : rect.bottom + 8, above });
    }, 400);
  };
  const hideTooltip = () => {
    clearOpenTimer();
    clearCloseTimer();
    closeTimerRef.current = window.setTimeout(() => { closeTimerRef.current = null; setTooltipPosition(null); }, 100);
  };
  useEffect(() => () => {
    if (openTimerRef.current !== null) window.clearTimeout(openTimerRef.current);
    if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
  }, []);
  if (row.disk === null) return <span className="host-metric-unavailable">等待采集</span>;
  return <span className="host-disk-metric"><button ref={triggerRef} type="button" className="host-disk-trigger" aria-label={`磁盘使用率 ${metricText(row.disk)}`} aria-describedby={row.diskVolumes.length ? tooltipId : undefined} onMouseEnter={showTooltip} onMouseLeave={hideTooltip} onFocus={showTooltip} onBlur={hideTooltip}><MetricBar label="磁盘" value={row.disk} /></button>{tooltipPosition && createPortal(<span className={`host-disk-tooltip host-disk-tooltip-portal ${tooltipPosition.above ? "above" : "below"}`} id={tooltipId} role="tooltip" style={{ left: tooltipPosition.left, top: tooltipPosition.top }} onMouseEnter={clearCloseTimer} onMouseLeave={hideTooltip}><strong>全部磁盘卷</strong>{row.diskVolumes.map((volume) => <span key={`${volume.label}-${volume.mount}`}><b>{volume.label} ({volume.mount})</b><em>{volume.percent}% · 已用 {formatBytes(volume.usedBytes)} / {formatBytes(volume.totalBytes)}</em></span>)}</span>, document.body)}</span>;
}

function HostUsage({ label, value, kind = "cpu" }: { label: string; value: number | null; kind?: "cpu" | "memory" | "disk" }) {
  const radius = 34; const circumference = 2 * Math.PI * radius;
  const bounded = value === null ? null : Math.max(0, Math.min(100, value));
  return <div className="host-usage">{bounded === null ? <span className="host-usage-unavailable">等待采集</span> : <span className={`host-usage-ring ${kind}`} role="img" aria-label={`${label} ${Math.round(bounded)}%`}><svg viewBox="0 0 80 80" aria-hidden="true"><circle className="host-usage-track" cx="40" cy="40" r={radius} /><circle cx="40" cy="40" r={radius} strokeDasharray={circumference} strokeDashoffset={circumference * (1 - bounded / 100)} /></svg><b>{Math.round(bounded)}%</b></span>}<span>{label}</span></div>;
}

function HostDetailContent({ host }: { host: HostView }) {
  const freshness = host.telemetryFreshness === "stale" ? "数据已过期" : host.telemetryFreshness === "awaiting" ? "等待遥测" : "实时";
  return <div className="host-detail-content">
    <div className="host-detail-status" tabIndex={0} aria-label={`${host.name} 当前状态 ${host.status}`}><Server size={20} /><span><b><HostStatus row={host} /></b><em>{freshness} · 采集于 {formatTimestamp(host.collectedAt)}</em></span></div>
    <div className="detail-kv"><p><span>节点 ID</span><b>{host.id}</b></p><p><span>连接状态</span><b>{host.connectionLabel}</b></p><p><span>版本</span><b>{host.version}</b></p><p><span>运行时间</span><b>{host.uptime}</b></p><p><span>网络延迟</span><b>{host.latency}</b></p><p><span>更新</span><b>{host.update}</b></p><p><span>备份</span><b>{host.backup}</b></p><p><span>负责人</span><b>{host.owner}</b></p><p><span>最近在线</span><b>{formatTimestamp(host.lastSeenAt)}</b></p></div>
    <section className="host-detail-section"><strong>资源使用</strong><div className="host-usage-grid"><HostUsage label="CPU" value={host.cpu} /><HostUsage label="内存" value={host.memory} kind="memory" /><HostUsage label="全部磁盘" value={host.disk} kind="disk" /></div><p className="host-neutral-text">内存 {formatBytes(host.memoryUsedBytes)} / {formatBytes(host.memoryTotalBytes)} · 磁盘 {formatBytes(host.diskUsedBytes)} / {formatBytes(host.diskTotalBytes)}</p></section>
    <section className="host-detail-section"><strong>磁盘卷</strong><div className="host-volume-list">{host.diskVolumes.length ? host.diskVolumes.map((volume) => <p key={`${volume.label}-${volume.mount}`}><span><b>{volume.label}</b><em>{volume.mount}</em></span><strong>{volume.percent}%</strong><small>已用 {formatBytes(volume.usedBytes)} / {formatBytes(volume.totalBytes)}</small></p>) : <p className="host-detail-unavailable">卷级数据暂不可用，等待采集</p>}</div></section>
    <section className="host-detail-section"><strong>服务实例</strong><div className="drawer-list">{host.services.map((service) => <p key={service.id}><StatusLight tone={service.status === "健康" ? "green" : service.status === "警告" ? "orange" : "gray"} /><span><b>{service.name}</b><em>{service.target}</em></span><strong>{service.status}</strong></p>)}{host.services.length === 0 && <p className="host-detail-unavailable">服务数据不可用</p>}</div></section>
  </div>;
}

function HostFocusPanel({ mode, rows, filteredRows, collectedAt, onOpen }: { mode: HostPageMode; rows: HostView[]; filteredRows: HostView[]; collectedAt: string; onOpen: (host: HostView) => void }) {
  const visibleRows = mode === "inventory" ? rows : filteredRows;
  if (mode === "inventory") {
    const envCounts = uniqueSorted(rows.map((row) => row.env)).map((env) => [env, rows.filter((row) => row.env === env).length] as const);
    const serviceCount = uniqueSorted(rows.flatMap((row) => row.services.map((service) => service.name))).length;
    return <section className="host-focus-panel host-inventory-grid" aria-label="主机资源清单">{envCounts.map(([env, count]) => <article key={env}><span>{env}</span><strong>{count}</strong><em>{rows.filter((row) => row.env === env && row.status === "健康").length} 台健康</em></article>)}<article><span>服务覆盖</span><strong>{serviceCount}</strong><em>{filteredRows.length} 台当前命中</em></article>{rows.length === 0 && <p className="host-focus-empty">等待主机数据采集</p>}</section>;
  }
  return <section className={`host-focus-panel ${mode === "production" ? "host-production-board" : "host-alert-board"}`} aria-label={mode === "production" ? "生产主机视图" : "主机告警队列"}><div className="host-panel-section"><header><span>{mode === "production" ? "生产节点" : "处置队列"}</span><strong>{visibleRows.length} 台</strong></header><div className="host-lane-list">{visibleRows.slice(0, 6).map((row) => <button type="button" key={row.id} onClick={() => onOpen(row)}><HostStatus row={row} /><span><b title={row.name}>{row.name}</b><code>{row.ip}</code></span><em>{mode === "production" ? `高水位 ${hostHighestResource(row)}` : hostRiskReasons(row)[0]}</em></button>)}{visibleRows.length === 0 && <p className="host-focus-empty">没有匹配的主机，系统将继续自动采集</p>}</div></div><div className="host-panel-section host-alert-summary"><header><span>状态摘要</span><strong>{visibleRows.filter((row) => row.status === "健康").length}/{visibleRows.length} 健康</strong></header><p><TriangleAlert className="orange" size={16} aria-hidden="true" />警告节点 <b>{visibleRows.filter((row) => row.status === "警告").length}</b></p><p><WifiOff className="red" size={16} aria-hidden="true" />离线节点 <b>{visibleRows.filter((row) => row.status === "离线").length}</b></p><p><Gauge className="orange" size={16} aria-hidden="true" />资源高压 <b>{visibleRows.filter(hostHasHighResource).length}</b></p><p><Clock3 className="orange" size={16} aria-hidden="true" />备份异常 <b>{visibleRows.filter(hostHasStaleBackup).length}</b></p><small className="host-collection-time">采集于 {collectedAt}</small></div></section>;
}

export { DiskMetric, HostDetailContent, HostFocusPanel, HostMetrics, HostName, HostPressureCell, HostResourceSummary, HostRiskTags, HostServices, HostStatus, HostUsage, MetricBar };
