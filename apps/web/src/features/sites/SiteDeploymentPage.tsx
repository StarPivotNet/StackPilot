import { SiteNavigation } from "./SiteNavigation";
import { CheckCircle2, GitBranch, Plus, Server, ShieldCheck, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { listAgentNodes } from "../../api/agentApi";
import { activateSitePlan, createSitePlan } from "../../api/sitesApi";
import type { SitePlan } from "../../api/sitesApi";
import { reauthenticate } from "../../api/identityApi";
import { resolvePageMeta } from "../../app/navigation";
import { ModulePageShell } from "../../components/layout/ModulePageShell";
import { FormLine, FormSelectLine } from "../../components/ui/FormControls";
import type { Notify } from "../../types/app";
import { formatBackendDateTime } from "../../utils/time";
import { SiteOperationStatus } from "./SiteOperationStatus";
import { useSiteOperation } from "./useSiteOperation";

type EnvironmentVariable = { id: string; name: string; value: string };
type Draft = {
  nodeId: string;
  domains: string;
  repositoryUrl: string;
  repositoryRef: string;
  deploymentEnvironment: "staging" | "production";
  certificateEmail: string;
  certificateEnvironment: "staging" | "production";
  environmentVariables: EnvironmentVariable[];
  password: string;
};

const initialDraft: Draft = {
  nodeId: "",
  domains: "",
  repositoryUrl: "",
  repositoryRef: "main",
  deploymentEnvironment: "production",
  certificateEmail: "",
  certificateEnvironment: "staging",
  environmentVariables: [],
  password: "",
};
const terminal = new Set(["succeeded", "failed", "cancelled"]);

function SiteDeploymentPage({ notify, canListNodes }: { notify: Notify; canListNodes: boolean }) {
  const [nodes, setNodes] = useState<Array<{ nodeId: string; nodeName: string }>>([]);
  const [draft, setDraft] = useState(initialDraft);
  const [plan, setPlan] = useState<SitePlan | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const prepareKey = useRef(crypto.randomUUID());
  const activationKey = useRef(crypto.randomUUID());
  const { operation, error: operationError, watch, clear } = useSiteOperation();
  const currentPlan = useMemo(() => operation?.status === "succeeded" && operation.result?.planPreview && operation.operationId === plan?.operationId
    ? { ...plan, status: "ready" as const, preview: operation.result.planPreview }
    : operation?.type === "activate" && operation.status === "succeeded" && operation.planId === plan?.planId
      ? { ...plan, status: "activated" as const }
    : plan, [operation, plan]);
  const nodeOptions = useMemo(() => nodes.map((node) => `${node.nodeName} · ${node.nodeId}`), [nodes]);
  const operationActive = Boolean(operation && !terminal.has(operation.status));

  useEffect(() => {
    if (!canListNodes) return;
    const controller = new AbortController();
    listAgentNodes(controller.signal).then((payload) => {
      const allowed = payload.nodes.filter((node) => node.allowedCapabilities.includes("sites.deploy") && node.declaredCapabilities.includes("sites.deploy"));
      setNodes(allowed);
      setDraft((current) => current.nodeId || !allowed[0] ? current : { ...current, nodeId: allowed[0].nodeId });
    }).catch((reason: unknown) => {
      if (!controller.signal.aborted) setFormError(reason instanceof Error ? reason.message : "节点列表加载失败");
    });
    return () => controller.abort();
  }, [canListNodes]);

  const updateEnvironment = (id: string, field: "name" | "value", value: string) => {
    setDraft((current) => ({
      ...current,
      environmentVariables: current.environmentVariables.map((entry) => entry.id === id ? { ...entry, [field]: value } : entry),
    }));
  };

  const submitPlan = async (event: React.FormEvent) => {
    event.preventDefault();
    if (submitting || plan) return;
    setSubmitting(true); setFormError(null);
    try {
      const proof = await reauthenticate(draft.password);
      const created = await createSitePlan({
        nodeId: draft.nodeId,
        domains: draft.domains.split(",").map((value) => value.trim()).filter(Boolean),
        repositoryUrl: draft.repositoryUrl,
        repositoryRef: draft.repositoryRef,
        deploymentEnvironment: draft.deploymentEnvironment,
        certificateEmail: draft.certificateEmail,
        certificateEnvironment: draft.certificateEnvironment,
        environmentVariables: draft.environmentVariables.map(({ name, value }) => ({ name: name.trim(), value })),
        idempotencyKey: prepareKey.current,
      }, proof.proof);
      setPlan(created); setDraft((current) => ({ ...current, password: "" }));
      watch({ operationId: created.operationId, taskId: null, type: "prepare", nodeId: created.nodeId, siteId: null, planId: created.planId, rollback: null, status: "queued", stage: "awaiting_executor", progressPercent: 0, result: null, errorCode: null, createdAt: created.createdAt, updatedAt: created.updatedAt });
    } catch (reason) {
      setFormError(reason instanceof Error ? reason.message : "部署计划创建失败");
    } finally { setSubmitting(false); }
  };

  const activate = async () => {
    if (!currentPlan || submitting || operationActive) return;
    setSubmitting(true); setFormError(null);
    try {
      const proof = await reauthenticate(draft.password);
      const nextOperation = await activateSitePlan(currentPlan.planId, {
        planVersion: currentPlan.version,
        planDigest: currentPlan.digest,
        idempotencyKey: activationKey.current,
      }, proof.proof);
      watch(nextOperation); setDraft((current) => ({ ...current, password: "" }));
      notify("部署计划已进入激活队列", "info");
    } catch (reason) {
      setFormError(reason instanceof Error ? reason.message : "部署激活失败");
    } finally { setSubmitting(false); }
  };

  const reset = () => {
    if (operationActive) return;
    const nodeId = draft.nodeId;
    setPlan(null); clear(); setDraft({ ...initialDraft, nodeId }); setFormError(null);
    prepareKey.current = crypto.randomUUID(); activationKey.current = crypto.randomUUID();
  };

  return <ModulePageShell className="resource-cloudpulse" title={resolvePageMeta("sites-create").title} subtitle="生产先预检再确认上线；预发仅构建和预检，不切换生产流量。" page="sites-create" viewContext={false} tabs={<SiteNavigation page="sites-create" canDeploy />}>
    <div className="site-deployment-layout">
      <form className="site-deployment-form" onSubmit={(event) => void submitPlan(event)}>
        <header><GitBranch size={18} /><span><strong>Git 部署计划</strong><small>仅接受公开 github.com HTTPS 仓库</small></span></header>
        {canListNodes
          ? <FormSelectLine label="目标节点" required value={nodeOptions.find((option) => option.endsWith(draft.nodeId)) ?? "暂无已授权节点"} options={nodeOptions} disabled={!nodeOptions.length || submitting || Boolean(plan)} onChange={(value) => setDraft((current) => ({ ...current, nodeId: value.split(" · ").at(-1) ?? "" }))} />
          : <FormLine label="目标节点 ID" required value={draft.nodeId} disabled={submitting || Boolean(plan)} onChange={(value) => setDraft((current) => ({ ...current, nodeId: value }))} />}
        <FormLine label="域名" required value={draft.domains} disabled={submitting || Boolean(plan)} hint="多个普通域名使用英文逗号分隔，不支持通配符" onChange={(value) => setDraft((current) => ({ ...current, domains: value }))} />
        <FormLine label="仓库地址" required value={draft.repositoryUrl} disabled={submitting || Boolean(plan)} inputType="url" onChange={(value) => setDraft((current) => ({ ...current, repositoryUrl: value }))} />
        <FormLine label="Git ref" required value={draft.repositoryRef} disabled={submitting || Boolean(plan)} onChange={(value) => setDraft((current) => ({ ...current, repositoryRef: value }))} />
        <FormSelectLine label="发布环境" required value={draft.deploymentEnvironment === "production" ? "生产" : "预发"} options={["生产", "预发"]} disabled={submitting || Boolean(plan)} onChange={(value) => setDraft((current) => ({ ...current, deploymentEnvironment: value === "预发" ? "staging" : "production" }))} />
        <FormLine label="证书邮箱" required value={draft.certificateEmail} disabled={submitting || Boolean(plan)} inputType="email" onChange={(value) => setDraft((current) => ({ ...current, certificateEmail: value }))} />
        <FormSelectLine label="ACME 环境" required value={draft.certificateEnvironment === "staging" ? "Staging" : "Production"} options={["Staging", "Production"]} disabled={submitting || Boolean(plan)} onChange={(value) => setDraft((current) => ({ ...current, certificateEnvironment: value === "Production" ? "production" : "staging" }))} />
        <EnvironmentEditor entries={draft.environmentVariables} disabled={submitting || Boolean(plan)} onAdd={() => setDraft((current) => ({ ...current, environmentVariables: [...current.environmentVariables, { id: crypto.randomUUID(), name: "", value: "" }] }))} onRemove={(id) => setDraft((current) => ({ ...current, environmentVariables: current.environmentVariables.filter((entry) => entry.id !== id) }))} onChange={updateEnvironment} />
        <FormLine label="当前密码" required value={draft.password} disabled={submitting || operationActive} inputType="password" onChange={(value) => setDraft((current) => ({ ...current, password: value }))} />
        {formError && <p className="form-error" role="alert">{formError}</p>}
        <footer>{!plan
          ? <button className="primary" type="submit" disabled={submitting || !draft.nodeId || !draft.domains || !draft.repositoryUrl || !draft.certificateEmail || !draft.password}>{submitting ? "提交中..." : "创建并预检"}</button>
          : operationActive ? <small role="status">任务仍在后端执行，完成后可继续操作</small>
            : <button className="ghost" type="button" onClick={reset}>重新填写</button>}</footer>
      </form>
      <PlanSummary plan={currentPlan} operation={operation} operationError={operationError} password={draft.password} submitting={submitting} operationActive={operationActive} onActivate={() => void activate()} />
    </div>
  </ModulePageShell>;
}

function EnvironmentEditor({ entries, disabled, onAdd, onRemove, onChange }: { entries: EnvironmentVariable[]; disabled: boolean; onAdd: () => void; onRemove: (id: string) => void; onChange: (id: string, field: "name" | "value", value: string) => void }) {
  return <fieldset className="site-environment-editor" disabled={disabled}>
    <legend><span>环境变量</span><small>值仅用于本次部署，不在摘要中回显</small></legend>
    {entries.map((entry, index) => <div className="site-environment-row" key={entry.id}>
      <label><span>变量名 {index + 1}</span><input required aria-label={`环境变量 ${index + 1} 名称`} value={entry.name} pattern="[A-Z_][A-Z0-9_]*" maxLength={128} autoComplete="off" onChange={(event) => onChange(entry.id, "name", event.target.value.toUpperCase())} /></label>
      <label><span>变量值 {index + 1}</span><input required aria-label={`环境变量 ${index + 1} 值`} value={entry.value} maxLength={8192} autoComplete="off" onChange={(event) => onChange(entry.id, "value", event.target.value)} /></label>
      <button className="ghost icon-only" type="button" aria-label={`删除环境变量 ${index + 1}`} title="删除环境变量" onClick={() => onRemove(entry.id)}><Trash2 size={16} /></button>
    </div>)}
    <button className="ghost small" type="button" disabled={disabled || entries.length >= 100} onClick={onAdd}><Plus size={15} /> 添加环境变量</button>
  </fieldset>;
}

function PlanSummary({ plan, operation, operationError, password, submitting, operationActive, onActivate }: { plan: SitePlan | null; operation: ReturnType<typeof useSiteOperation>["operation"]; operationError: string | null; password: string; submitting: boolean; operationActive: boolean; onActivate: () => void }) {
  return <section className="site-plan-summary" aria-label="部署计划摘要">
    <header><ShieldCheck size={18} /><span><strong>变更摘要</strong><small>只有后端预检成功后才能激活</small></span></header>
    {!plan && <div className="site-plan-empty"><Server size={24} /><span>等待创建部署计划</span></div>}
    {plan && <>
      <dl>
        <div><dt>状态</dt><dd>{planStatusLabel(plan.status)}</dd></div>
        <div><dt>域名</dt><dd>{plan.domains.join("、")}</dd></div>
        <div><dt>仓库 / ref</dt><dd>{plan.repositoryUrl} · {plan.repositoryRef}</dd></div>
        <div><dt>发布环境</dt><dd>{plan.deploymentEnvironment === "production" ? "生产" : "预发"}</dd></div>
        <div><dt>目标节点</dt><dd>{plan.nodeId}</dd></div>
        <div><dt>计划到期</dt><dd>{formatBackendDateTime(plan.expiresAt)}</dd></div>
        <div><dt>运行时</dt><dd>{plan.preview?.runtime ?? "正在识别"}</dd></div>
        <div><dt>健康检查</dt><dd>{plan.preview?.healthCheckPath ?? "暂未生成"}</dd></div>
        <div><dt>环境变量</dt><dd>{plan.environmentVariableNames.length ? plan.environmentVariableNames.join("、") : "无"}</dd></div>
      </dl>
      {plan.preview && <div className="site-plan-changes">{plan.preview.changes.map((change) => <span key={change}><CheckCircle2 size={14} />{change}</span>)}</div>}
      {operation && <SiteOperationStatus operation={operation} error={operationError} />}
      {plan.status === "ready" && plan.deploymentEnvironment === "production" && <button className="primary" type="button" disabled={!password || submitting || operationActive} onClick={onActivate}>{submitting ? "激活中..." : "确认摘要并上线"}</button>}
      {plan.status === "ready" && plan.deploymentEnvironment === "staging" && <p className="site-plan-staging-note" role="status">预发构建与预检已完成，不会切换生产流量。</p>}
    </>}
  </section>;
}

function planStatusLabel(status: SitePlan["status"]) {
  return { queued: "等待预检", preparing: "正在预检", ready: "可以激活", activating: "正在上线", activated: "已上线", failed: "失败", expired: "已过期" }[status];
}

export { SiteDeploymentPage };
