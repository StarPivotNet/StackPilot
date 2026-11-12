import { CreateApiTokenRequestSchema, type ApiTokenRecord, type Permission } from "@stackpilot/contracts";
import { CheckCircle2, KeyRound, Plus, Shield } from "lucide-react";
import { useState } from "react";
import { reauthenticate } from "../../api/identityApi";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog";
import { DataTable } from "../../components/ui/DataTable";
import { DetailDrawer } from "../../components/ui/DetailDrawer";
import { usePollingResource } from "../../hooks/usePollingResource";
import type { Notify } from "../../types/app";
import { formatBackendDateTime } from "../../utils/time";
import { createSettingsToken, fetchSettingsTokens, revokeSettingsToken } from "./apiTokens";
import { SettingsCapabilityState } from "./SettingsCapabilityState";

export function ApiTokensPanel({ permissions, readOnly, notify }: { permissions: Permission[]; readOnly: boolean; notify: Notify }) {
  const allowed = permissions.includes("tokens:manage");
  const resource = usePollingResource(fetchSettingsTokens, null, allowed);
  const [pending, setPending] = useState<"create" | ApiTokenRecord | null>(null);
  const [generated, setGenerated] = useState<{ token: string; record: ApiTokenRecord } | null>(null);
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [scope, setScope] = useState("specified");
  const [nodes, setNodes] = useState("");
  const [grant, setGrant] = useState<Permission[]>(permissions.includes("overview:read") ? ["overview:read"] : []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const rows = resource.data?.tokens ?? [];
  const open = (target: typeof pending) => { setPassword(""); setError(""); setPending(target); };
  const close = () => { if (!busy) { setPending(null); setPassword(""); setError(""); } };
  const submit = async () => {
    if (!pending || busy || readOnly || !password) return;
    const input = pending === "create" ? CreateApiTokenRequestSchema.safeParse({ name, permissions: grant, nodeScope: scope === "all" ? "all" : nodes.split(/[\s,]+/).filter(Boolean), expiresAt: null }) : null;
    if (input && !input.success) { setError("请填写名称、至少一项权限，以及有效的节点 UUID。"); return; }
    setBusy(true); setError("");
    try {
      const proof = (await reauthenticate(password)).proof;
      if (pending === "create" && input?.success) {
        const result = await createSettingsToken(input.data, proof);
        resource.replaceData({ tokens: [result.record, ...rows.filter((row) => row.id !== result.record.id)], receivedAt: Date.now() });
        setGenerated(result); setName(""); notify("访问令牌已创建，请立即保存", "success");
      } else if (pending !== "create") {
        const result = await revokeSettingsToken(pending.id, proof);
        notify(result.message, "warning");
        // The revoke endpoint supplies no updated timestamp; obtain it from the list.
        await resource.refresh();
      }
      setPending(null); setPassword("");
    } catch (caught) { setError(caught instanceof Error ? caught.message : "令牌操作失败"); }
    finally { setBusy(false); }
  };
  const status = (row: ApiTokenRecord) => row.revokedAt ? "已撤销" : row.expiresAt && resource.data && Date.parse(row.expiresAt) <= resource.data.receivedAt ? "已过期" : "有效";
  if (!allowed) return <SettingsCapabilityState title="访问令牌受权限保护">当前角色没有 tokens:manage 权限。</SettingsCapabilityState>;
  return <>
    <section className="settings-section settings-token-panel">
      <header className="settings-section-head"><div><h2>访问令牌</h2><p>为 API 与自动化任务授予明确权限，完整令牌仅显示一次。</p></div><button className="primary" type="button" disabled={readOnly} onClick={() => open("create")}><Plus size={16} />生成令牌</button></header>
      {resource.error && !resource.data && <div className="overview-error-state" role="alert"><Shield size={18} /><span>{resource.error}</span><button type="button" onClick={() => void resource.retry()}>重试</button></div>}
      {resource.backgroundError && <p className="settings-freshness" role="status">后台读取失败，保留上次成功列表。</p>}
      <DataTable columns={[
        { key: "name", label: "名称", width: "180px", render: (row) => <b title={row.name}>{row.name}</b> },
        { key: "permissions", label: "权限范围", render: (row) => <span title={row.permissions.join("、")}>{row.permissions.length} 项权限</span> },
        { key: "nodes", label: "节点范围", render: (row) => row.nodeScope === "all" ? "全部授权节点" : `${row.nodeScope.length} 个节点` },
        { key: "created", label: "创建时间", width: "160px", render: (row) => formatBackendDateTime(row.createdAt) },
        { key: "used", label: "最近使用", width: "160px", render: (row) => formatBackendDateTime(row.lastUsedAt, "尚未使用") },
        { key: "state", label: "状态", width: "96px", render: (row) => <span className={`pill ${status(row) === "有效" ? "green" : "blue"}`}>{status(row)}</span> },
        { key: "actions", label: "操作", width: "80px", render: (row) => <button className="ghost small" type="button" disabled={readOnly || !!row.revokedAt} aria-label={`撤销令牌 ${row.name}`} onClick={() => open(row)}>撤销</button> },
      ]} rows={rows} emptyText={resource.loading ? "正在读取访问令牌" : resource.error ? "访问令牌暂不可用" : "当前账号尚无访问令牌"} getRowKey={(row) => row.id}
        mobileCard={(row) => <><div className="module-card-head"><span className="module-card-title"><KeyRound size={18} /><b>{row.name}</b></span><span className="pill blue">{status(row)}</span></div><div className="module-card-meta"><span><b>权限</b><em>{row.permissions.join("、")}</em></span><span><b>节点</b><em>{row.nodeScope === "all" ? "全部授权节点" : `${row.nodeScope.length} 个节点`}</em></span><span><b>创建</b><em>{formatBackendDateTime(row.createdAt)}</em></span><span><b>最近使用</b><em>{formatBackendDateTime(row.lastUsedAt, "尚未使用")}</em></span></div><div className="module-card-footer"><button className="ghost" type="button" disabled={readOnly || !!row.revokedAt} aria-label={`撤销令牌 ${row.name}`} onClick={() => open(row)}>撤销</button></div></>} />
      <p className="settings-freshness">令牌列表每 10 秒自动读取；接口未提供列表采集时间。创建、使用与撤销时间均来自服务端。</p>
    </section>
    {pending && <ConfirmDialog className="settings-token-confirm" title={pending === "create" ? "生成访问令牌" : "撤销访问令牌"} message={pending === "create" ? "权限和节点范围不能超过当前账号。完整令牌仅返回一次。" : `撤销 ${pending.name} 后，其访问权限将立即失效。`} confirmLabel={pending === "create" ? "确认生成" : "确认撤销"} tone="warning" busy={busy} confirmDisabled={readOnly || !password || (pending === "create" && (!name.trim() || !grant.length))} onClose={close} onConfirm={() => void submit()}>
      {pending === "create" && <div className="settings-token-form"><label><span>令牌名称</span><input autoFocus value={name} maxLength={80} onChange={(event) => setName(event.target.value)} /></label><fieldset><legend>授予权限</legend><div className="settings-token-grants">{permissions.map((permission) => <label key={permission}><input type="checkbox" checked={grant.includes(permission)} onChange={() => setGrant((current) => current.includes(permission) ? current.filter((key) => key !== permission) : [...current, permission])} /><span>{permission}</span></label>)}</div></fieldset><label><span>节点范围</span><select value={scope} onChange={(event) => setScope(event.target.value)}><option value="specified">指定节点</option><option value="all">全部授权节点</option></select></label>{scope === "specified" && <label><span>节点 UUID</span><textarea value={nodes} onChange={(event) => setNodes(event.target.value)} placeholder="多个 UUID 使用逗号分隔" /><small>留空表示不授予节点访问范围。</small></label>}<p className="settings-freshness">本次令牌不设置到期时间，可随时撤销。</p></div>}
      <label className="settings-reauth-field"><span>当前密码</span><input autoFocus={pending !== "create"} type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>{error && <p className="form-error" role="alert">{error}</p>}
    </ConfirmDialog>}
    {generated && <DetailDrawer className="settings-detail-drawer" modal title="新访问令牌" subtitle={generated.record.name} onClose={() => setGenerated(null)} actions={<><button className="primary" type="button" onClick={() => { if (!navigator.clipboard?.writeText) { notify("当前浏览器不支持复制令牌", "warning"); return; } void navigator.clipboard.writeText(generated.token).then(() => notify("完整访问令牌已复制", "info")).catch(() => notify("复制失败，请检查剪贴板权限", "danger")); }}>复制完整令牌</button><button className="ghost" type="button" onClick={() => setGenerated(null)}>我已保存</button></>}><div className="settings-secret"><CheckCircle2 size={24} /><p>完整令牌仅显示一次，关闭后无法再次查看。</p><code>{generated.token}</code><p>权限：{generated.record.permissions.join("、")}</p></div></DetailDrawer>}
  </>;
}
