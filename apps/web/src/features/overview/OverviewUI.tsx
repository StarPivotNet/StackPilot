import type { OverviewNode } from "../../api/overviewApi";
import { AlertTriangle, CheckCircle2, Clock3, LoaderCircle, Server, ShieldAlert } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { pushPageRoute } from "../../app/routing";
import type { PageKey } from "../../types/app";
import { formatBackendDateTime } from "../../utils/time";
import { formatOverviewBytes, overviewNodeDisk } from "./model";

export function OverviewNavigation({ active }: { active: PageKey }) {
  const pages = [["overview", "工作台"], ["overview-health", "集群状态"], ["overview-tasks", "任务流"], ["overview-risks", "风险中心"]] as const;
  return <nav className="overview-navigation" aria-label="总览页面">{pages.map(([route, title]) => <a key={route} href={`#${route}`} aria-current={active === route ? "page" : undefined} onClick={(event) => { if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return; event.preventDefault(); pushPageRoute(route); }}>{title}</a>)}</nav>;
}

export function OverviewFreshness({ value }: { value?: string | null }) {
  return <span className="overview-collection-time"><Clock3 size={14} aria-hidden="true" /><time dateTime={value || undefined}>{value ? `采集于 ${formatBackendDateTime(value)}` : "等待采集"}</time></span>;
}

export function OverviewState({ loading, error, title, description, onRetry }: { loading?: boolean; error?: string | null; title?: string; description?: string; onRetry?: () => void }) {
  const Icon = error ? ShieldAlert : loading ? LoaderCircle : Server;
  return <section className={`overview-state ${error ? "is-error" : ""}`} role={error ? "alert" : "status"}>
    <span className="overview-state-icon"><Icon size={32} aria-hidden="true" /></span>
    <div><h2>{title ?? (error ? "数据暂不可用" : loading ? "正在采集" : "等待首次采集")}</h2><p>{error || description || (loading ? "正在等待后端返回监控数据。" : "采集成功后将显示运行信息，自动采集将继续运行。")}</p></div>
    {error && onRetry && <button className="primary" type="button" onClick={onRetry}>重试</button>}
  </section>;
}

export function OverviewNodeStatus({ node }: { node: Pick<OverviewNode, "status"> }) {
  const tone = node.status === "健康" ? "green" : node.status === "离线" ? "red" : node.status === "维护" ? "gray" : "orange";
  const Icon = node.status === "健康" ? CheckCircle2 : node.status === "离线" ? ShieldAlert : node.status === "维护" ? Clock3 : AlertTriangle;
  return <span className={`overview-semantic-status ${tone}`}><Icon size={16} aria-hidden="true" />{node.status}</span>;
}

export function OverviewUsageRing({ value, label, tone = "blue" }: { value: string; label: string; tone?: string }) {
  const numeric = Number.parseFloat(value);
  const available = /^\d+(\.\d+)?\s*%$/.test(value) && Number.isFinite(numeric);
  if (!available) return <span className="overview-usage-unavailable">暂不可用</span>;
  return <span className={`overview-usage-ring ${tone}`} role="img" aria-label={`${label} ${value}`}>
    <svg viewBox="0 0 80 80" aria-hidden="true"><circle className="overview-ring-track" cx="40" cy="40" r="32" /><circle className="overview-ring-value" cx="40" cy="40" r="32" pathLength="100" strokeDasharray="100" strokeDashoffset={100 - Math.max(0, Math.min(100, numeric))} /></svg>
    <span className="overview-ring-value-label">{Number(numeric.toFixed(1))}<small>%</small></span>
  </span>;
}

/** Portal placement avoids clipping in tables and stays inside narrow viewports. */
export function OverviewDiskUsage({ node, compact = false }: { node: OverviewNode; compact?: boolean }) {
  const id = useId();
  const anchor = useRef<HTMLSpanElement>(null);
  const timer = useRef<number | undefined>(undefined);
  const [position, setPosition] = useState<{ left: number; top: number; below: boolean; maxHeight: number } | null>(null);
  const disk = overviewNodeDisk(node);
  const close = () => { window.clearTimeout(timer.current); setPosition(null); };
  const show = () => {
    window.clearTimeout(timer.current);
    if (!disk.volumes.length) return;
    timer.current = window.setTimeout(() => {
      const rect = anchor.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(260, window.innerWidth - 32);
      const below = rect.top < 240;
      setPosition({ left: Math.max(16, Math.min(window.innerWidth - width - 16, rect.left + rect.width / 2 - width / 2)), top: below ? rect.bottom + 8 : rect.top - 8, below, maxHeight: Math.max(80, below ? window.innerHeight - rect.bottom - 24 : rect.top - 24) });
    }, 400);
  };
  useEffect(() => () => window.clearTimeout(timer.current), []);
  if (!node.availability.disk) return <span className="overview-usage-unavailable">暂不可用</span>;
  return <span ref={anchor} className="overview-disk-value" tabIndex={disk.volumes.length ? 0 : undefined} aria-label={disk.volumes.length ? "查看全部磁盘明细" : undefined} aria-describedby={position ? id : undefined} onMouseEnter={show} onMouseLeave={close} onFocus={show} onBlur={close} onKeyDown={(event) => { if (event.key === "Escape") close(); }}>
    {compact ? <span>{disk.value}</span> : <OverviewUsageRing value={disk.value} label="全部磁盘使用率" tone="teal" />}
    {position && createPortal(<span className="overview-volume-tooltip" id={id} role="tooltip" style={{ left: position.left, top: position.top, maxHeight: position.maxHeight, transform: position.below ? undefined : "translateY(-100%)" }}><strong>全部磁盘 · 容量加权</strong>{disk.volumes.map((volume) => <span key={`${volume.mount}-${volume.label}`}><b>{volume.label || volume.mount} · {volume.percent}%</b><small>{volume.mount} · {formatOverviewBytes(volume.usedBytes)} / {formatOverviewBytes(volume.totalBytes)}</small></span>)}</span>, document.body)}
  </span>;
}
