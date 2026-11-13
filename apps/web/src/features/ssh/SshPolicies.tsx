import { useCallback, useState } from "react";
import type { SshPolicyInput } from "@stackpilot/contracts";
import { listIdentityUsers } from "../../api/identityApi";
import { saveSshPolicy } from "../../api/sshApi";
import { usePollingResource } from "../../hooks/usePollingResource";
import { DataTable } from "../../components/ui/DataTable";
import { formatBackendDateTime as date } from "../../utils/time";
import type { Notify } from "../../types/app";
import type { SshWorkspace } from "./useSshWorkspace";
import { SshDefinition, SshNote, SshPanel, SshStatus } from "./SshPrimitives";
import { durationLabel, sshProfiles } from "./model";
import { useSshMutation } from "./useSshMutation";

export function SshPolicyView({ workspace: w, notify }: { workspace: SshWorkspace; notify: Notify }) {
  const [userId, setUserId] = useState(w.user?.id ?? ""), [profile, setProfile] = useState<SshPolicyInput["profile"]>("shell"), [services, setServices] = useState(""), [seconds, setSeconds] = useState(28800), [enabled, setEnabled] = useState(true), [adminConfirmed, setAdminConfirmed] = useState(false), [error, setError] = useState("");
  const loadUsers = useCallback((signal: AbortSignal) => listIdentityUsers(signal), []);
  const users = usePollingResource(loadUsers, null, w.can("users:read"));
  const mutation = useSshMutation(w.resource.refresh, notify);
  const records = (w.resource.data?.policies ?? []).filter(p => !w.hostId || p.nodeId === w.hostId);
  const userName = (id: string) => users.data?.users.find(u => u.id === id)?.displayName ?? (id === w.user?.id ? w.user.displayName : id);
  const allowed = !!w.hostId && w.can("ssh:manage", w.hostId);
  const submit = () => {
    const units = services.trim().split(/[\s,]+/).filter(Boolean);
    if (!/^[0-9a-f-]{36}$/i.test(userId)) { setError("请选择或填写有效的平台用户 ID"); return; }
    if (profile === "service-operator" && (!units.length || units.some(unit => !/^[a-zA-Z0-9][a-zA-Z0-9_.@:-]*\.service$/.test(unit)))) { setError("请填写有效的服务单元名，以空格或换行分隔"); return; }
    if (profile === "host-admin" && !adminConfirmed) { setError("请明确确认完整 sudo 授权"); return; }
    setError(""); const input = { nodeId:w.hostId!,userId,profile,services:profile === "service-operator" ? units : [],sessionSeconds:seconds,enabled };
    mutation.ask("保存 SSH 授权", "变更会撤销旧临时密码并终止该账号的关联连接。只有主机确认新的账号及权限生效后，才能重新签发。", (proof,signal)=>saveSshPolicy(input,proof,signal));
  };
  return <>
    <SshPanel title="用户与主机授权" description="平台管理员身份不会自动授予服务器 root 权限。系统账号由平台生成，客户端不能指定其他 Linux 身份。"><form className="ssh-draft-form" onSubmit={event=>{event.preventDefault();if(allowed)submit();}}>
      <div className="ssh-form-fields"><label className="ssh-field"><span>目标主机</span><select value={w.hostId??""} onChange={event=>w.selectHost(event.target.value)}><option value="">请选择主机</option>{w.hosts.map(h=><option key={h.nodeId} value={h.nodeId}>{h.name}</option>)}</select></label><label className="ssh-field"><span>平台用户 ID</span>{users.data ? <select value={userId} onChange={event=>setUserId(event.target.value)}>{users.data.users.filter(u=>!u.disabled).map(u=><option key={u.id} value={u.id}>{u.displayName} · {u.username}</option>)}</select> : <input value={userId} onChange={event=>setUserId(event.target.value)} placeholder="用户 UUID" />}<small>{userId===w.user?.id?"当前平台账号":userName(userId)}</small></label>
      <label className="ssh-field"><span>权限档位</span><select value={profile} onChange={event=>{setProfile(event.target.value as SshPolicyInput["profile"]);setAdminConfirmed(false);}}>{Object.entries(sshProfiles).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label><label className="ssh-field"><span>会话上限</span><select value={seconds} onChange={event=>setSeconds(Number(event.target.value))}>{[60,900,3600,14400,28800].map(value=><option key={value} value={value}>{durationLabel(value)}</option>)}</select></label>
      {profile==="service-operator"&&<label className="ssh-field ssh-field-full"><span>允许管理的服务</span><textarea value={services} onChange={event=>setServices(event.target.value)} placeholder="example.service" /><small>仅支持主机验证通过的受隔离服务，只允许启动、停止和重启。控制服务及不满足隔离条件的服务将被拒绝。</small></label>}</div>
      <div className="ssh-acknowledgements"><label><input type="checkbox" checked={enabled} onChange={event=>setEnabled(event.target.checked)} /><span>启用此用户在所选主机的 SSH 授权</span></label>{profile==="host-admin"&&<label><input type="checkbox" checked={adminConfirmed} onChange={event=>setAdminConfirmed(event.target.checked)} /><span>明确授予完整 sudo 权限；该用户可以修改或停用主机管控。</span></label>}</div>
      {error&&<p className="ssh-field-error" role="alert">{error}</p>}<div className="ssh-form-actions"><span>{allowed?"保存后等待主机确认，不代表权限已生效":"请选择主机，并取得 ssh:manage 权限"}</span><button className="ssh-button ssh-button-primary" disabled={!allowed||mutation.busy||profile==="host-admin"&&!adminConfirmed} type="submit">保存授权策略</button></div>
    </form></SshPanel>
    <SshPanel title="授权下发状态"><DataTable columns={[
      {key:"identity",label:"用户 / 主机",width:"30%",render:p=><div className="ssh-host-identity"><strong className="ssh-host-name" title={userName(p.userId)}>{userName(p.userId)}</strong><span title={w.hosts.find(h=>h.nodeId===p.nodeId)?.name}>{w.hosts.find(h=>h.nodeId===p.nodeId)?.name??p.nodeId}</span><code>{p.account}</code></div>},
      {key:"profile",label:"档位 / 上限",width:"25%",render:p=><>{sshProfiles[p.profile]}<br/>{durationLabel(p.sessionSeconds)}</>},
      {key:"state",label:"主机确认",width:"30%",render:p=><><SshStatus state={p.applyError?"error":p.appliedRevision===p.revision?"success":"pending"}>{p.applyError?"权限应用失败":p.appliedRevision===p.revision?p.enabled?"已生效":"已禁用":"等待主机执行"}</SshStatus><p className="ssh-body-small">版本 {p.appliedRevision} / {p.revision} · {date(p.lastAppliedAt,"尚未确认")}</p></>},
      {key:"edit",label:"操作",width:"15%",render:p=><button className="ssh-button ssh-button-ghost" disabled={!w.can("ssh:manage",p.nodeId)} onClick={()=>{w.selectHost(p.nodeId);setUserId(p.userId);setProfile(p.profile);setServices(p.services.join("\n"));setSeconds(p.sessionSeconds);setEnabled(p.enabled);setAdminConfirmed(false);}}>编辑</button>},
    ]} rows={records} getRowKey={p=>p.id} emptyText="暂无 SSH 授权" mobileCard={p=><><strong className="ssh-host-name">{userName(p.userId)}</strong><code>{p.account}</code><span>{sshProfiles[p.profile]} · {durationLabel(p.sessionSeconds)}</span><span>{p.applyError?"权限应用失败":p.appliedRevision===p.revision?"主机已确认":"等待主机执行"}</span><button className="ssh-button ssh-button-ghost" disabled={!w.can("ssh:manage",p.nodeId)} onClick={()=>{w.selectHost(p.nodeId);setUserId(p.userId);setProfile(p.profile);setServices(p.services.join("\n"));setSeconds(p.sessionSeconds);setEnabled(p.enabled);setAdminConfirmed(false);}}>编辑</button></>} /></SshPanel>
    <SshNote title="同一账号的权限一致">同一 Linux 账号的并发连接使用同一 sudo 策略，不能按连接下发不同的 sudo 权限。策略变化会终止旧连接，再等待主机应用确认。</SshNote>
    <SshPanel title="权限档位说明"><SshDefinition items={[["普通用户","普通 shell，遵循 Linux 文件权限，无 sudo"],["服务运维","通过固定包装器操作已授权且验证过的服务"],["主机管理员","显式完整 sudo，仍禁止直接 root SSH 登录"]]} /></SshPanel>{mutation.dialog}
  </>;
}
