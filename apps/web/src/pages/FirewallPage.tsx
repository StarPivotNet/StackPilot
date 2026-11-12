import type { CreateFirewallRuleRequest, DeleteFirewallRuleRequest, FirewallRule, Permission } from "@stackpilot/contracts";
import { CheckCircle2, Clock3, CloudOff, Lock, Plus, Shield } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createFirewallRule, deleteFirewallRule } from "../api/firewallApi";
import { reauthenticate } from "../api/identityApi";
import { resolvePageMeta } from "../app/navigation";
import { ModulePageShell } from "../components/layout/ModulePageShell";
import { MetricTile, ModuleSearch } from "../components/ui/Cards";
import { ConfirmDialog } from "../components/ui/ConfirmDialog";
import { DataTable } from "../components/ui/DataTable";
import { DetailDrawer } from "../components/ui/DetailDrawer";
import { FieldSelect, FormLine, FormSelectLine } from "../components/ui/FormControls";
import { FirewallOpenPortsPage } from "../features/firewall/FirewallOpenPortsPage";
import { SecurityModuleTabs } from "../components/layout/SecurityModuleTabs";
import { useFirewallRules } from "../features/firewall/useFirewallRules";
import { firewallPagePreset, isValidFirewallSource } from "../features/firewall/validation";
import type { Notify, PageKey } from "../types/app";
import { formatBackendDateTime } from "../utils/time";
import { FirewallDenyPage } from "./FirewallDenyPage";

type Drawer = { type: "create" } | { type: "detail" | "delete"; ruleId: string } | null;
type Props = { page: PageKey; notify: Notify; permissions?: Permission[] };

function FirewallRulesPage({ page, notify, permissions = [] }: Props) {
  const canRead = permissions.includes("firewall:read");
  const canOperate = permissions.includes("firewall:operate");
  const resource = useFirewallRules(canRead);
  const rows = useMemo(() => resource.data?.rules ?? [], [resource.data]);
  const preset = firewallPagePreset(page);
  const [searchByPage, setSearchByPage] = useState<Record<string, string>>({});
  const [protocolByPage, setProtocolByPage] = useState<Record<string, string>>({});
  const [sourceByPage, setSourceByPage] = useState<Record<string, string>>({});
  const [drawer, setDrawer] = useState<Drawer>(null);
  const [drawerTrigger, setDrawerTrigger] = useState<HTMLElement | null>(null);
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [createAttempt, setCreateAttempt] = useState<CreateFirewallRuleRequest | null>(null);
  const [deleteAttempt, setDeleteAttempt] = useState<{ ruleId: string; input: DeleteFirewallRuleRequest } | null>(null);
  const [draft, setDraft] = useState({ name: "临时调试端口", port: "", protocol: "TCP", source: "10.0.0.0/8" });
  const [draftErrors, setDraftErrors] = useState<{ port?: string; source?: string }>({});
  const idempotencyKeyRef = useRef(crypto.randomUUID());
  const portInputRef = useRef<HTMLInputElement>(null);
  const sourceInputRef = useRef<HTMLInputElement>(null);
  const search = searchByPage[page] ?? preset.search;
  const protocolFilter = protocolByPage[page] ?? preset.protocol;
  const sourceFilter = sourceByPage[page] ?? preset.source;
  const selectedRule = drawer && drawer.type !== "create" ? rows.find((row) => row.id === drawer.ruleId) ?? null : null;
  const canChange = canRead && canOperate && resource.data?.active === true;
  const createLocked = createAttempt !== null;

  const filteredRows = rows.filter((row) => {
    const query = search.trim().toLowerCase();
    const protocol = row.protocol?.toUpperCase() ?? "ANY";
    return (!query || `${row.name} ${row.port} ${row.source} ${resource.data?.host ?? ""}`.toLowerCase().includes(query))
      && (protocolFilter === "全部" || protocol === protocolFilter)
      && (sourceFilter === "全部" || row.source === sourceFilter);
  });

  useEffect(() => {
    if (drawer && drawer.type !== "create" && resource.data && !rows.some((row) => row.id === drawer.ruleId)) {
      queueMicrotask(() => setDrawer(null));
    }
  }, [drawer, resource.data, rows]);

  const open = (next: Exclude<Drawer, null>, trigger: HTMLElement) => {
    idempotencyKeyRef.current = crypto.randomUUID();
    setDrawerTrigger(trigger);
    setMutationError(null);
    setPassword("");
    setCreateAttempt(null);
    setDeleteAttempt(null);
    setDrawer(next);
  };
  const close = () => {
    if (submitting) return;
    setDrawer(null);
    setMutationError(null);
    setPassword("");
    setCreateAttempt(null);
    setDeleteAttempt(null);
  };
  const validate = () => {
    const port = Number(draft.port.trim());
    const source = draft.source.trim();
    const errors = {
      port: Number.isInteger(port) && port >= 1 && port <= 65_535 ? undefined : "端口必须是 1-65535 的整数",
      source: isValidFirewallSource(source) ? undefined : "来源需填写 IP 地址或 CIDR",
    };
    setDraftErrors(errors);
    return errors;
  };

  const submitCreate = async () => {
    const errors = validate();
    if (errors.port || errors.source) {
      notify("请修正防火墙规则表单", "danger");
      window.requestAnimationFrame(() => (errors.port ? portInputRef : sourceInputRef).current?.focus());
      return;
    }
    setSubmitting(true);
    setMutationError(null);
    try {
      const proof = (await reauthenticate(password)).proof;
      const request = createAttempt ?? {
        name: draft.name.trim() || `端口 ${draft.port}`,
        port: Number(draft.port),
        protocol: draft.protocol.toLowerCase() as "tcp" | "udp",
        source: draft.source.trim(),
        idempotencyKey: idempotencyKeyRef.current,
      };
      if (!createAttempt) setCreateAttempt(request);
      const result = await createFirewallRule(request, proof);
      resource.replaceData(result);
      notify(result.message, result.tone);
      setDrawer(null);
      setPassword("");
      setCreateAttempt(null);
    } catch (error) {
      setMutationError(error instanceof Error ? error.message : "防火墙规则创建失败");
    } finally {
      setSubmitting(false);
    }
  };

  const submitDelete = async (rule: FirewallRule) => {
    setSubmitting(true);
    setMutationError(null);
    try {
      const proof = (await reauthenticate(password)).proof;
      const request = deleteAttempt ?? { ruleId: rule.id, input: { version: rule.version, idempotencyKey: idempotencyKeyRef.current } };
      if (!deleteAttempt) setDeleteAttempt(request);
      const result = await deleteFirewallRule(request.ruleId, request.input, proof);
      resource.replaceData(result);
      notify(result.message, result.tone);
      setDrawer(null);
      setPassword("");
      setDeleteAttempt(null);
    } catch (error) {
      setMutationError(error instanceof Error ? error.message : "防火墙规则删除失败");
    } finally {
      setSubmitting(false);
    }
  };

  if (!canRead) {
    return <ModulePageShell title={resolvePageMeta(page).title} subtitle="当前账号没有防火墙读取权限" page={page} className="cloudpulse-security" viewContext={false}>
      <div className="overview-error-state"><Lock size={18} /><span>无权读取主机防火墙数据</span></div>
    </ModulePageShell>;
  }

  const warnings = [...(resource.backgroundError ? [`后台刷新失败，保留上次数据：${resource.backgroundError}`] : []), ...(resource.data?.warnings ?? [])];
  const visibleWarnings = warnings.length > 3 ? [...warnings.slice(0, 2), `另有 ${warnings.length - 2} 条防火墙提示`] : warnings;
  const sourceOptions = [...new Set(["全部", ...(sourceFilter !== "全部" ? [sourceFilter] : []), ...rows.map((row) => row.source)])];
  const protocolLabel = (rule: FirewallRule) => rule.protocol?.toUpperCase() ?? "ANY";

  return <ModulePageShell title={resolvePageMeta(page).title} subtitle={preset.subtitle} page={page} className="cloudpulse-security" viewContext={false} sideModal
    tabs={<SecurityModuleTabs module="firewall" page={page} />}
    actions={canOperate ? <button className="primary" type="button" disabled={!canChange} title={!canChange ? "UFW 未启用，规则变更已锁定" : undefined} onClick={(event) => { setDraftErrors({}); open({ type: "create" }, event.currentTarget); }}><Plus size={15} />新增规则</button> : null}
    filters={<><ModuleSearch value={search} placeholder="搜索规则、端口、来源或主机" onChange={(value) => setSearchByPage((current) => ({ ...current, [page]: value }))} /><FieldSelect label="协议" value={protocolFilter} options={["全部", "TCP", "UDP", "ANY"]} onChange={(value) => setProtocolByPage((current) => ({ ...current, [page]: value }))} /><FieldSelect label="来源" value={sourceFilter} options={sourceOptions} onChange={(value) => setSourceByPage((current) => ({ ...current, [page]: value }))} /></>}
    metrics={<><MetricTile icon={Shield} label="规则数" value={resource.data ? `${rows.length}` : "暂不可用"} tone="blue" /><MetricTile icon={CheckCircle2} label="受管规则" value={resource.data ? `${rows.filter((row) => row.managed).length}` : "暂不可用"} tone="green" /><MetricTile icon={Lock} label="UFW 状态" value={resource.data ? resource.data.active ? "已启用" : "未启用" : "不可用"} tone={resource.data?.active ? "green" : "orange"} /></>}
    side={drawer?.type === "create" ? <DetailDrawer className="firewall-rule-modal" modal restoreFocusTarget={drawerTrigger} title="新增放行规则" subtitle="规则将写入本机 UFW" closeLabel="关闭新增规则" onClose={close} actions={<><button className="ghost" type="button" disabled={submitting} onClick={close}>取消</button><button className="primary" type="button" disabled={!password || submitting || !canChange} onClick={() => void submitCreate()}>{submitting ? "提交中" : "保存规则"}</button></>}>
      <FormLine label="规则名" value={draft.name} disabled={submitting || createLocked} onChange={(value) => setDraft((current) => ({ ...current, name: value }))} />
      <FormLine label="端口" required value={draft.port} inputRef={portInputRef} error={draftErrors.port} inputType="number" disabled={submitting || createLocked} onChange={(value) => { setDraft((current) => ({ ...current, port: value })); setDraftErrors((current) => ({ ...current, port: undefined })); }} />
      <FormSelectLine label="协议" value={draft.protocol} options={["TCP", "UDP"]} disabled={submitting || createLocked} onChange={(value) => setDraft((current) => ({ ...current, protocol: value }))} />
      <FormLine label="来源" required value={draft.source} inputRef={sourceInputRef} error={draftErrors.source} disabled={submitting || createLocked} onChange={(value) => { setDraft((current) => ({ ...current, source: value })); setDraftErrors((current) => ({ ...current, source: undefined })); }} />
      <FormLine label="当前密码" required value={password} inputType="password" disabled={submitting} onChange={setPassword} />
      {mutationError && <p className="form-error" role="alert">{mutationError}</p>}
    </DetailDrawer> : drawer?.type === "detail" && selectedRule ? <DetailDrawer className="firewall-rule-drawer" modal restoreFocusTarget={drawerTrigger} title="规则详情" subtitle={`${selectedRule.port}/${protocolLabel(selectedRule)}`} closeLabel="关闭规则详情" onClose={close}>
      <div className="detail-kv"><p><span>规则名</span><b>{selectedRule.name}</b></p><p><span>来源</span><b>{selectedRule.source}</b></p><p><span>目标</span><b>{selectedRule.destination}</b></p><p><span>动作</span><b>{selectedRule.action.toUpperCase()} {selectedRule.direction.toUpperCase()}</b></p><p><span>归属</span><b>{selectedRule.managed ? "StackPilot 受管" : "外部规则（只读）"}</b></p></div>
    </DetailDrawer> : drawer?.type === "delete" && selectedRule ? <ConfirmDialog className="firewall-rule-delete-confirm" title="删除规则" message={`确定从 UFW 删除“${selectedRule.name}”吗？`} detail={`${selectedRule.source} -> ${selectedRule.destination} · ${selectedRule.port}/${protocolLabel(selectedRule)}`} confirmLabel="确认删除" busy={submitting} confirmDisabled={!password || !canChange} onConfirm={() => void submitDelete(selectedRule)} onClose={close} restoreFocusTarget={drawerTrigger}>
      <label className="cert-reauth-field"><span>当前密码</span><input autoFocus type="password" autoComplete="current-password" value={password} disabled={submitting} onChange={(event) => setPassword(event.target.value)} /></label>
      {mutationError && <p className="form-error" role="alert">{mutationError}</p>}
    </ConfirmDialog> : null}>
    {resource.loading && !resource.data && <span className="sr-only" role="status">正在读取真实 UFW 规则</span>}
    {resource.error && !resource.data && <div className="overview-error-state"><CloudOff size={18} /><span>{resource.error}</span><button type="button" onClick={() => void resource.retry()}>重试</button></div>}
    {resource.data && <div className="firewall-freshness"><Clock3 size={18} /><div><strong>{resource.data.host} · 采集时间 {formatBackendDateTime(resource.data.collectedAt)}</strong><span>数据来自本机 UFW 实际规则</span></div></div>}
    {visibleWarnings.map((warning) => <p className="database-collection-note" key={warning}><Clock3 size={15} />{warning}</p>)}
    <DataTable pageSize={100} columns={[
      { key: "name", label: "规则", width: "220px", render: (row) => <button className="module-row-link" type="button" aria-label={`查看防火墙规则 ${row.name}`} onClick={(event) => open({ type: "detail", ruleId: row.id }, event.currentTarget)}><b title={row.name}>{row.name}</b></button> },
      { key: "port", label: "端口", render: (row) => row.port },
      { key: "protocol", label: "协议", render: (row) => <span className="pill blue">{protocolLabel(row)}</span> },
      { key: "source", label: "来源", render: (row) => <code className="firewall-rule-value" title={row.source}>{row.source}</code> },
      { key: "target", label: "主机", render: () => <span className="firewall-rule-value" title={resource.data?.host}>{resource.data?.host ?? "-"}</span> },
      { key: "managed", label: "归属", render: (row) => <span className={`pill ${row.managed ? "green" : "blue"}`}>{row.managed ? "受管" : "外部"}</span> },
      { key: "ops", label: "操作", width: "130px", render: (row) => <span className="table-actions firewall-rule-actions"><button type="button" aria-label={`查看防火墙规则 ${row.name} 详情`} onClick={(event) => open({ type: "detail", ruleId: row.id }, event.currentTarget)}>详情</button>{canOperate && <button className="firewall-rule-delete" type="button" disabled={!row.managed || !canChange} title={!row.managed ? "外部规则只能查看" : undefined} aria-label={`删除防火墙规则 ${row.name}`} onClick={(event) => open({ type: "delete", ruleId: row.id }, event.currentTarget)}>删除</button>}</span> },
    ]} rows={filteredRows} emptyText={resource.data?.collectionStatus === "unavailable" ? "UFW 数据暂不可用" : resource.data && !resource.data.active ? "UFW 当前未启用，没有生效规则" : rows.length ? "没有匹配的防火墙规则" : "未发现 UFW 规则，系统将继续自动采集"} getRowKey={(row) => row.id}
      mobileCard={(row) => <><div className="module-card-head"><button className="module-row-link" type="button" aria-label={`查看防火墙规则 ${row.name}`} onClick={(event) => open({ type: "detail", ruleId: row.id }, event.currentTarget)}><Shield size={18} /><b>{row.name}</b></button><span className={`pill ${row.managed ? "green" : "blue"}`}>{row.managed ? "受管规则" : "外部规则"}</span></div><code className="module-card-code">{row.port}/{protocolLabel(row)}</code><div className="module-card-meta"><span><b>来源</b><em>{row.source}</em></span><span><b>目标</b><em>{row.destination}</em></span><span><b>主机</b><em>{resource.data?.host ?? "暂不可用"}</em></span><span><b>方向 / 动作</b><em>{row.direction.toUpperCase()} / {row.action.toUpperCase()}</em></span></div><div className="module-card-footer"><button className="ghost" type="button" onClick={(event) => open({ type: "detail", ruleId: row.id }, event.currentTarget)}>详情</button>{canOperate && <button className="ghost firewall-rule-delete" type="button" disabled={!row.managed || !canChange} aria-label={`删除防火墙规则 ${row.name}`} onClick={(event) => open({ type: "delete", ruleId: row.id }, event.currentTarget)}>删除</button>}</div></>}
    />
  </ModulePageShell>;
}

function FirewallPage(props: Props) {
  if (props.page === "firewall-deny" && !props.permissions?.includes("firewall:read")) return <FirewallRulesPage {...props} />;
  if (props.page === "firewall-open") return <FirewallOpenPortsPage permissions={props.permissions ?? []} />;
  if (props.page === "firewall-deny") return <FirewallDenyPage page={props.page} />;
  return <FirewallRulesPage {...props} />;
}

export { FirewallPage };
