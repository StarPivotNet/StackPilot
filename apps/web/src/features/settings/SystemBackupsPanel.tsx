import { ArchiveRestore, CircleAlert, Database, Download, ShieldCheck } from "lucide-react";
import { useState } from "react";
import type { Permission, SystemBackupRecord } from "@stackpilot/contracts";
import { createSystemBackup, drillSystemBackup, fetchSystemBackups, verifySystemBackup } from "../../api/databaseBackupsApi";
import { reauthenticate } from "../../api/identityApi";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog";
import { DataTable } from "../../components/ui/DataTable";
import { DetailDrawer } from "../../components/ui/DetailDrawer";
import { usePollingResource } from "../../hooks/usePollingResource";
import type { Notify } from "../../types/app";
import { formatBackendDateTime } from "../../utils/time";

type Pending = { kind: "create" } | { kind: "verify" | "drill"; backup: SystemBackupRecord };

function SystemBackupsPanel({
  notify,
  permissions,
  readOnly,
}: {
  notify: Notify;
  permissions: Permission[];
  readOnly: boolean;
}) {
  const allowed = permissions.includes("system:backup");
  const { data, loading, error, retry, refresh } = usePollingResource(fetchSystemBackups, null, allowed);
  const [pending, setPending] = useState<Pending | null>(null);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  if (!allowed) {
    return (
      <section className="backup-page-state" role="status">
        <ShieldCheck size={22} />
        <strong>系统备份不可用</strong>
        <p>当前角色没有 system:backup 权限。</p>
      </section>
    );
  }

  const selected = data?.backups.find((row) => row.id === selectedId) ?? null;
  const submit = async () => {
    if (!pending || !password || readOnly || busy) return;
    setBusy(true);
    setMutationError(null);
    try {
      const proof = (await reauthenticate(password)).proof;
      const result = pending.kind === "create"
        ? await createSystemBackup({ idempotencyKey: `system-backup:${crypto.randomUUID()}` }, proof)
        : pending.kind === "verify"
          ? await verifySystemBackup(pending.backup.id, proof)
          : await drillSystemBackup(pending.backup.id, proof);
      notify(result.message, result.tone);
      setPending(null);
      setPassword("");
      await refresh();
    } catch (caught) {
      setMutationError(caught instanceof Error ? caught.message : "系统备份操作失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <section className="system-backups-panel">
        <header>
          <div>
            <span className="settings-section-overline">CONTROLLER DATA</span>
            <h2>Controller SQLite 系统备份</h2>
            <p>控制面数据与 PostgreSQL / MySQL 业务实例备份分开管理。</p>
          </div>
          <button className="primary" type="button" disabled={readOnly || loading} onClick={() => setPending({ kind: "create" })}>
            <Download size={15} />创建系统备份
          </button>
        </header>

        {loading && !data && <p className="settings-loading-state" role="status">正在读取系统备份...</p>}
        {error && !data && (
          <div className="overview-error-state">
            <CircleAlert size={18} />
            <span>{error}</span>
            <button type="button" onClick={() => void retry()}>重试</button>
          </div>
        )}
        {data && (
          <>
            <div className="system-backup-summary">
              <p><span>数据库</span><b>{data.source.name}</b></p>
              <p><span>引擎 / Schema</span><b>{data.source.engine} / {data.source.schemaVersion}</b></p>
              <p><span>当前大小</span><b>{formatBytes(data.source.sizeBytes)}</b></p>
              <p><span>采集时间</span><b>{formatBackendDateTime(data.collectedAt)}</b></p>
            </div>
            <DataTable
              columns={[
                { key: "file", label: "文件", render: (row) => <button className="module-row-link settings-backup-file" type="button" title={row.fileName} onClick={() => setSelectedId(row.id)}>{row.fileName}</button> },
                { key: "created", label: "创建时间", width: "170px", render: (row) => formatBackendDateTime(row.createdAt) },
                { key: "size", label: "大小", width: "110px", render: (row) => formatBytes(row.sizeBytes) },
                { key: "checksum", label: "完整性", width: "110px", render: (row) => <span className={`pill ${row.checksumStatus === "verified" ? "green" : "orange"}`}>{row.checksumStatus === "verified" ? "已校验" : "待校验"}</span> },
                { key: "drill", label: "恢复演练", width: "120px", render: (row) => <span className={`pill ${row.drillStatus === "succeeded" ? "green" : "orange"}`}>{row.drillStatus === "succeeded" ? "已通过" : "尚未演练"}</span> },
              ]}
              rows={data.backups}
              getRowKey={(row) => row.id}
              emptyText="尚无 Controller SQLite 系统备份"
              mobileCard={(row) => (
                <>
                  <div className="module-card-head">
                    <button className="module-row-link settings-backup-file" type="button" title={row.fileName} onClick={() => setSelectedId(row.id)}>
                      <Database size={16} /><b>{row.fileName}</b>
                    </button>
                    <span className={`pill ${row.checksumStatus === "verified" ? "green" : "orange"}`}>{row.checksumStatus === "verified" ? "已校验" : "待校验"}</span>
                  </div>
                  <div className="module-card-meta">
                    <span><b>创建时间</b><em>{formatBackendDateTime(row.createdAt)}</em></span>
                    <span><b>大小</b><em>{formatBytes(row.sizeBytes)}</em></span>
                    <span><b>恢复演练</b><em>{row.drillStatus === "succeeded" ? "已通过" : "尚未演练"}</em></span>
                    <span><b>存储</b><em>{row.storage}</em></span>
                  </div>
                  <div className="module-card-footer">
                    <div className="table-actions actions-1"><button type="button" onClick={() => setSelectedId(row.id)}>查看详情</button></div>
                  </div>
                </>
              )}
            />
          </>
        )}
      </section>

      {selected && (
        <DetailDrawer
          title="系统备份详情"
          subtitle={selected.fileName}
          className="settings-detail-drawer"
          modal
          onClose={() => setSelectedId(null)}
          actions={!readOnly ? (
            <>
              <button className="ghost" type="button" onClick={() => setPending({ kind: "verify", backup: selected })}><ShieldCheck size={14} />校验</button>
              <button className="primary" type="button" onClick={() => setPending({ kind: "drill", backup: selected })}><ArchiveRestore size={14} />隔离演练</button>
            </>
          ) : undefined}
        >
          <div className="backup-drawer-body">
            <Database size={20} />
            <dl>
              <div><dt>存储</dt><dd>{selected.storage}</dd></div>
              <div><dt>大小</dt><dd>{formatBytes(selected.sizeBytes)}</dd></div>
              <div><dt>创建时间</dt><dd>{formatBackendDateTime(selected.createdAt)}</dd></div>
              <div><dt>完整性</dt><dd>{selected.checksumStatus === "verified" ? "已校验" : "待校验"}</dd></div>
              <div><dt>恢复演练</dt><dd>{selected.drillStatus === "succeeded" ? "已通过" : "尚未演练"}</dd></div>
            </dl>
          </div>
        </DetailDrawer>
      )}

      {pending && (
        <ConfirmDialog
          title={pending.kind === "create" ? "创建 Controller 系统备份" : pending.kind === "verify" ? "校验系统备份" : "执行隔离恢复演练"}
          message="该操作仅作用于 Controller SQLite 系统备份，不影响业务数据库实例。"
          confirmLabel="确认执行"
          tone="warning"
          busy={busy}
          confirmDisabled={!password || readOnly}
          onClose={() => { setPending(null); setPassword(""); setMutationError(null); }}
          onConfirm={() => void submit()}
        >
          <label className="settings-reauth-field">
            <span>当前密码</span>
            <input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} />
          </label>
          {mutationError && <p className="form-error" role="alert">{mutationError}</p>}
        </ConfirmDialog>
      )}
    </>
  );
}

function formatBytes(value: number) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let amount = value;
  let index = 0;
  while (amount >= 1024 && index < units.length - 1) {
    amount /= 1024;
    index += 1;
  }
  return `${amount.toFixed(index < 2 ? 0 : 1)} ${units[index]}`;
}

export { SystemBackupsPanel };
