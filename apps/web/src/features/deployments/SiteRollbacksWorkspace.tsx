import type { Permission } from "@stackpilot/contracts";
import { Activity, CheckCircle2, Clock3, RotateCcw, ShieldAlert } from "lucide-react";
import { useMemo, useState } from "react";
import { createSiteRollback } from "../../api/deploymentsApi";
import type { SiteRollbackRecord } from "../../api/deploymentsApi";
import type { SiteOperation } from "../../api/sitesApi";
import { reauthenticate } from "../../api/identityApi";
import { resolvePageMeta } from "../../app/navigation";
import { ModulePageShell } from "../../components/layout/ModulePageShell";
import { MetricTile } from "../../components/ui/Cards";
import type { Notify } from "../../types/app";
import { formatBackendDateTime } from "../../utils/time";
import { RollbackConfirmDialog } from "./RollbackConfirmDialog";
import { RollbackDetailDrawer } from "./RollbackDetailDrawer";
import { matchesRollbackFilter } from "./rollbackModel";
import { RollbackTable } from "./RollbackTable";
import { useSiteRollbacks } from "./useSiteRollbacks";
import { DeploymentTabs } from "./DeploymentTabs";

const filters = ["全部", "可回滚", "执行中", "成功", "失败"];
type PendingRollback = { row: SiteRollbackRecord; idempotencyKey: string };

function SiteRollbacksWorkspace({ notify, permissions }: { notify: Notify; permissions: Permission[] }) {
  const canRead = permissions.includes("sites:read");
  const canExecute = permissions.includes("sites:deploy");
  const { rows, collectedAt, loading, error, refresh } = useSiteRollbacks(canRead);
  const [filter, setFilter] = useState("全部");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingRollback | null>(null);
  const [reason, setReason] = useState("");
  const [password, setPassword] = useState("");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [operationByTarget, setOperationByTarget] = useState<Record<string, SiteOperation>>({});
  const selected = rows.find((row) => row.id === selectedId) ?? null;
  const filteredRows = useMemo(() => rows.filter((row) => matchesRollbackFilter(row, filter)), [filter, rows]);
  const activeCount = rows.filter((row) => row.status === "queued" || row.status === "running").length;
  const succeededCount = rows.filter((row) => row.status === "succeeded").length;

  const prepare = (row: SiteRollbackRecord) => {
    if (!canExecute || busyId || row.status !== "available") return;
    setPending({ row, idempotencyKey: crypto.randomUUID() });
    setReason("");
    setPassword("");
    setSubmitError(null);
  };

  const execute = async () => {
    if (!pending || busyId || !reason.trim() || !password) return;
    const target = pending.row;
    setBusyId(target.id);
    setSubmitError(null);
    try {
      const proof = await reauthenticate(password);
      const operation = await createSiteRollback(target.siteId, {
        targetReleaseId: target.targetReleaseId,
        expectedSiteVersion: target.siteVersion,
        reason: reason.trim(),
        idempotencyKey: pending.idempotencyKey,
      }, proof.proof);
      setOperationByTarget((current) => ({ ...current, [target.targetReleaseId]: operation }));
      setPending(null);
      setPassword("");
      notify(`${target.domain} 回滚任务已提交`, "success");
      await refresh(undefined, true);
    } catch (cause) {
      setSubmitError(cause instanceof Error ? cause.message : "回滚任务提交失败");
    } finally {
      setBusyId(null);
    }
  };

  if (!canRead) {
    return <ModulePageShell title={resolvePageMeta("deploy-rollbacks").title} page="deploy-rollbacks" viewContext={false} tabs={<DeploymentTabs page="deploy-rollbacks" />}>
      <div className="overview-error-state" role="alert"><ShieldAlert size={18} /><span>当前账号没有站点读取权限</span></div>
    </ModulePageShell>;
  }

  const emptyText = error
    ? "真实回滚记录加载失败，不显示演示数据"
    : loading
      ? "正在加载真实回滚记录"
      : "暂无匹配的回滚记录，系统将继续自动采集";

  return <>
    <ModulePageShell
      title={resolvePageMeta("deploy-rollbacks").title}
      subtitle="查看受管站点的历史版本、回滚资格及实际执行状态。"
      page="deploy-rollbacks"
      viewContext={false}
      tabs={<DeploymentTabs page="deploy-rollbacks" />}
      filters={<nav className="deploy-tabs" aria-label="回滚状态筛选">{filters.map((item) => <button key={item} className={filter === item ? "active" : ""} aria-pressed={filter === item} type="button" onClick={() => setFilter(item)}>{item}</button>)}</nav>}
      metrics={<><MetricTile icon={RotateCcw} label="可回滚" value={`${rows.filter((row) => row.status === "available").length}`} tone="blue" /><MetricTile icon={Activity} label="执行中" value={`${activeCount}`} tone="orange" /><MetricTile icon={CheckCircle2} label="已回滚" value={`${succeededCount}`} tone="green" /></>}
    >
      <p className="module-freshness-note"><Clock3 size={15} />{loading ? "正在加载受管站点历史 Release" : `采集于 ${formatBackendDateTime(collectedAt)}`}</p>
      {loading && <span className="sr-only" role="status" aria-live="polite">正在从 /api/site-rollbacks 加载真实回滚记录</span>}
      {error && <div className="overview-error-state rollback-error-state" role="alert"><ShieldAlert size={18} /><span>{error}</span><button type="button" disabled={loading} onClick={() => void refresh()}>重试</button></div>}
      <RollbackTable rows={filteredRows} emptyText={emptyText} canExecute={canExecute} busyId={busyId} onOpen={setSelectedId} onExecute={prepare} />
      {selected && <RollbackDetailDrawer row={selected} operationStage={operationByTarget[selected.targetReleaseId]?.stage} canExecute={canExecute} busy={Boolean(busyId)} onClose={() => setSelectedId(null)} onExecute={prepare} />}
    </ModulePageShell>
    {pending && <RollbackConfirmDialog row={pending.row} reason={reason} password={password} busy={busyId === pending.row.id} error={submitError} onReasonChange={setReason} onPasswordChange={setPassword} onConfirm={() => void execute()} onClose={() => { if (busyId) return; setPending(null); setSubmitError(null); }} />}
  </>;
}

export { SiteRollbacksWorkspace };
