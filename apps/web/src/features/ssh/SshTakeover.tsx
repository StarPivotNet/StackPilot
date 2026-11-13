import { useEffect, useRef, useState } from "react";
import { CheckCircle2 } from "lucide-react";
import { actOnSshPlan, createSshPlan, enrollSshHelper } from "../../api/sshApi";
import { formatBackendDateTime as date } from "../../utils/time";
import type { Notify } from "../../types/app";
import type { SshWorkspace } from "./useSshWorkspace";
import { SshDefinition, SshNote, SshPanel, SshStatus } from "./SshPrimitives";
import { hostStateLabel, sshStateLabel, sshCheckLabels } from "./model";
import { useSshMutation } from "./useSshMutation";

export function SshFlowView({ workspace: w, notify }: { page: string; workspace: SshWorkspace; notify: Notify }) {
  const selected=w.hosts.find(h=>h.nodeId===w.hostId),plan=w.resource.data?.plans.find(p=>p.nodeId===w.hostId),policy=w.resource.data?.policies.find(p=>p.nodeId===w.hostId&&p.userId===w.user?.id&&p.enabled);
  const [addressOverride,setAddress]=useState<string|null>(null),[portOverride,setPort]=useState<number|null>(null),[oob,setOob]=useState(false),[error,setError]=useState(""),[enrollment,setEnrollment]=useState<{token:string;expiresAt:string}|null>(null);
  const address=addressOverride??(selected?.address||selected?.catalog?.address||""),port=portOverride??selected?.port??22;
  const requestId=useRef<{signature:string;id:string}|null>(null);
  useEffect(()=>{if(!enrollment)return;const timer=window.setTimeout(()=>setEnrollment(null),Math.max(0,Date.parse(enrollment.expiresAt)-Date.now()));return()=>window.clearTimeout(timer);},[enrollment]);
  const mutation=useSshMutation(w.resource.refresh,notify),manage=!!w.hostId&&w.can("ssh:manage",w.hostId);
  const active=!!plan&&["prechecking","prechecked","applying","awaiting-verification","rolling-back"].includes(plan.state);
  const canPrecheck=manage&&!!selected?.helperRegistered&&selected.supported!==false&&!!policy&&policy.revision===policy.appliedRevision&&policy.systemUid!==null&&!active&&!plan?.local?.verificationId;
  const precheck=()=>{
    if(!address.trim()||!Number.isInteger(port)||port<1||port>65535||!oob){setError("请填写可直连的主机地址、端口，并确认带外恢复已可用");return;}
    setError("");const signature=JSON.stringify({nodeId:w.hostId,address:address.trim(),port});if(requestId.current?.signature!==signature)requestId.current={signature,id:crypto.randomUUID()};
    mutation.ask("创建主机接管预检","预检会盘点所有 SSH 入口与认证来源。此步骤不会切换 SSH 认证。",(proof,signal)=>createSshPlan({nodeId:w.hostId!,requestId:requestId.current!.id,address:address.trim(),port,outOfBandConfirmed:true},proof,signal));
  };
  return <>
    <SshPanel title="目标与恢复条件" description="首版支持 Debian 12、Ubuntu 24.04 原生 OpenSSH、PAM 和 systemd。软件安装不会自动接管现有服务器。"><form className="ssh-draft-form" onSubmit={event=>{event.preventDefault();if(canPrecheck)precheck();}}>
      <div className="ssh-form-fields"><label className="ssh-field"><span>目标主机</span><select value={w.hostId??""} onChange={event=>w.selectHost(event.target.value)}><option value="">请选择主机</option>{w.hosts.map(h=><option key={h.nodeId} value={h.nodeId}>{h.name}</option>)}</select></label><label className="ssh-field"><span>SSH 地址</span><input value={address} onChange={event=>setAddress(event.target.value)} placeholder="主机 IP 或域名" disabled={active||!!plan?.local?.verificationId}/></label><label className="ssh-field"><span>SSH 端口</span><input type="number" min={1} max={65535} value={port} onChange={event=>setPort(Number(event.target.value))} disabled={active||!!plan?.local?.verificationId}/></label><label className="ssh-field"><span>当前操作者的系统账号</span><input readOnly value={policy?.account??"请先配置并等待授权生效"}/></label></div>
      <div className="ssh-acknowledgements"><label><input type="checkbox" checked={oob} onChange={event=>setOob(event.target.checked)}/><span>已确认云控制台、VNC 或串口可用，具备独立于 SSH 的恢复权限。</span></label></div>
      {error&&<p className="ssh-field-error" role="alert">{error}</p>}<div className="ssh-form-actions"><span>{selected?`${hostStateLabel(selected)} · ${selected.helperRegistered?"主机身份已注册":"主机身份未注册"}`:"先选择已登记主机"}</span><button type="submit" className="ssh-button ssh-button-primary" disabled={!canPrecheck||!oob||mutation.busy}>开始主机预检</button></div>
    </form>{selected&&!policy&&<SshNote title="需要明确的操作者授权">为当前平台账号配置此主机的授权策略，等待系统账号和权限下发确认后再开始预检。<button className="ssh-button ssh-button-ghost" onClick={()=>w.navigate("ssh-policies",selected.nodeId)}>配置授权</button></SshNote>}</SshPanel>
    {plan&&<SshPanel title="接管计划与真实进度" description={`计划 ${plan.id}`}><SshStatus state={plan.state==="managed"?"success":plan.state==="failed"||plan.state==="manual-recovery-required"?"error":plan.state==="drifted"?"warning":"pending"}>{sshStateLabel[plan.state]}</SshStatus>
      <SshDefinition items={[["更新时间",date(plan.updatedAt)],["独立回滚截止",plan.reverification?"已提交主机重新核验，不恢复旧认证":date(plan.local?.rollbackAt,"尚未应用")],["SSH 监听入口",plan.inventory?plan.inventory.listeners.map(l=><code key={`${l.address}:${l.port}`}>{l.address}:{l.port}</code>):"等待主机盘点"],["主机指纹",plan.inventory?.fingerprints.map(pin=><code key={pin}>{pin}</code>)??"等待主机盘点"],["配置证据",plan.appliedInventory?<code>{plan.appliedInventory.digest}</code>:"尚未应用"],["当前说明",plan.error??(plan.state==="managed"?"独立验证完成并已提交":"等待主机步骤和独立新连接验证")]]}/>
      <div className="ssh-toolbar"><button className="ssh-button ssh-button-primary" disabled={!manage||plan.state!=="prechecked"||plan.requestedBy!==w.user?.id||mutation.busy} onClick={()=>mutation.ask("应用 SSH 接管策略","将停用原密码、公钥及其他 SSH 认证来源，禁止 root 直接登录。独立验证通过后自动提交并关闭旧连接；失败由主机本地计时器恢复。",(proof,signal)=>actOnSshPlan(plan.id,"apply",proof,signal))}>应用并开始验证</button>
      <button className="ssh-button ssh-button-ghost" disabled={!manage||!active||mutation.busy} onClick={()=>mutation.ask(plan.reverification?"取消重新核验":"回滚未提交接管",plan.reverification?"停止本次核验并保持暂停签发；不会恢复旧认证。":"请求主机恢复备份，结果以主机确认和恢复验证为准。",(proof,signal)=>actOnSshPlan(plan.id,"rollback",proof,signal))}>{plan.reverification?"取消重新核验":"请求回滚"}</button>
      <button className="ssh-button ssh-button-ghost" disabled={!manage||active||plan.local?.state!=="managed"||!!plan.command||mutation.busy} onClick={()=>mutation.ask("重新核验已接管主机","需要主机恢复为已登记的配置并有新鲜采集结果。将重新验证实际登录和会话期限，失败保持暂停签发，不开放旧认证。",(proof,signal)=>actOnSshPlan(plan.id,"reverify",proof,signal))}>重新核验</button></div>
      {plan.evidence.length>0&&<ul className="ssh-evidence" aria-label="独立验证结果">{plan.evidence.map(item=><li key={item.check}><CheckCircle2 size={20} aria-hidden="true"/><span>{sshCheckLabels[item.check]??item.check}</span><span>{item.passed?"通过":"未通过"} · {date(item.collectedAt)}</span></li>)}</ul>}
    </SshPanel>}
    <SshPanel title="安装与主机身份" description="独立 root helper 管理 SSH，原 Agent 保持非 root。安装、注册与接管分别执行。"><ol className="ssh-ordered-copy"><li>从已验证的发行包，以 root 执行被动安装器：<code>node deploy/scripts/install-ssh-helper.mjs install</code>。</li><li>保存 Controller HTTPS 地址、可信 CA、节点 ID 和本次注册凭据到受保护的主机配置文件。</li><li>启用启动恢复服务，显式执行注册服务，再启动 helper。确认账号权限下发成功后开始预检。</li></ol><pre className="ssh-command">systemctl enable stackpilot-ssh-boot-recovery.service{"\n"}systemctl start stackpilot-ssh-enroll.service{"\n"}systemctl enable --now stackpilot-ssh-helper.service</pre><button className="ssh-button ssh-button-ghost" disabled={!manage||mutation.busy} onClick={()=>{setEnrollment(null);mutation.ask(selected?.helperRegistered?"重新注册主机身份":"创建主机注册凭据","凭据仅展示一次，5 分钟内有效。实际重新注册会撤销原主机身份并暂停签发，需要完成重新核验。普通软件升级无需重新注册。",(proof,signal)=>enrollSshHelper(w.hostId!,proof,signal),setEnrollment);}}>创建主机注册凭据</button>
      {enrollment&&<div className="ssh-secret-block"><strong>本次主机注册凭据 · 仅展示一次</strong><code aria-label="主机注册凭据">{enrollment.token}</code><span>截止 {date(enrollment.expiresAt)}</span><p className="ssh-body-small">保存到主机 /etc/stackpilot-ssh-helper/enrollment-token，文件归 root 所有、权限 0600，目录权限 0700。请勿将其写入命令行、URL 或日志。</p><button className="ssh-button ssh-button-ghost" onClick={()=>setEnrollment(null)}>关闭注册凭据</button></div>}
    </SshPanel>{mutation.dialog}
  </>;
}

export function SshRescueView() { return <><SshNote title="故障恢复使用带外入口" warning>云控制台、VNC 或串口应独立于 StackPilot、Agent、helper 和 SSH 可用。平台断网时拒绝新登录，已有连接继续到原期限。</SshNote><SshPanel title="恢复顺序"><ol className="ssh-ordered-copy"><li>通过云控制台、VNC 或串口登录，核实目标主机及恢复权限。</li><li>未提交的接管由独立本地计时器恢复；重启后在 SSH 启动前恢复。恢复失败应按“需要带外恢复”处理。</li><li>已提交主机不会因平台故障恢复旧认证。修复网络、helper、受管账号或恢复已登记的 SSH 配置。</li><li>等待平台收到新鲜主机状态，重新核验通过后恢复签发。</li></ol></SshPanel><SshNote title="恢复边界">完整 root 管理员可以修改或停用主机管控。断网期间无法保证即时远程撤权；终止连接不会撤销已经完成的操作。</SshNote></>; }
