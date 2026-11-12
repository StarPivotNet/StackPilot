import { ResourceNavigation } from "../../features/hosts/ResourceNavigation";
import { Clock3, FileBox, RefreshCw, Shield, Trash2 } from "lucide-react";
import { useCallback, useState } from "react";
import { emptyTrash, fetchTrash, purgeTrashFile, restoreTrashFile, type TrashFileEntry } from "../../api/filesApi";
import { reauthenticate } from "../../api/identityApi";
import { resolvePageMeta } from "../../app/navigation";
import { ModulePageShell } from "../../components/layout/ModulePageShell";
import { MetricTile, ModuleSearch } from "../../components/ui/Cards";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog";
import { DataTable, type TableColumn } from "../../components/ui/DataTable";
import { formatBytes } from "../../features/files/format";
import { usePollingResource } from "../../features/files/usePollingResource";
import type { Notify, PageKey } from "../../types/app";
import { formatBackendDateTime } from "../../utils/time";

export function FileTrashPage({ page, notify, canWrite, canDelete }: { page: PageKey; notify: Notify; canWrite: boolean; canDelete: boolean }) {
  const [search, setSearch] = useState(""); const [confirm, setConfirm] = useState<{ id?: string; name?: string } | null>(null); const [password, setPassword] = useState(""); const [busy, setBusy] = useState(false);
  const fetcher = useCallback((signal: AbortSignal) => fetchTrash(signal), []); const { data, loading, error, reload } = usePollingResource("trash", fetcher); const rows = data?.entries ?? []; const collectedAt = data?.collectedAt ?? "";
  const mutate = async (operation: () => Promise<{ message: string }>) => { setBusy(true); try { const result = await operation(); notify(result.message, "warning"); setConfirm(null); await reload(); } catch (reason) { notify(reason instanceof Error ? reason.message : "回收站操作失败", "danger"); } finally { setBusy(false); } };
  const confirmDelete = async () => { if (!confirm || !password) return; setBusy(true); try { const { proof } = await reauthenticate(password); const result = confirm.id ? await purgeTrashFile(confirm.id, proof) : await emptyTrash(proof); notify(result.message, "warning"); setConfirm(null); setPassword(""); await reload(); } catch (reason) { notify(reason instanceof Error ? reason.message : "永久删除失败", "danger"); } finally { setBusy(false); } };
  const visible = rows.filter((row) => !search.trim() || `${row.name} ${row.originalPath} ${row.owner}`.toLowerCase().includes(search.trim().toLowerCase())); const openConfirm = (value: { id?: string; name?: string }) => { setPassword(""); setConfirm(value); };
  const columns: TableColumn<TrashFileEntry>[] = [{ key: "name", label: "文件", width: "240px", render: (row) => <span className="trash-file-link"><FileBox size={15} /><b>{row.name}</b></span> }, { key: "path", label: "原路径", render: (row) => <code className="trash-path" title={row.originalPath}>{row.originalPath}</code> }, { key: "size", label: "大小", width: "90px", sortValue: (row) => row.sizeBytes, render: (row) => formatBytes(row.sizeBytes) }, { key: "deleted", label: "删除时间", width: "170px", render: (row) => formatBackendDateTime(row.deletedAt) }, { key: "expires", label: "到期时间", width: "170px", render: (row) => formatBackendDateTime(row.expiresAt) }];
  if (canWrite || canDelete) columns.push({ key: "ops", label: "操作", width: "184px", render: (row) => <span className="table-actions">{canWrite && <button type="button" onClick={() => void mutate(() => restoreTrashFile(row.id))}>恢复</button>}{canDelete && <button className="trash-destructive small" type="button" onClick={() => openConfirm({ id: row.id, name: row.name })}>永久删除</button>}</span> });
  return <><ModulePageShell className="resource-cloudpulse" title={resolvePageMeta(page).title} subtitle={loading ? "正在读取真实回收站" : "在保留期内恢复文件，永久删除需要重新验证身份。"} page={page} viewContext={false} tabs={<ResourceNavigation module="files" page={page} />} actions={canDelete && rows.length ? <button className="ghost" type="button" onClick={() => openConfirm({})}><Trash2 size={15} /> 清空回收站</button> : null} filters={<ModuleSearch value={search} placeholder="搜索文件名、原路径或所有者" onChange={setSearch} />} metrics={<><MetricTile icon={Trash2} label="待清理" value={data ? String(rows.length) : "等待采集"} tone="orange" /><MetricTile icon={RefreshCw} label="可恢复" value={data ? String(rows.length) : "等待采集"} tone="blue" /><MetricTile icon={Shield} label="保留周期" value="7 天" tone="green" /></>}>
    {error && <div className="overview-error-state"><Shield size={18} /><span>{error}</span><button type="button" onClick={() => void reload()}>重试</button></div>}
    {!loading && !error && <p className="module-freshness-note"><Clock3 size={14} />后端采集于 {formatBackendDateTime(collectedAt)}</p>}
    <DataTable columns={columns} rows={visible} emptyText={error ? "真实回收站加载失败" : loading ? "正在读取回收站" : "回收站为空"} getRowKey={(row) => row.id} />
  </ModulePageShell>{confirm && <ConfirmDialog title={confirm.id ? "永久删除文件" : "清空回收站"} message={confirm.id ? `将永久删除 ${confirm.name}，此操作无法撤销。` : `将永久删除回收站中的 ${rows.length} 个文件项，此操作无法撤销。`} confirmLabel={confirm.id ? "永久删除" : "确认清空"} busy={busy} confirmDisabled={!password} onClose={() => setConfirm(null)} onConfirm={() => void confirmDelete()}><label><span>当前密码</span><input aria-label="当前密码" type="password" autoComplete="current-password" value={password} disabled={busy} onChange={(event) => setPassword(event.target.value)} /></label></ConfirmDialog>}</>;
}
