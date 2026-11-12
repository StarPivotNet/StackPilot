import { CheckCircle2, Clock3, Copy, Eye, Shield, TerminalSquare, XCircle } from "lucide-react";
import { useCallback, useState } from "react";
import { resolvePageMeta } from "../app/navigation";
import { ModulePageShell } from "../components/layout/ModulePageShell";
import { MetricTile, ModuleSearch } from "../components/ui/Cards";
import { DetailDrawer } from "../components/ui/DetailDrawer";
import { FieldSelect } from "../components/ui/FormControls";
import { useTerminalHistory } from "../features/terminal/useTerminalHistory";
import { useIsNarrowViewport } from "../hooks/useIsNarrowViewport";
import { TerminalTabs } from "../features/terminal/TerminalTabs";
import type { Notify } from "../types/app";
import { formatBackendDateTime } from "../utils/time";

function TerminalHistoryPage({ notify }: { notify: Notify }) {
  const narrow = useIsNarrowViewport();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("全部");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const reconcileSelection = useCallback((nextRows: Array<{ id: string }>) => setSelectedId((current) => current && nextRows.some((row) => row.id === current) ? current : null), []);
  const { rows, collectedAt, loading, error, retry } = useTerminalHistory(reconcileSelection);
  const selected = selectedId ? rows.find((row) => row.id === selectedId) ?? null : null;
  const filtered = rows.filter((row) => {
    const query = search.trim().toLowerCase();
    return (!query || `${row.action} ${row.taskType} ${row.host} ${row.actor} ${row.output} ${row.traceId}`.toLowerCase().includes(query))
      && (status === "全部" || row.status === status);
  });
  const successful = rows.filter((row) => row.status === "成功").length;
  const failed = rows.filter((row) => ["失败", "取消", "过期"].includes(row.status)).length;
  const copy = (value: string) => void navigator.clipboard.writeText(value).then(() => notify("任务标识已复制", "info")).catch(() => notify("复制失败，请检查浏览器剪贴板权限", "danger"));
  const freshness = collectedAt ? `后端采集于 ${formatBackendDateTime(collectedAt)}` : "等待后端时间";

  const statusBadge = (row: (typeof rows)[number]) => <span className={`terminal-history-status ${row.tone}`}>{row.status === "成功" ? <CheckCircle2 size={16} /> : row.status === "失败" ? <XCircle size={16} /> : <Clock3 size={16} />}{row.status}</span>;
  const actions = (row: (typeof rows)[number]) => <><button className="terminal-history-action" type="button" aria-label={`从操作区查看任务详情 ${row.action}，节点 ${row.host}，任务 ${row.id}`} onClick={() => setSelectedId(row.id)}><Eye size={15} />详情</button><button className="terminal-history-action" type="button" aria-label={`复制任务 ID ${row.id}，${row.action}，节点 ${row.host}`} onClick={() => copy(row.id)}><Copy size={15} />复制任务 ID</button></>;
  const emptyText = error ? "真实执行历史加载失败，未显示示例数据" : rows.length ? "没有匹配的执行历史" : "尚无受控任务记录，系统将继续自动采集";
  return <ModulePageShell
    title={resolvePageMeta("terminal-history").title}
    subtitle="查看受控任务的执行状态、输出和追踪标识。"
    page="terminal-history" className="terminal-history-page terminal-page" viewContext={false} tabs={<TerminalTabs page="terminal-history" />}
    filters={<><ModuleSearch value={search} placeholder="搜索动作、节点、结果或 trace id" onChange={setSearch} /><FieldSelect label="结果" value={status} options={["全部", "等待", "运行中", "成功", "失败", "取消", "过期"]} onChange={setStatus} /></>}
    metrics={<><MetricTile icon={TerminalSquare} label="任务记录" value={loading || error ? "—" : `${rows.length}`} tone="blue" /><MetricTile icon={CheckCircle2} label="成功" value={loading || error ? "—" : `${successful}`} tone="green" /><MetricTile icon={Shield} label="失败或终止" value={loading || error ? "—" : `${failed}`} tone="orange" /></>}
  >
    {loading && <span className="sr-only" role="status" aria-live="polite">正在从 /api/remote-tasks 读取真实任务历史</span>}
    {error && <div className="overview-error-state terminal-history-error"><Shield size={18} /><span>{error}</span><button type="button" disabled={loading} onClick={() => void retry()}>重试</button></div>}
    {!loading && !error && <p className="module-freshness-note"><Clock3 size={14} />{freshness}</p>}
    {narrow ? <div className="terminal-history-list terminal-history-live-list">
      {filtered.map((row) => <article key={row.id}>
        <header>{statusBadge(row)}<time>{formatBackendDateTime(row.updatedAt)}</time></header>
        <button className="terminal-history-command" type="button" aria-label={`查看任务详情 ${row.action}，节点 ${row.host}，任务 ${row.id}`} onClick={() => setSelectedId(row.id)}><code>{row.action}</code><small>{row.taskType}</small></button>
        <p className="terminal-history-context"><b title={row.host}>{row.host}</b><span>{row.actor} · 总历时 {row.duration}</span></p>
        <p className="terminal-history-output">{row.output}{row.truncated ? " · 输出已截断" : ""}</p><footer>{actions(row)}</footer>
      </article>)}
      {!loading && filtered.length === 0 && <p className="module-empty-card">{emptyText}</p>}
    </div> : <div className="module-table-wrap terminal-history-table"><table className="mini-table module-table"><colgroup><col style={{width:"32%"}} /><col style={{width:"20%"}} /><col style={{width:"10%"}} /><col style={{width:"16%"}} /><col style={{width:"12%"}} /><col style={{width:"10%"}} /></colgroup><thead><tr><th>命令与输出</th><th>目标节点</th><th>结果</th><th>执行信息</th><th>更新时间</th><th>操作</th></tr></thead><tbody>{filtered.map((row) => <tr key={row.id}>
      <td><button className="terminal-history-command" type="button" aria-label={`查看任务详情 ${row.action}，节点 ${row.host}，任务 ${row.id}`} onClick={() => setSelectedId(row.id)}><code>{row.action}</code><small>{row.taskType}</small></button><p className="terminal-history-table-output" title={row.output}>{row.output}{row.truncated ? " · 输出已截断" : ""}</p></td>
      <td><b className="terminal-history-host" title={row.host}>{row.host}</b></td><td>{statusBadge(row)}</td><td><span className="terminal-history-actor">{row.actor} · 总历时 {row.duration}</span></td><td><time>{formatBackendDateTime(row.updatedAt)}</time></td><td><div className="terminal-history-table-actions">{actions(row)}</div></td>
    </tr>)}{!loading && filtered.length === 0 && <tr><td colSpan={6} className="empty-row" role="status">{emptyText}</td></tr>}</tbody></table></div>}
    {selected && <DetailDrawer title={selected.action} subtitle={`${selected.host} · ${formatBackendDateTime(selected.updatedAt)}`} className="terminal-history-drawer" modal onClose={() => setSelectedId(null)}>
      <div className="terminal-history-detail"><div className={`terminal-history-detail-status ${selected.tone}`}><TerminalSquare size={20} /><span><strong>{selected.status}</strong><em>总历时 {selected.duration}</em></span></div><dl><div><dt>目标节点</dt><dd>{selected.host}</dd></div><div><dt>执行主体</dt><dd>{selected.actor}</dd></div><div><dt>创建时间</dt><dd>{formatBackendDateTime(selected.createdAt)}</dd></div><div><dt>更新时间</dt><dd>{formatBackendDateTime(selected.updatedAt)}</dd></div></dl><section><h3>受控任务类型</h3><code>{selected.taskType}</code></section><section><h3>结果摘要</h3><pre>{selected.output}{selected.truncated ? "\n[后端已截断]" : ""}</pre></section><section><h3>追踪标识</h3><code>{selected.traceId}</code></section></div>
    </DetailDrawer>}
  </ModulePageShell>;
}

export { TerminalHistoryPage };
