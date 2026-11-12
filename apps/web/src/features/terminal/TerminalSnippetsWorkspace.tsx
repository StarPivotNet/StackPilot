import type { AgentNodeRecord, Permission, RemoteTaskRecord, TerminalSnippetRecord } from "@stackpilot/contracts";
import { AlertTriangle, CheckCircle2, Clock3, Copy, Eye, Play, Server, Shield, Star, TerminalSquare, XCircle } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { executeTerminalSnippet, fetchTerminalSnippetNodes, fetchTerminalSnippets, fetchTerminalSnippetTasks, updateTerminalSnippetFavorite } from "../../api/terminalApi";
import { reauthenticate } from "../../api/identityApi";
import { resolvePageMeta } from "../../app/navigation";
import { ModulePageShell } from "../../components/layout/ModulePageShell";
import { MetricTile, ModuleSearch } from "../../components/ui/Cards";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog";
import { DetailDrawer } from "../../components/ui/DetailDrawer";
import { FieldSelect } from "../../components/ui/FormControls";
import { useAutoRefresh } from "../../hooks/useAutoRefresh";
import type { Notify } from "../../types/app";
import { createLocalId, formatBackendDateTime } from "../../utils/time";
import { TerminalTabs } from "./TerminalTabs";

const riskLabel = { read: "只读", change: "变更", danger: "危险" } as const;
const taskStatusLabel: Record<RemoteTaskRecord["status"], string> = { queued: "等待 Agent", dispatched: "已下发", running: "执行中", succeeded: "成功", failed: "失败", cancelled: "已取消", expired: "已过期" };

function taskTone(status: RemoteTaskRecord["status"]) {
  if (status === "succeeded") return "success";
  if (["failed", "cancelled", "expired"].includes(status)) return "danger";
  return "pending";
}

function taskIcon(status: RemoteTaskRecord["status"]) {
  if (status === "succeeded") return <CheckCircle2 size={18} />;
  if (["failed", "cancelled", "expired"].includes(status)) return <XCircle size={18} />;
  return <Clock3 size={18} />;
}

function availableFor(node: AgentNodeRecord, snippet: TerminalSnippetRecord) {
  return node.status === "online" && snippet.requiredCapability !== null
    && node.declaredCapabilities.includes(snippet.requiredCapability)
    && node.allowedCapabilities.includes(snippet.requiredCapability);
}

function useTerminalSnippetData(enabled: boolean) {
  const [snippets, setSnippets] = useState<TerminalSnippetRecord[]>([]);
  const [nodes, setNodes] = useState<AgentNodeRecord[]>([]);
  const [tasks, setTasks] = useState<RemoteTaskRecord[]>([]);
  const [collectedAt, setCollectedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(enabled ? null : "当前账号没有常用命令读取权限");
  const inFlight = useRef<Promise<void> | null>(null);

  const load = useCallback((signal?: AbortSignal, silent = false) => {
    if (!enabled || inFlight.current) return inFlight.current ?? Promise.resolve();
    if (!silent) { setLoading(true); setError(null); }
    const request = Promise.all([
      fetchTerminalSnippets(signal), fetchTerminalSnippetNodes(signal), fetchTerminalSnippetTasks(signal),
    ]).then(([snippetPayload, nodePayload, taskPayload]) => {
      if (signal?.aborted) return;
      setSnippets(snippetPayload.snippets); setNodes(nodePayload.nodes); setTasks(taskPayload.tasks);
      setCollectedAt(snippetPayload.collectedAt); setError(null);
    }).catch((reason: unknown) => {
      if (!signal?.aborted && !silent) setError(reason instanceof Error ? reason.message : "常用命令后端加载失败");
    }).finally(() => {
      if (inFlight.current === request) inFlight.current = null;
      if (!signal?.aborted && !silent) setLoading(false);
    });
    inFlight.current = request;
    return request;
  }, [enabled]);

  const refreshRuntime = useCallback(async (signal: AbortSignal) => {
    const [nodePayload, taskPayload] = await Promise.all([fetchTerminalSnippetNodes(signal), fetchTerminalSnippetTasks(signal)]);
    if (signal.aborted) return;
    setNodes(nodePayload.nodes); setTasks(taskPayload.tasks);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    queueMicrotask(() => void load(controller.signal));
    return () => controller.abort();
  }, [load]);
  useAutoRefresh(refreshRuntime, undefined, enabled && !loading && !error);

  const toggleFavorite = useCallback(async (snippet: TerminalSnippetRecord) => {
    const updated = await updateTerminalSnippetFavorite(snippet.id, !snippet.favorite);
    setSnippets((current) => current.map((item) => item.id === updated.id ? updated : item));
    return updated;
  }, []);
  const acceptExecution = useCallback((snippet: TerminalSnippetRecord, task: RemoteTaskRecord) => {
    setSnippets((current) => current.map((item) => item.id === snippet.id ? snippet : item));
    setTasks((current) => [task, ...current.filter((item) => item.taskId !== task.taskId)]);
  }, []);

  return { snippets, nodes, tasks, collectedAt, loading, error, retry: load, toggleFavorite, acceptExecution };
}

function TerminalSnippetsWorkspace({ notify, permissions }: { notify: Notify; permissions: Permission[] }) {
  const canRead = permissions.includes("terminal:read");
  const canExecute = permissions.includes("terminal:execute");
  const { snippets, nodes, tasks, collectedAt, loading, error, retry, toggleFavorite, acceptExecution } = useTerminalSnippetData(canRead);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("全部");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [targetNodeId, setTargetNodeId] = useState("");
  const [pendingExecution, setPendingExecution] = useState<{ snippetId: string; nodeId: string; idempotencyKey: string } | null>(null);
  const [password, setPassword] = useState("");
  const passwordRef = useRef<HTMLInputElement>(null);
  const [executing, setExecuting] = useState(false);
  const [executionTaskId, setExecutionTaskId] = useState<string | null>(null);
  const selected = selectedId ? snippets.find((snippet) => snippet.id === selectedId) ?? null : null;
  const pending = pendingExecution ? snippets.find((snippet) => snippet.id === pendingExecution.snippetId) ?? null : null;
  const pendingNode = pendingExecution ? nodes.find((node) => node.nodeId === pendingExecution.nodeId) ?? null : null;
  const pendingAvailable = pending && pendingNode ? availableFor(pendingNode, pending) : false;
  const categories = ["全部", ...new Set(snippets.map((snippet) => snippet.category))];
  const filtered = snippets.filter((snippet) => {
    const query = search.trim().toLowerCase();
    return (!query || `${snippet.title} ${snippet.command} ${snippet.category} ${snippet.description}`.toLowerCase().includes(query))
      && (category === "全部" || snippet.category === category);
  });
  const onlineNodes = nodes.filter((node) => node.status === "online");
  const effectiveNodeId = targetNodeId || onlineNodes[0]?.nodeId || nodes[0]?.nodeId || "";
  const effectiveNode = nodes.find((node) => node.nodeId === effectiveNodeId) ?? null;
  const executionTask = executionTaskId ? tasks.find((task) => task.taskId === executionTaskId && task.targetNodeId === effectiveNodeId) ?? null : null;
  const nodeOptions = useMemo(() => nodes.map((node) => ({ value: node.nodeId, label: `${node.nodeName} · ${node.status === "online" ? "在线" : "离线"} · ${node.nodeId.slice(0, 8)}` })), [nodes]);
  const latestTask = executionTask ?? tasks.filter((task) => task.targetNodeId === effectiveNodeId && task.idempotencyKey.startsWith("terminal:")).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0] ?? null;
  const copy = (value: string) => void navigator.clipboard.writeText(value).then(() => notify("命令已复制", "info")).catch(() => notify("复制失败，请检查浏览器剪贴板权限", "danger"));
  const run = (snippet: TerminalSnippetRecord) => {
    if (!canExecute) { notify("当前账号没有常用命令执行权限", "danger"); return; }
    if (!effectiveNode) { notify("当前授权范围内没有 Agent 节点", "danger"); return; }
    if (!availableFor(effectiveNode, snippet)) { notify("目标 Agent 离线或未授权该受控能力", "danger"); return; }
    setSelectedId(null); setTargetNodeId(effectiveNode.nodeId);
    setPendingExecution({ snippetId: snippet.id, nodeId: effectiveNode.nodeId, idempotencyKey: createLocalId(`terminal-${snippet.id}`) }); setPassword("");
  };
  const confirmExecution = async () => {
    const currentPassword = passwordRef.current?.value ?? password;
    if (!pending || !pendingExecution) return;
    if (!pendingNode || !availableFor(pendingNode, pending)) { notify("目标 Agent 能力已变更，请重新选择命令", "danger"); return; }
    if (!currentPassword) { notify("请输入当前账号密码", "danger"); passwordRef.current?.focus(); return; }
    setExecuting(true);
    try {
      const proof = await reauthenticate(currentPassword);
      const result = await executeTerminalSnippet(pending.id, { nodeId: pendingNode.nodeId, snippetVersion: pending.version, idempotencyKey: pendingExecution.idempotencyKey }, proof.proof);
      acceptExecution(result.snippet, result.task); setExecutionTaskId(result.task.taskId); setPendingExecution(null); setPassword("");
      notify(`${pending.title} 已提交给 ${pendingNode.nodeName}`, "success");
    } catch (reason) { notify(reason instanceof Error ? reason.message : "受控命令提交失败", "danger"); }
    finally { setExecuting(false); }
  };
  const closeExecutionDialog = useCallback(() => { if (!executing) { setPendingExecution(null); setPassword(""); } }, [executing]);

  return <>
    <ModulePageShell title={resolvePageMeta("terminal-snippets").title} subtitle="收藏常用受控命令，在授权节点上确认后执行。" page="terminal-snippets" className="terminal-page terminal-snippets-live-page" viewContext={false} tabs={<TerminalTabs page="terminal-snippets" />} filters={<><ModuleSearch value={search} placeholder="搜索命令、分类或说明" onChange={setSearch} /><FieldSelect label="分类" value={category} options={categories} onChange={setCategory} /><FieldSelect label="目标 Agent" value={effectiveNodeId || "暂无 Agent"} options={nodeOptions} onChange={setTargetNodeId} /></>} metrics={<><MetricTile icon={TerminalSquare} label="受控片段" value={loading || error ? "—" : `${snippets.length}`} tone="blue" /><MetricTile icon={Server} label="在线 Agent" value={loading || error ? "—" : `${onlineNodes.length}`} tone={onlineNodes.length ? "green" : "gray"} /><MetricTile icon={Shield} label="可执行" value={loading || error ? "—" : `${snippets.filter((snippet) => canExecute && effectiveNode && availableFor(effectiveNode, snippet)).length}`} tone="green" /></>}>
      {loading && <span className="sr-only" role="status" aria-live="polite">正在从 /api/terminal/snippets 加载真实片段</span>}
      {error && <div className="overview-error-state terminal-snippets-error"><Shield size={18} /><span>{error}</span>{canRead && <button type="button" onClick={() => void retry()}>重试</button>}</div>}
      {!loading && !error && <p className="module-freshness-note"><Clock3 size={14} />后端更新于 {formatBackendDateTime(collectedAt)}</p>}
      <div className="terminal-snippets-live-layout"><section className="terminal-snippet-library" aria-label="受控命令片段">
        {filtered.map((snippet) => {
          const canRun = Boolean(canExecute && effectiveNode && snippet.executable && availableFor(effectiveNode, snippet));
          return <article key={snippet.id} className={snippet.favorite ? "favorite" : ""}><header><button className="terminal-snippet-title" type="button" onClick={() => setSelectedId(snippet.id)}><strong>{snippet.title}</strong><Eye size={16} /></button><span className={`pill terminal-snippet-risk ${snippet.risk === "danger" ? "red" : snippet.risk === "change" ? "orange" : "green"}`}>{snippet.risk === "read" ? <Shield size={13} /> : <AlertTriangle size={13} />}{riskLabel[snippet.risk]}</span></header><button className="terminal-snippet-command" type="button" aria-label={`查看 ${snippet.title} 详情`} onClick={() => setSelectedId(snippet.id)}><code>{snippet.command}</code></button><p>{snippet.description}</p><footer><span><b>{snippet.category}</b><time>{snippet.lastUsedAt ? formatBackendDateTime(snippet.lastUsedAt) : "尚未执行"}</time></span><div><button className={`icon-action${snippet.favorite ? " active" : ""}`} type="button" aria-label={`${snippet.favorite ? "取消收藏" : "收藏"} ${snippet.title}`} title={snippet.favorite ? "取消收藏" : "收藏"} onClick={() => void toggleFavorite(snippet).then((updated) => notify(`${updated.title} 已${updated.favorite ? "收藏" : "取消收藏"}`, "info")).catch((reason: unknown) => notify(reason instanceof Error ? reason.message : "收藏状态保存失败", "danger"))}><Star size={16} fill={snippet.favorite ? "currentColor" : "none"} /></button><button className="icon-action" type="button" aria-label={`复制 ${snippet.title}`} title="复制命令" onClick={() => copy(snippet.command)}><Copy size={16} /></button><button className="primary small" type="button" aria-label={`执行 ${snippet.title}`} disabled={!canRun} onClick={() => run(snippet)}><Play size={15} />{snippet.executable ? "执行" : "未接入"}</button></div></footer></article>;
        })}
        {!loading && filtered.length === 0 && <p className="module-empty-card">{error ? "真实片段加载失败，未显示示例数据" : "没有匹配的受控命令"}</p>}
      </section><aside className="terminal-live-task-panel" aria-live="polite"><header><Clock3 size={18} /><span><strong>最近任务</strong><small>{latestTask ? formatBackendDateTime(latestTask.updatedAt) : "等待首次执行"}</small></span></header>{latestTask ? <div className={`terminal-live-task-result ${taskTone(latestTask.status)}`}>{taskIcon(latestTask.status)}<span><strong>{taskStatusLabel[latestTask.status]}</strong><small>{effectiveNode?.nodeName ?? latestTask.targetNodeId}</small></span><code>{latestTask.taskId}</code><p>{latestTask.result?.message ?? latestTask.errorCode ?? "任务已保存，等待 Agent 返回结果"}</p>{latestTask.result?.data && <pre>{JSON.stringify(latestTask.result.data, null, 2)}</pre>}</div> : <p className="module-empty-card">选择在线 Agent 后执行受控片段，真实任务状态将在此处自动更新。</p>}</aside></div>
    </ModulePageShell>
    {selected && <DetailDrawer title={selected.title} subtitle={`${selected.category} · ${riskLabel[selected.risk]}`} className="terminal-snippet-drawer" modal onClose={() => setSelectedId(null)} actions={<><button className="ghost" type="button" onClick={() => copy(selected.command)}><Copy size={15} />复制命令</button><button className="primary" type="button" disabled={!canExecute || !effectiveNode || !selected.executable || !availableFor(effectiveNode, selected)} onClick={() => run(selected)}><Play size={15} />{selected.executable ? "执行受控任务" : "尚未接入"}</button></>}><div className="terminal-snippet-detail"><div className={`terminal-snippet-notice ${selected.risk === "danger" ? "danger" : selected.risk === "change" ? "warning" : "safe"}`}>{selected.risk === "read" ? <Shield size={20} /> : <AlertTriangle size={20} />}<span><strong>{selected.executable ? "受控 Agent 任务" : "仅供检查，禁止执行"}</strong><p>{selected.executable ? "Controller 将按片段 ID 映射结构化能力，浏览器不会提交任意 Shell。" : selected.description}</p></span></div><section><h2>命令展示</h2><code>{selected.command}</code></section><dl><div><dt>说明</dt><dd>{selected.description}</dd></div><div><dt>片段版本</dt><dd>{selected.version}</dd></div><div><dt>所需能力</dt><dd>{selected.requiredCapability ?? "未开放"}</dd></div><div><dt>目标 Agent</dt><dd>{effectiveNode?.nodeName ?? "暂无"}</dd></div><div><dt>最近使用</dt><dd>{formatBackendDateTime(selected.lastUsedAt, "尚未执行")}</dd></div></dl></div></DetailDrawer>}
    {pending && pendingExecution && <ConfirmDialog title="确认执行受控命令" message={pendingAvailable && pendingNode ? `将在 ${pendingNode.nodeName}（${pendingNode.nodeId.slice(0, 8)}）上执行 ${pending.title}。请输入当前账号密码完成一次性重新认证。` : `原目标 Agent（${pendingExecution.nodeId.slice(0, 8)}）已离线、不可用或能力已变更，无法执行 ${pending.title}。`} detail={pending.command} confirmLabel={executing ? "提交中" : "确认执行"} tone="warning" className="terminal-snippet-confirm" confirmDisabled={executing} onClose={closeExecutionDialog} onConfirm={() => void confirmExecution()}><label className="terminal-snippet-password"><span>当前账号密码</span><input ref={passwordRef} data-confirm-initial autoFocus type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} /></label></ConfirmDialog>}
  </>;
}

export { TerminalSnippetsWorkspace };
