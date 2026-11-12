import { createScheduleJob, deleteScheduleJob, fetchScheduleJobs, runScheduleJob, updateScheduleJob } from "../api/scheduleApi";
import type { ScheduleJob } from "../api/scheduleApi";
import { AlertTriangle, CalendarDays, CheckCircle2, CirclePause, Clock3, Plus, RotateCcw, Shield, TerminalSquare } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { resolvePageMeta } from "../app/navigation";
import { useQuickIntent } from "../app/routing";
import { ModulePageShell } from "../components/layout/ModulePageShell";
import { MetricTile, ModuleSearch } from "../components/ui/Cards";
import { DataTable } from "../components/ui/DataTable";
import { DetailDrawer } from "../components/ui/DetailDrawer";
import { FieldSelect, FormLine, ToggleLine } from "../components/ui/FormControls";
import { createScheduleDraft, describeCronExpression, isLikelyCronExpression, scheduleCronPresets, scheduleCrontabPreview, scheduleNextRunLabel, schedulePagePreset, sortScheduleCalendarRows } from "../features/schedule/model";
import type { ScheduleDraft } from "../features/schedule/model";
import { ScheduleMutationDialog, type ScheduleMutationConfirmation } from "../features/schedule/ScheduleMutationDialog";
import { reportApiError } from "../features/overview/model";
import { useAutoRefresh } from "../hooks/useAutoRefresh";
import type { Notify, PageKey } from "../types/app";
import { activateOnKeyboard } from "../utils/focus";
import { formatBackendDateTime } from "../utils/time";
import type { Permission } from "@stackpilot/contracts";

const defaultPermissions: Permission[] = ["schedules:read", "schedules:write"];

function ScheduleResultBadge({ result }: { result: string }) {
  const Icon = result === "成功" ? CheckCircle2 : result === "失败" ? AlertTriangle : result === "已停用" ? CirclePause : Clock3;
  const tone = result === "成功" ? "green" : result === "失败" ? "red" : "blue";
  return <span className={`pill schedule-result ${tone}`}><Icon size={14} />{result}</span>;
}

function SchedulePage({ page, notify, permissions = defaultPermissions }: { page: PageKey; notify: Notify; permissions?: Permission[] }) {
  const [rows, setRows] = useState<ScheduleJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [scannedAt, setScannedAt] = useState<string | undefined>();
  const [writeEnabled, setWriteEnabled] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  const schedulePreset = schedulePagePreset(page);
  const [searchByPage, setSearchByPage] = useState<Record<string, string>>({});
  const [stateByPage, setStateByPage] = useState<Record<string, string>>({});
  const [drawer, setDrawer] = useState<
    | { type: "create" }
    | { type: "edit"; job: ScheduleJob }
    | { type: "detail"; id: string }
    | null
  >(null);
  const [confirmation, setConfirmation] = useState<ScheduleMutationConfirmation | null>(null);
  const [draft, setDraft] = useState<ScheduleDraft>(() => createScheduleDraft());
  const [saving, setSaving] = useState(false);
  const cronInputRef = useRef<HTMLInputElement>(null);
  const hasWritePermission = permissions.includes("schedules:write");
  const canWrite = hasWritePermission && writeEnabled;
  const search = searchByPage[page] ?? schedulePreset.search;
  const stateFilter = stateByPage[page] ?? schedulePreset.state;
  const selectedJob = drawer?.type === "detail"
    ? rows.find((row) => row.id === drawer.id) ?? null
    : null;

  const openScheduleCreateFromQuick = useCallback(() => {
    if (!hasWritePermission) return;
    setDraft(createScheduleDraft());
    setDrawer({ type: "create" });
  }, [hasWritePermission]);

  useQuickIntent("schedule-enabled", "create-schedule", openScheduleCreateFromQuick);
  const loadSchedules = useCallback(async (signal: AbortSignal, silent: boolean) => {
    try {
      const payload = await fetchScheduleJobs(signal);
      if (signal.aborted) return;
      setRows(payload.jobs);
      setScannedAt(payload.scannedAt);
      setWriteEnabled(payload.writeEnabled);
      setLoadError(null);
      setDrawer((current) => {
        if ((current?.type === "create" || current?.type === "edit") && (!hasWritePermission || !payload.writeEnabled)) return null;
        if (current?.type === "detail" && !payload.jobs.some((row) => row.id === current.id)) return null;
        return current;
      });
    } catch (error) {
      if (signal.aborted) return;
      if (!silent) {
        const message = error instanceof Error ? error.message : "定时任务后端加载失败";
        setLoadError(message);
        reportApiError(error, notify, "定时任务后端加载失败");
      }
    } finally {
      if (!silent && !signal.aborted) setLoading(false);
    }
  }, [hasWritePermission, notify]);

  useEffect(() => {
    const controller = new AbortController();
    void Promise.resolve().then(() => loadSchedules(controller.signal, false));
    return () => controller.abort();
  }, [loadSchedules, retryKey]);

  useAutoRefresh(
    (signal) => loadSchedules(signal, true),
    10_000,
    !loading && !loadError,
  );

  const filteredRows = rows.filter((row) => {
    const query = search.trim().toLowerCase();
    const matchSearch = !query || `${row.name} ${row.cron} ${row.command}`.toLowerCase().includes(query);
    const matchState = stateFilter === "全部" || (stateFilter === "已启用" ? row.enabled : !row.enabled);
    const matchFailed = page === "schedule-failed" ? row.lastExecution?.status === "失败" : true;
    return matchSearch && matchState && matchFailed;
  });
  const calendarRows = sortScheduleCalendarRows(filteredRows);
  const selectedVisibleJob = selectedJob;
  const applySchedulePayload = (jobs: ScheduleJob[], selectedId?: string) => {
    setRows(jobs);
    setDrawer((current) => {
      if (!current || current.type === "create" || current.type === "edit") return current;
      return jobs.some((row) => row.id === current.id) ? current : null;
    });
    if (selectedId) setDrawer({ type: "detail", id: selectedId });
  };

  const requestSaveJob = () => {
    if (saving || !canWrite) return;
    const currentDrawer = drawer;
    const nextName = draft.name.trim();
    const nextCron = draft.cron.trim();
    const nextCommand = draft.command.trim();
    if (!nextName || !nextCron || !nextCommand) {
      notify("任务名、cron 和命令不能为空", "danger");
      return;
    }
    if (!isLikelyCronExpression(nextCron)) {
      notify("cron 需要是 5 段表达式，例如 0 4 * * *", "danger");
      return;
    }
    if (!currentDrawer || (currentDrawer.type !== "create" && currentDrawer.type !== "edit")) return;
    const editingId = currentDrawer.type === "edit" ? currentDrawer.job.id : null;
    const idempotencyKey = `schedule-create:${crypto.randomUUID()}`;
    setConfirmation({
      title: editingId ? "确认保存定时任务" : "确认创建定时任务",
      message: "该操作会修改 Controller 服务账号的真实 crontab。",
      detail: `${nextCron} · ${nextCommand}`,
      confirmLabel: editingId ? "确认保存" : "确认创建",
      execute: async (proof) => {
        setSaving(true);
        try {
          const payload = editingId
            ? await updateScheduleJob(editingId, { name: nextName, cron: nextCron, command: nextCommand, enabled: draft.enabled }, proof)
            : await createScheduleJob({ name: nextName, cron: nextCron, command: nextCommand, enabled: draft.enabled }, proof, idempotencyKey);
          applySchedulePayload(payload.jobs, payload.job.id);
          notify(payload.message, payload.tone ?? "success");
          setDrawer({ type: "detail", id: payload.job.id });
        } finally { setSaving(false); }
      },
    });
  };
  const requestDeleteJob = (row: ScheduleJob) => {
    if (!canWrite) return;
    setConfirmation({
      title: "删除定时任务",
      message: "删除后会从 StackPilot 托管的真实 crontab 中移除。",
      detail: `${row.cron} · ${row.command}`,
      confirmLabel: "确认删除",
      tone: "danger",
      execute: async (proof) => {
        const payload = await deleteScheduleJob(row.id, proof);
        setRows(payload.jobs);
        setDrawer(null);
        notify(payload.message, payload.tone ?? "warning");
      },
    });
  };
  const requestRunJob = (row: ScheduleJob) => {
    if (!canWrite) return;
    const idempotencyKey = `schedule-run:${crypto.randomUUID()}`;
    setConfirmation({
      title: "确认立即执行",
      message: "Controller 将立即执行该任务命令，不等待下一次 cron 调度。",
      detail: row.command,
      confirmLabel: "确认执行",
      execute: async (proof) => {
        const payload = await runScheduleJob(row.id, proof, idempotencyKey);
        applySchedulePayload(payload.jobs, row.id);
        notify(payload.message, payload.tone ?? "success");
      },
    });
  };
  const requestToggleJob = (row: ScheduleJob) => {
    if (!canWrite) return;
    const nextEnabled = !row.enabled;
    setConfirmation({
      title: nextEnabled ? "确认启用定时任务" : "确认停用定时任务",
      message: nextEnabled ? "启用后任务会按 cron 周期自动执行。" : "停用后会从可执行 crontab 行中移除，但保留任务配置。",
      detail: `${row.cron} · ${row.command}`,
      confirmLabel: nextEnabled ? "确认启用" : "确认停用",
      execute: async (proof) => {
        const payload = await updateScheduleJob(row.id, { enabled: nextEnabled }, proof);
        applySchedulePayload(payload.jobs, row.id);
        notify(payload.message, payload.tone ?? "success");
      },
    });
  };
  const editJob = (row: ScheduleJob) => {
    setDraft({ name: row.name, cron: row.cron, command: row.command, enabled: row.enabled });
    setDrawer({ type: "edit", job: row });
  };
  const scheduleActionButtons = (row: ScheduleJob) => (
    <>
      {canWrite && <button type="button" onClick={() => requestToggleJob(row)}>{row.enabled ? "停用" : "启用"}</button>}
      {canWrite && <button type="button" disabled={!row.enabled} onClick={() => requestRunJob(row)}>执行</button>}
      <button type="button" onClick={() => setDrawer({ type: "detail", id: row.id })}>详情</button>
      {canWrite && <button type="button" onClick={() => editJob(row)}>编辑</button>}
      {canWrite && <button type="button" onClick={() => requestDeleteJob(row)}>删除</button>}
    </>
  );
  const editingJobId = drawer?.type === "edit" ? drawer.job.id : undefined;
  const cronDescription = describeCronExpression(draft.cron);
  const cronHasError = draft.cron.trim().length > 0 && !isLikelyCronExpression(draft.cron);
  const crontabPreview = scheduleCrontabPreview(draft, editingJobId);
  const activeCronPreset = scheduleCronPresets.find((preset) => preset.cron === draft.cron.trim())?.cron ?? "custom";
  const scheduleDialog = drawer?.type === "create" || drawer?.type === "edit" ? (
    <DetailDrawer
      title={drawer.type === "edit" ? "编辑计划任务" : "新建计划任务"}
      subtitle={drawer.type === "edit" ? drawer.job.name : "当前用户 crontab"}
      onClose={() => { if (!saving) setDrawer(null); }}
      className="schedule-job-modal"
      modal
      actions={<><button className="ghost" type="button" disabled={saving} onClick={() => setDrawer(null)}>取消</button><button className="primary" type="button" disabled={saving} onClick={requestSaveJob}>{saving ? "保存中..." : "保存任务"}</button></>}
    >
      <div className="schedule-modal-form">
        <div className="schedule-modal-source">
          <TerminalSquare size={17} />
          <div>
            <strong>当前用户 crontab</strong>
            <span>StackPilot 托管块</span>
          </div>
          <b>{draft.enabled ? "启用" : "停用"}</b>
        </div>
        <FormLine label="任务名" required value={draft.name} disabled={saving} onChange={(value) => setDraft((current) => ({ ...current, name: value }))} />
        <section className="schedule-form-section" aria-label="执行周期">
          <div className="schedule-form-section-head">
            <span>执行周期</span>
            <em>{cronDescription}</em>
          </div>
          <div className="schedule-cron-presets">
            {scheduleCronPresets.map((preset) => (
              <button
                key={preset.cron}
                className={`schedule-preset-button ${activeCronPreset === preset.cron ? "active" : ""}`}
                type="button"
                disabled={saving}
                aria-pressed={activeCronPreset === preset.cron}
                onClick={() => setDraft((current) => ({ ...current, cron: preset.cron }))}
              >
                {preset.label}
              </button>
            ))}
            <button
              className={`schedule-preset-button ${activeCronPreset === "custom" ? "active" : ""}`}
              type="button"
              disabled={saving}
              aria-pressed={activeCronPreset === "custom"}
              onClick={() => cronInputRef.current?.focus()}
            >
              自定义
            </button>
          </div>
          <FormLine
            label="cron 表达式"
            required
            value={draft.cron}
            error={cronHasError ? "需要 5 段表达式" : undefined}
            inputRef={cronInputRef}
            disabled={saving}
            onChange={(value) => setDraft((current) => ({ ...current, cron: value }))}
          />
        </section>
        <FormLine label="命令" required value={draft.command} disabled={saving} onChange={(value) => setDraft((current) => ({ ...current, command: value }))} />
        <ToggleLine
          label="保存后启用任务"
          hint={draft.enabled ? "保存后写入可执行 crontab 行" : "仅保存任务配置，不写入执行行"}
          active={draft.enabled}
          disabled={saving}
          onToggle={(active) => setDraft((current) => ({ ...current, enabled: active }))}
        />
        <div className="schedule-command-preview">
          <div>
            <span>写入预览</span>
            <em>{draft.enabled ? "保存后生效" : "停用状态"}</em>
          </div>
          <code>{crontabPreview}</code>
        </div>
        <p className="schedule-managed-note">仅写入 StackPilot 托管块，保留当前用户 crontab 的其他行。</p>
      </div>
    </DetailDrawer>
  ) : drawer?.type === "detail" && selectedVisibleJob ? (
    <DetailDrawer title="任务详情" subtitle={selectedVisibleJob.name} onClose={() => setDrawer(null)} className="schedule-job-drawer" modal actions={canWrite ? <><button className="ghost" type="button" onClick={() => editJob(selectedVisibleJob)}>编辑</button><button className="primary" type="button" disabled={!selectedVisibleJob.enabled} onClick={() => requestRunJob(selectedVisibleJob)}>立即执行</button></> : undefined}>
      <div className="detail-kv">
        <p><span>cron</span><b>{selectedVisibleJob.cron}</b></p>
        <p><span>命令</span><b>{selectedVisibleJob.command}</b></p>
        <p><span>状态</span><b>{selectedVisibleJob.enabled ? "启用" : "停用"}</b></p>
        <p><span>下次执行</span><b>{scheduleNextRunLabel(selectedVisibleJob)}</b></p>
        <p><span>最近执行</span><b>{selectedVisibleJob.lastRun}</b></p>
        <p><span>结果</span><b>{selectedVisibleJob.result}</b></p>
        <p><span>执行来源</span><b>{selectedVisibleJob.lastExecution?.source === "cron" ? "cron 自动调度" : selectedVisibleJob.lastExecution?.source === "manual" ? "StackPilot 手动执行" : "尚无执行记录"}</b></p>
        <p><span>退出码</span><b>{selectedVisibleJob.lastExecution?.exitCode ?? "不可用"}</b></p>
        <p><span>耗时</span><b>{selectedVisibleJob.lastExecution ? `${selectedVisibleJob.lastExecution.durationMs}ms` : "不可用"}</b></p>
      </div>
      <div className="terminal-log compact-log">
        <p>$ {selectedVisibleJob.command}</p>
        <pre>{selectedVisibleJob.lastExecution?.output || "无标准输出"}</pre>
        <pre>{selectedVisibleJob.lastExecution?.error || "无错误输出"}</pre>
      </div>
    </DetailDrawer>
  ) : null;

  const freshness = scannedAt ? `最近采集：${formatBackendDateTime(scannedAt)}` : loading ? "正在读取当前用户 crontab。" : "采集时间不可用";

  return (
    <ModulePageShell
      title={resolvePageMeta(page).title}
      subtitle={schedulePreset.subtitle}
      page={page}
      className="schedule-page"
      viewContext={false}
      tabs={<nav className="module-tabs" aria-label="定时任务视图">{([["schedule", "全部任务"], ["schedule-enabled", "已启用"], ["schedule-failed", "失败任务"], ["schedule-calendar", "执行日历"]] as const).map(([route, label]) => <a key={route} href={`#${route}`} className={page === route ? "active" : undefined} aria-current={page === route ? "page" : undefined}>{label}</a>)}</nav>}
      actions={page === "schedule-failed" || !canWrite ? undefined : <button className="primary" type="button" onClick={openScheduleCreateFromQuick}><Plus size={15} /> 新建任务</button>}
      filters={<><ModuleSearch value={search} placeholder="搜索任务、cron 或命令" onChange={(value) => setSearchByPage((current) => ({ ...current, [page]: value }))} /><FieldSelect label="状态" value={stateFilter} options={["全部", "已启用", "已停用"]} onChange={(value) => setStateByPage((current) => ({ ...current, [page]: value }))} /></>}
      metrics={<><MetricTile icon={CalendarDays} label={page === "schedule-failed" ? "失败任务" : "任务数"} value={loading || loadError ? "—" : `${page === "schedule-failed" ? filteredRows.length : rows.length}`} tone="blue" /><MetricTile icon={CheckCircle2} label="启用" value={loading || loadError ? "—" : `${rows.filter((row) => row.enabled).length}`} tone="green" /><MetricTile icon={Shield} label="失败" value={loading || loadError ? "—" : `${rows.filter((row) => row.lastExecution?.status === "失败").length}`} tone="red" /><MetricTile icon={TerminalSquare} label="来源" value="cron" tone="orange" /></>}
    >
      <p className="module-freshness-note"><Clock3 size={15} />{freshness}</p>
      {scheduleDialog}
      {confirmation && <ScheduleMutationDialog confirmation={confirmation} onClose={() => setConfirmation(null)} />}
      {loadError && (
        <section className="schedule-load-error" role="alert">
          <AlertTriangle size={18} />
          <div>
            <strong>定时任务采集失败</strong>
            <p>{loadError}</p>
          </div>
          <button className="ghost" type="button" onClick={() => { setLoading(true); setLoadError(null); setRetryKey((current) => current + 1); }}>
            <RotateCcw size={14} /> 重试
          </button>
        </section>
      )}
      {!loading && !loadError && !canWrite && (
        <section className="schedule-load-error" role="status">
          <Shield size={18} />
          <div>
            <strong>当前为只读模式</strong>
            <p>{hasWritePermission ? "服务器未开启 crontab 写入与立即执行能力。" : "当前账号没有修改定时任务的权限。"}</p>
          </div>
        </section>
      )}
      {schedulePreset.mode === "calendar" && (
        <div className={`schedule-calendar ${calendarRows.length === 0 ? "is-empty" : ""}`}>
          {calendarRows.map((row) => <article key={row.id} role="button" tabIndex={0} onClick={() => setDrawer({ type: "detail", id: row.id })} onKeyDown={(event) => activateOnKeyboard(event, () => setDrawer({ type: "detail", id: row.id }))}><span>{scheduleNextRunLabel(row)}</span><strong>{row.name}</strong><em>{row.cron}</em><ScheduleResultBadge result={row.enabled ? row.result : "已停用"} /></article>)}
          {filteredRows.length === 0 && <p className="module-empty-card">当前筛选没有日历任务</p>}
        </div>
      )}
      <DataTable
        columns={[
          { key: "name", label: "任务", width: "132px", render: (row) => <button className="module-row-link" title={row.name} type="button" onClick={() => setDrawer({ type: "detail", id: row.id })}><CalendarDays size={15} /><b>{row.name}</b></button> },
          { key: "cron", label: "cron", width: "70px", render: (row) => <code title={row.cron}>{row.cron}</code> },
          { key: "command", label: "命令", width: "120px", render: (row) => <code className="schedule-command" title={row.command}>{row.command}</code> },
          { key: "enabled", label: "启用", width: "66px", render: (row) => <span className={`pill schedule-result ${row.enabled ? "green" : "blue"}`}>{row.enabled ? <CheckCircle2 size={14} /> : <CirclePause size={14} />}{row.enabled ? "启用" : "停用"}</span> },
          { key: "last", label: "最近执行", width: "90px", render: (row) => formatBackendDateTime(row.lastExecution?.startedAt, row.lastRun) },
          { key: "result", label: "结果", width: "62px", render: (row) => <ScheduleResultBadge result={row.result} /> },
          { key: "ops", label: "操作", width: "230px", render: (row) => <span className="table-actions">{scheduleActionButtons(row)}</span> },
        ]}
        rows={filteredRows}
        emptyText={loading ? "正在读取定时任务" : "没有匹配的定时任务"}
        getRowKey={(row) => row.id}
        mobileCard={(row) => (
          <>
            <div className="module-card-head">
              <button className="module-row-link" type="button" onClick={() => setDrawer({ type: "detail", id: row.id })}><CalendarDays size={15} /><b>{row.name}</b></button>
              <ScheduleResultBadge result={row.result} />
            </div>
            <code className="module-card-code">{row.cron} · {row.command}</code>
            <div className="module-card-meta">
              <span><b>状态</b><em>{row.enabled ? "启用" : "停用"}</em></span>
              <span><b>最近</b><em>{row.lastRun}</em></span>
              <span><b>下次</b><em>{scheduleNextRunLabel(row)}</em></span>
              <span><b>结果</b><em>{row.result}</em></span>
            </div>
            <div className="module-card-footer">
              <div className="table-actions actions-5">
                {scheduleActionButtons(row)}
              </div>
            </div>
          </>
        )}
      />
      <section className="schedule-source-note" aria-label="真实来源">
        <TerminalSquare size={18} />
        <div>
          <strong>真实来源：当前用户 crontab</strong>
          <span>仅管理 StackPilot 标记块，保留当前用户 crontab 的其他行。</span>
        </div>
      </section>
    </ModulePageShell>
  );
}

export { SchedulePage };
