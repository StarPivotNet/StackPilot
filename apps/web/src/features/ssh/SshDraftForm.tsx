import { useId, useRef, useState } from "react";
import type { FormEvent } from "react";
import type { Notify } from "../../types/app";
import { validateSshDraft, type SshDraft, type SshDraftErrors, type SshDraftKind } from "./model";
import { SshAction, SshNote, SshPanel } from "./SshPrimitives";
import type { SshWorkspace } from "./useSshWorkspace";

const draftCopy: Record<SshDraftKind, { title: string; description: string }> = {
  takeover: { title: "接管范围草稿", description: "仅准备字段，不执行连接、主机预检或配置变更。" },
  issue: { title: "签发范围草稿", description: "平台签发服务未启用，填写草稿不会生成密钥或证书。" },
  policy: { title: "授权策略草稿", description: "填写希望授权的范围，不会保存或授予任何真实权限。" },
  rescue: { title: "救援申请草稿", description: "绑定单主机、单账号与操作者，救援有效期上限为 15 分钟。" },
};

export function SshDraftForm({ kind, workspace, notify, reviewRoute }: { kind: SshDraftKind; workspace: SshWorkspace; notify: Notify; reviewRoute?: string }) {
  const prefix = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const draft = workspace.draftFor(kind);
  const [errors, setErrors] = useState<SshDraftErrors>({});
  const [checkedSignature, setCheckedSignature] = useState<string | null>(null);
  const signature = JSON.stringify(draft);
  const update = <K extends keyof SshDraft>(key: K, value: SshDraft[K]) => {
    workspace.updateDraft(kind, { ...draft, [key]: value });
    setErrors((current) => ({ ...current, [key]: undefined }));
  };
  const chooseHost = (id: string) => {
    workspace.selectHost(id);
    workspace.updateDraft(kind, { ...draft, hostId: id, account: "", operator: "", purpose: "" });
    setErrors({});
    setCheckedSignature(null);
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const nextErrors = validateSshDraft(draft, workspace.hosts, kind);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length) {
      window.requestAnimationFrame(() => formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());
      return;
    }
    setCheckedSignature(signature);
    if (reviewRoute) workspace.navigate(reviewRoute, draft.hostId);
  };
  const hintId = (key: keyof SshDraft) => `${prefix}-${key}-hint`;
  const errorId = (key: keyof SshDraft) => `${prefix}-${key}-error`;
  const fieldError = (key: keyof SshDraft) => errors[key] ? <span className="ssh-field-error" id={errorId(key)} role="alert">{errors[key]}</span> : null;
  const describedBy = (key: keyof SshDraft) => `${hintId(key)}${errors[key] ? ` ${errorId(key)}` : ""}`;
  const action = kind === "policy" ? "保存授权策略" : kind === "rescue" ? "申请平台救援凭据" : kind === "issue" ? "签发短期凭据" : "开始主机预检";
  return <SshPanel title={draftCopy[kind].title} description={draftCopy[kind].description}>
    <form ref={formRef} className="ssh-draft-form" onSubmit={submit} noValidate>
      <div className="ssh-form-fields">
        <label className="ssh-field"><span>目标主机</span><select aria-label="目标主机" value={draft.hostId} onChange={(event) => chooseHost(event.target.value)} aria-invalid={Boolean(errors.hostId)} aria-describedby={describedBy("hostId")}><option value="">{workspace.hosts.length ? "请选择实际资源主机" : "等待资源目录"}</option>{draft.hostId && !workspace.hosts.some((host) => host.id === draft.hostId) && <option value={draft.hostId}>原目标已不在资源目录</option>}{workspace.hosts.map((host) => <option key={host.id} value={host.id} disabled={host.platform !== "linux"}>{host.name} · {host.address ?? "地址未提供"}{host.platform !== "linux" ? "（当前草稿仅支持 Linux）" : ""}</option>)}</select><small id={hintId("hostId")}>选择资源不代表 SSH 已可达或已授权。目标以稳定主机 ID 绑定。</small>{fieldError("hostId")}</label>
        <label className="ssh-field"><span>Linux 账号</span><input aria-label="Linux 账号" value={draft.account} onChange={(event) => update("account", event.target.value)} placeholder="例如 deploy" autoComplete="off" maxLength={32} aria-invalid={Boolean(errors.account)} aria-describedby={describedBy("account")} /><small id={hintId("account")}>必须由目标主机的真实授权策略允许；不会默认授权 root。</small>{fieldError("account")}</label>
        <label className="ssh-field"><span>操作者或用户组</span><input aria-label="操作者或用户组" value={draft.operator} onChange={(event) => update("operator", event.target.value)} placeholder="填写待授权的身份" autoComplete="off" maxLength={160} aria-invalid={Boolean(errors.operator)} aria-describedby={describedBy("operator")} /><small id={hintId("operator")}>这里是授权草稿，不替代平台身份验证或审批。</small>{fieldError("operator")}</label>
        <label className="ssh-field"><span>{kind === "policy" ? "计划有效期上限" : "计划有效期"}</span><select aria-label={kind === "policy" ? "计划有效期上限" : "计划有效期"} value={draft.minutes} onChange={(event) => update("minutes", Number(event.target.value))} disabled={kind === "rescue"} aria-invalid={Boolean(errors.minutes)} aria-describedby={describedBy("minutes")} >{(kind === "rescue" ? [15] : [15, 60, 240, 480]).map((minutes) => <option key={minutes} value={minutes}>{minutes < 60 ? `${minutes} 分钟` : `${minutes / 60} 小时`}</option>)}</select><small id={hintId("minutes")}>{kind === "rescue" ? "救援为单主机、单账号、单操作者的短期授权。" : "实际有效起止时间和允许上限由后端策略与审批决定。"}</small>{fieldError("minutes")}</label>
        {kind === "rescue" && <label className="ssh-field ssh-field-full"><span>事故编号</span><input aria-label="事故编号" value={draft.incident} onChange={(event) => update("incident", event.target.value)} placeholder="填写真实事故编号" maxLength={120} aria-invalid={Boolean(errors.incident)} aria-describedby={describedBy("incident")} /><small id={hintId("incident")}>用于关联救援审批、签发和恢复审计。</small>{fieldError("incident")}</label>}
        <label className="ssh-field ssh-field-full"><span>用途说明</span><textarea aria-label="用途说明" value={draft.purpose} onChange={(event) => update("purpose", event.target.value)} placeholder="说明本次访问或接管的用途" maxLength={1000} aria-invalid={Boolean(errors.purpose)} aria-describedby={describedBy("purpose")} /><small id={hintId("purpose")}>草稿只保留在当前页面内存，不填写私钥或登录口令。</small>{fieldError("purpose")}</label>
      </div>
      {checkedSignature === signature && !reviewRoute && <SshNote title="草稿字段已填写，尚未发出请求">这不是主机预检、授权或签发成功。SSH 托管服务接入并提供真实证据前，操作仍保持禁用。</SshNote>}
      <div className="ssh-form-actions"><span>本页草稿 · 尚未保存到服务器</span><div className="ssh-toolbar"><button className="ssh-button ssh-button-ghost" type="button" onClick={() => { workspace.resetDraft(kind); setErrors({}); setCheckedSignature(null); notify("已清空本页草稿", "info"); }}>清空草稿</button><button className="ssh-button ssh-button-ghost" type="submit">{reviewRoute ? "预览变更草稿" : "检查草稿格式"}</button><SshAction>{action}</SshAction></div></div>
    </form>
  </SshPanel>;
}
