import { ResourceNavigation } from "../../features/hosts/ResourceNavigation";
import { ChevronRight, Clock3, FileBox, Folder, Pencil, Plus, Shield, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { createDirectory, renameFile, trashFile } from "../../api/filesApi";
import { resolvePageMeta } from "../../app/navigation";
import { ModulePageShell } from "../../components/layout/ModulePageShell";
import { ModuleSearch } from "../../components/ui/Cards";
import { DataTable, type TableColumn } from "../../components/ui/DataTable";
import { DetailDrawer } from "../../components/ui/DetailDrawer";
import { FieldSelect, FormLine } from "../../components/ui/FormControls";
import { entryToView, joinVirtualPath } from "../../features/files/format";
import { fileSizeSortValue, filesPagePreset } from "../../features/files/model";
import { useFileBrowser } from "../../features/files/useFileBrowser";
import type { Notify, PageKey } from "../../types/app";
import type { FileRecord } from "../../features/files/types";
import { formatBackendDateTime } from "../../utils/time";

export function FilesPage({ page, notify, canWrite }: { page: PageKey; notify: Notify; canWrite: boolean }) {
  const preset = filesPagePreset(page); const [path, setPath] = useState("/"); const [search, setSearch] = useState(""); const [type, setType] = useState("全部"); const [draft, setDraft] = useState(""); const [busy, setBusy] = useState(false);
  const [drawer, setDrawer] = useState<{ type: "folder" | "rename" | "delete"; id?: string } | null>(null); const { entries, loading, error, collectedAt, reload } = useFileBrowser(path);
  const selected = drawer?.id ? entries.find((entry) => entry.id === drawer.id) ?? null : null; const crumbs = path.split("/").filter(Boolean); const parent = crumbs.length > 1 ? `/${crumbs.slice(0, -1).join("/")}` : "/";
  useEffect(() => { if (!drawer?.id || loading || error || selected) return; let active = true; queueMicrotask(() => { if (active) setDrawer(null); }); return () => { active = false; }; }, [drawer, error, loading, selected]);
  const rows = useMemo(() => entries.map(entryToView).filter((row) => (type === "全部" || row.type === type) && (!search.trim() || row.name.toLowerCase().includes(search.trim().toLowerCase()))), [entries, search, type]);
  const mutate = async (operation: () => Promise<{ message: string }>) => { setBusy(true); try { const result = await operation(); notify(result.message); setDrawer(null); await reload(); } catch (reason) { notify(reason instanceof Error ? reason.message : "文件操作失败", "danger"); } finally { setBusy(false); } };
  const openNameDrawer = (drawerType: "folder" | "rename", id?: string) => { const entry = id ? entries.find((item) => item.id === id) : null; setDraft(entry?.name ?? "new-folder"); setDrawer({ type: drawerType, id }); };
  const actions = canWrite ? <button className="primary" type="button" onClick={() => openNameDrawer("folder")}><Plus size={15} /> 创建文件夹</button> : null;
  const columns: TableColumn<FileRecord>[] = [
    { key: "name", label: "名称", width: "260px", render: (row) => row.type === "文件夹" ? <button className="file-link file-name" type="button" title={row.name} onClick={() => setPath(joinVirtualPath(path, row.name))}><Folder size={15} /><b>{row.name}</b></button> : <span className="file-name" title={row.name}><FileBox size={15} /><b>{row.name}</b></span> },
    { key: "type", label: "类型", width: "86px", render: (row) => <span className="pill blue">{row.type}</span> }, { key: "size", label: "大小", sortValue: fileSizeSortValue, render: (row) => row.size }, { key: "modified", label: "修改时间", render: (row) => row.modified }, { key: "owner", label: "所有者", render: (row) => row.owner },
  ];
  if (canWrite) columns.push({ key: "ops", label: "操作", width: "170px", control: true, render: (row) => <span className="table-actions file-row-actions"><button type="button" aria-label={`重命名 ${row.name}`} onClick={() => openNameDrawer("rename", row.id)}><Pencil size={14} /> 重命名</button><button type="button" aria-label={`删除 ${row.name} 到回收站`} onClick={() => setDrawer({ type: "delete", id: row.id })}><Trash2 size={14} /> 删除</button></span> });
  return <ModulePageShell className="resource-cloudpulse" title={resolvePageMeta(page).title} subtitle={loading ? "正在读取真实文件目录" : preset.subtitle} page={page} viewContext={false} tabs={<ResourceNavigation module="files" page={page} />} actions={actions} filters={<><ModuleSearch value={search} placeholder="搜索文件名" onChange={setSearch} /><FieldSelect label="类型" value={type} options={["全部", "文件夹", "文件"]} onChange={setType} /></>} side={drawer ? <FileEditorDrawer drawer={drawer.type} name={selected?.name ?? draft} draft={draft} busy={busy} onDraft={setDraft} onClose={() => setDrawer(null)} onSubmit={() => void mutate(() => drawer.type === "folder" ? createDirectory(path, draft) : drawer.type === "rename" && selected ? renameFile(selected.path, draft) : selected ? trashFile(selected.path) : Promise.reject(new Error("文件项已不存在")))} /> : null} sideModal={Boolean(drawer)}>
    {loading && <span className="sr-only" role="status">正在从 /api/files 读取文件目录</span>}
    {error && <div className="overview-error-state"><Shield size={18} /><span>{error}</span><button type="button" onClick={() => void reload()}>重试</button></div>}
    {!loading && !error && <p className="module-freshness-note"><Clock3 size={14} />后端采集于 {formatBackendDateTime(collectedAt)}</p>}
    <div className="file-breadcrumbs"><button className="file-parent-button" type="button" disabled={path === "/"} onClick={() => setPath(parent)}>上级</button><span><ChevronRight size={14} /></span><button type="button" className={path === "/" ? "active" : ""} onClick={() => setPath("/")}>root</button>{crumbs.map((crumb, index) => { const next = `/${crumbs.slice(0, index + 1).join("/")}`; return <span className="file-breadcrumb-item" key={next}><ChevronRight size={14} /><button type="button" className={next === path ? "active" : ""} onClick={() => setPath(next)}>{crumb}</button></span>; })}</div>
    <DataTable columns={columns} rows={rows} emptyText={error ? "真实目录加载失败" : loading ? "正在读取文件目录" : "当前目录没有匹配文件"} getRowKey={(row) => row.id} />
  </ModulePageShell>;
}

function FileEditorDrawer({ drawer, name, draft, busy, onDraft, onClose, onSubmit }: { drawer: "folder" | "rename" | "delete"; name: string; draft: string; busy: boolean; onDraft: (value: string) => void; onClose: () => void; onSubmit: () => void }) {
  const deleting = drawer === "delete"; const title = deleting ? "移入回收站" : drawer === "folder" ? "创建文件夹" : "重命名";
  return <DetailDrawer title={title} subtitle={name} className={deleting ? "file-delete-dialog" : "file-editor-drawer"} modal onClose={onClose} actions={<><button className="ghost" type="button" disabled={busy} onClick={onClose}>取消</button><button className={deleting ? "files-destructive" : "primary"} type="button" disabled={busy || (!deleting && !draft.trim())} onClick={onSubmit}>{deleting && <Trash2 size={15} />}{busy ? "处理中" : deleting ? "确认移入" : drawer === "folder" ? "创建" : "保存"}</button></>}>
    {deleting ? <div className="file-delete-summary"><Trash2 size={20} /><div><strong>确认移动这个文件项？</strong><p>项目将保留在回收站 7 天，期间仍可恢复。</p></div></div> : <FormLine label={drawer === "folder" ? "文件夹名" : "新名称"} required value={draft} disabled={busy} onChange={onDraft} />}
  </DetailDrawer>;
}
