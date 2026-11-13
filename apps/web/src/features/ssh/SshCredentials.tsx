import { useEffect, useState } from "react";
import { DataTable } from "../../components/ui/DataTable";
import { issueSshCredential, revokeSshCredential, terminateSshSession, type IssuedSshCredential } from "../../api/sshApi";
import { formatBackendDateTime as date } from "../../utils/time";
import type { Notify } from "../../types/app";
import type { SshWorkspace } from "./useSshWorkspace";
import { useSshMutation } from "./useSshMutation";
import { SshDefinition, SshEmpty, SshNote, SshPanel, SshStatus } from "./SshPrimitives";
import { durationLabel } from "./model";

export function SshCredentialView({ workspace: w, notify }: { page: string; workspace: SshWorkspace; notify: Notify }) {
  const [purpose, setPurpose] = useState(""), [seconds, setSeconds] = useState(3600), [issued, setIssued] = useState<IssuedSshCredential | null>(null);
  const mutation = useSshMutation(w.resource.refresh, notify), selected = w.hosts.find(h => h.nodeId === w.hostId);
  const ownPolicy = w.resource.data?.policies.find(p => p.nodeId === w.hostId && p.userId === w.user?.id && p.enabled);
  const ready = !!selected?.available && !!ownPolicy && ownPolicy.revision === ownPolicy.appliedRevision;
  const reason = !w.can("ssh:connect", w.hostId ?? undefined) ? "当前账号没有此主机的 SSH 连接权限" : !ready ? "需要已验证主机和当前账号的已生效授权" : !purpose.trim() ? "请填写访问用途" : "";
  useEffect(() => { if (!issued) return; const timer = window.setTimeout(() => setIssued(null), Math.max(0, Date.parse(issued.credential.loginExpiresAt) - Date.now())); return () => window.clearTimeout(timer); }, [issued]);
  const credentials = (w.resource.data?.credentials ?? []).filter(c => c.kind === "login" && (!w.hostId || c.nodeId === w.hostId));
  const sessions = (w.resource.data?.sessions ?? []).filter(s => !w.hostId || s.nodeId === w.hostId);
  const hostName = (id: string) => w.hosts.find(h => h.nodeId === id)?.name ?? id;
  const current = Date.parse(w.resource.data?.collectedAt ?? "");
  return <>
    <SshPanel title="申请一次性密码" description="密码只用于一次 SSH 认证。普通 SSH 客户端会显示交互式密码提示。">
      <form className="ssh-draft-form" onSubmit={event => { event.preventDefault(); if (reason) return; setIssued(null); mutation.ask("申请 SSH 临时密码", `为当前账号访问 ${selected?.name} 申请一次性密码。系统账号和权限由已生效策略决定。`, (proof, signal) => issueSshCredential(w.hostId!, purpose.trim(), Math.min(seconds, ownPolicy!.sessionSeconds), proof, signal), setIssued); }}>
        <div className="ssh-form-fields"><label className="ssh-field"><span>目标主机</span><select value={w.hostId ?? ""} onChange={event => w.selectHost(event.target.value)}><option value="">请选择主机</option>{w.hosts.map(h => <option key={h.nodeId} value={h.nodeId}>{h.name}</option>)}</select></label><label className="ssh-field"><span>受管系统账号</span><input readOnly value={ownPolicy?.account ?? "尚无当前账号授权"} /></label><label className="ssh-field"><span>会话时限</span><select value={Math.min(seconds,ownPolicy?.sessionSeconds??28800)} onChange={event => setSeconds(Number(event.target.value))}>{[...new Set([60,900,3600,14400,28800,ownPolicy?.sessionSeconds??28800])].sort((a,b)=>a-b).map(value => <option key={value} value={value} disabled={!!ownPolicy && value > ownPolicy.sessionSeconds}>{durationLabel(value)}</option>)}</select><small>实际期限不会超过策略上限 {ownPolicy ? durationLabel(ownPolicy.sessionSeconds) : "—"}。</small></label><label className="ssh-field"><span>访问用途</span><input required maxLength={500} value={purpose} onChange={event => setPurpose(event.target.value)} placeholder="说明本次维护用途" /></label></div>
        <div className="ssh-form-actions"><span>{reason || `登录后最长 ${durationLabel(Math.min(seconds, ownPolicy!.sessionSeconds))}，断网不续期`}</span><button className="ssh-button ssh-button-primary" disabled={!!reason || mutation.busy} title={reason} type="submit">申请临时密码</button></div>
      </form>
    </SshPanel>
    {issued && <SshPanel title="本次密码 · 仅展示一次" description="关闭、切换页面或离开后无法找回。请使用新连接登录，重复使用将被拒绝。"><SshDefinition items={[["主机 / 端口", `${issued.address}:${issued.port}`], ["系统账号", <code>{issued.credential.account}</code>], ["登录截止时间", date(issued.credential.loginExpiresAt)], ["认证后的会话时限", durationLabel(issued.credential.sessionSeconds)], ["一次性 SSH 密码", <code aria-label="一次性 SSH 密码" className="ssh-secret">{issued.password}</code>], ["主机指纹", issued.fingerprints.map(pin => <code key={pin}>{pin}</code>)]]} /><pre className="ssh-command">ssh -p {issued.port} {issued.credential.account}@{issued.address}</pre><div className="ssh-toolbar"><button className="ssh-button ssh-button-primary" type="button" onClick={() => void navigator.clipboard.writeText(issued.password).then(() => notify("密码已复制", "success"), () => notify("复制失败，请手动复制本次密码", "warning"))}>复制本次密码</button><button className="ssh-button ssh-button-ghost" type="button" onClick={() => setIssued(null)}>我已保存，关闭密码</button></div></SshPanel>}
    <SshPanel title="临时密码记录" description="只显示元数据，已领取的密码不会再次返回。撤销同时要求终止关联连接。"><DataTable columns={[
      { key:"host",label:"主机 / 系统账号",width:"30%",render:c=><div className="ssh-host-identity"><strong className="ssh-host-name" title={hostName(c.nodeId)}>{hostName(c.nodeId)}</strong><code>{c.account}</code><span>{c.purpose}</span></div> },
      { key:"time",label:"登录截止",width:"25%",render:c=>date(c.loginExpiresAt) },
      { key:"state",label:"状态",width:"25%",render:c=><SshStatus>{c.revokedAt ? "撤销已登记" : c.consumedAt ? "已使用" : Date.parse(c.loginExpiresAt) <= current ? "已过期" : "待使用"}</SshStatus> },
      { key:"action",label:"操作",width:"20%",render:c=><button className="ssh-button ssh-button-ghost" type="button" disabled={!!c.revokedAt || !w.can("ssh:connect",c.nodeId) || (c.userId !== w.user?.id && !w.can("ssh:manage",c.nodeId))} onClick={()=>mutation.ask("撤销临时密码","撤销将禁止新登录，并请求主机终止关联连接。断网主机会在恢复联系后执行。",(proof,signal)=>revokeSshCredential(c.id,proof,signal))}>撤销</button> },
    ]} rows={credentials} getRowKey={c=>c.id} emptyText="暂无临时密码记录" mobileCard={c=><><strong className="ssh-host-name" title={hostName(c.nodeId)}>{hostName(c.nodeId)}</strong><code>{c.account}</code><span>{c.purpose}</span><span>{c.revokedAt ? "撤销已登记" : c.consumedAt ? "已使用" : Date.parse(c.loginExpiresAt) <= current ? "已过期" : "待使用"}</span><span>{date(c.loginExpiresAt)}</span><button className="ssh-button ssh-button-ghost" disabled={!!c.revokedAt || !w.can("ssh:connect",c.nodeId) || (c.userId !== w.user?.id && !w.can("ssh:manage",c.nodeId))} onClick={()=>mutation.ask("撤销临时密码","同时请求终止关联连接，等待主机确认。",(proof,signal)=>revokeSshCredential(c.id,proof,signal))}>撤销</button></>} /></SshPanel>
    <SshPanel title="SSH 连接" description="已登记的断开请求只有在主机确认后才显示终止。"><DataTable columns={[
      { key:"host",label:"主机 / 账号",width:"30%",render:s=><div className="ssh-host-identity"><strong className="ssh-host-name" title={hostName(s.nodeId)}>{hostName(s.nodeId)}</strong><code>{s.account}</code><code title={s.id}>{s.id}</code></div> },
      { key:"expires",label:"会话截止",width:"25%",render:s=>date(s.expiresAt) },
      { key:"state",label:"执行状态",width:"25%",render:s=><SshStatus state={s.terminatedAt?"success":"pending"}>{s.terminatedAt?"主机已确认终止":s.terminationRequestedAt?"等待主机执行":Date.parse(s.expiresAt)<=current?"已到期，待主机确认":"连接有效"}</SshStatus> },
      { key:"action",label:"操作",width:"20%",render:s=><button className="ssh-button ssh-button-ghost" type="button" disabled={!!s.terminatedAt || !!s.terminationRequestedAt || !w.can("ssh:sessions:terminate",s.nodeId) || (s.userId!==w.user?.id&&!w.can("ssh:manage",s.nodeId))} onClick={()=>mutation.ask("终止 SSH 连接","连接及其受控进程组将被终止。此前已完成的系统操作不会撤销。",(proof,signal)=>terminateSshSession(s.id,proof,signal))}>终止连接</button> },
    ]} rows={sessions} getRowKey={s=>s.id} emptyText="暂无 SSH 连接" mobileCard={s=><><strong className="ssh-host-name" title={hostName(s.nodeId)}>{hostName(s.nodeId)}</strong><code>{s.account}</code><code>{s.id}</code><span>{s.terminatedAt?"主机已确认终止":s.terminationRequestedAt?"等待主机执行":Date.parse(s.expiresAt)<=current?"已到期，待主机确认":"连接有效"}</span><span>截止 {date(s.expiresAt)}</span><button className="ssh-button ssh-button-ghost" disabled={!!s.terminatedAt||!!s.terminationRequestedAt||!w.can("ssh:sessions:terminate",s.nodeId)||(s.userId!==w.user?.id&&!w.can("ssh:manage",s.nodeId))} onClick={()=>mutation.ask("终止 SSH 连接","终止连接及受控进程组，等待主机确认。",(proof,signal)=>terminateSshSession(s.id,proof,signal))}>终止连接</button></>} /></SshPanel>
    {!w.resource.data && <SshEmpty title="等待实际 SSH 状态">未生成示例凭据或会话。</SshEmpty>}<SshNote title="权限与会话边界">临时密码不用于 sudo。普通用户没有 sudo；服务运维和主机管理员按受管账号执行对应的免密码规则。完整 root 管理员可以停用本机管控。</SshNote>{mutation.dialog}
  </>;
}
