import { ArrowRight, Eye, FileKey2, LockKeyhole, Server, Shield } from "lucide-react";
import { useEffect } from "react";
import { DataTable } from "../../components/ui/DataTable";
import { DetailDrawer } from "../../components/ui/DetailDrawer";
import { formatBackendDateTime as date } from "../../utils/time";
import { hostStateLabel, sshProfiles } from "./model";
import { SshDefinition, SshNote, SshPanel, SshStatus } from "./SshPrimitives";
import type { SshWorkspace } from "./useSshWorkspace";
import { SshDiskDetails } from "./SshDiskDetails";

type Host = SshWorkspace["hosts"][number];
function State({ host }: { host: Host }) { return <SshStatus state={host.available ? "success" : host.state === "manual-recovery-required" ? "error" : host.state === "drifted" || host.supported === false ? "warning" : "pending"}>{hostStateLabel(host)}</SshStatus>; }
export function SshHostFreshness({ workspace: w }: { workspace: SshWorkspace }) { return <span className="ssh-freshness">SSH 状态采集于 {date(w.resource.data?.collectedAt, "等待后端时间")}</span>; }
export function SshOverview({ workspace: w }: { workspace: SshWorkspace }) {
  const data=w.resource.data, now=Date.parse(data?.collectedAt??"");
  const metrics=[["授权范围主机",w.hosts.length,"当前账号可见的主机",Server],["可用托管主机",w.hosts.filter(h=>h.available).length,"已验证且采集有效",Shield],["待使用临时密码",data?.credentials.filter(c=>c.kind==="login"&&!c.revokedAt&&!c.consumedAt&&Date.parse(c.loginExpiresAt)>now).length??0,"只包含未过期的一次性密码",FileKey2],["未确认终止的连接",data?.sessions.filter(s=>!s.terminatedAt).length??0,"终止以主机回执为准",LockKeyhole]] as const;
  return <><section className="ssh-metrics" aria-label="SSH 接入概览">{metrics.map(([label,value,description,Icon])=><article key={label}><Icon size={20} aria-hidden="true"/><span>{label}</span><strong>{data?value:"—"}</strong><small>{description}</small></article>)}</section>
    <section className="ssh-section"><div className="ssh-section-heading"><div><h2>主机与访问状态</h2><p>从已登记的主机、授权和独立验证结果判断当前可用性。</p></div><button className="ssh-button ssh-button-ghost" onClick={()=>w.navigate("ssh-hosts",null)}>查看主机 <ArrowRight size={16}/></button></div><HostDirectory workspace={w} compact/></section>
    <div className="ssh-columns"><SshPanel title="一次性访问"><SshDefinition items={[["领取窗口","密码领取后 15 分钟内可使用一次"],["系统身份","每个平台用户拥有独立受管 Linux 账号"],["会话期限","从认证成功起最多 8 小时，策略可以缩短"],["撤权","禁止新登录，并等待主机终止关联连接"]]} /><button className="ssh-button ssh-button-ghost" onClick={()=>w.navigate("ssh-keys")}>查看临时密码与会话</button></SshPanel><SshPanel title="故障恢复"><p className="ssh-body-small">平台断网时拒绝新登录，已有连接继续到原期限。失联期间无法立即远程撤权；完整 root 管理员可以修改主机管控。</p><button className="ssh-button ssh-button-ghost" onClick={()=>w.navigate("ssh-rescue")}>查看带外恢复</button></SshPanel></div></>;
}
export function HostDirectory({ workspace:w,compact=false }: { workspace:SshWorkspace;compact?:boolean }) {
  const query=w.search.trim().toLocaleLowerCase();
  const filtered=w.hosts.filter(h=>(!query||`${h.name} ${h.address} ${h.owner}`.toLocaleLowerCase().includes(query))&&(w.environment==="全部环境"||h.environment===w.environment)), rows=compact?filtered.slice(0,4):filtered;
  const identity=(h:Host)=><div className="ssh-host-identity"><strong className="ssh-host-name" title={h.name}>{h.name}</strong><span>{h.helperPlatform??h.catalog?.platform??"平台待确认"} · {h.owner}</span></div>;
  const action=(h:Host,view="desktop")=><button className="ssh-button ssh-button-ghost ssh-host-detail-action" data-ssh-detail-host={h.nodeId} data-ssh-detail-view={view} aria-label={`查看 ${h.name} 的 SSH 托管详情`} onClick={()=>w.openDetail(h.nodeId,view)}><Eye size={16} aria-hidden="true"/>详情</button>;
  return <div className="ssh-host-list"><DataTable columns={[
    {key:"name",label:"主机",width:"28%",render:identity},
    {key:"address",label:"地址 / 环境",width:"24%",render:h=><div className="ssh-host-identity"><code title={h.address||h.catalog?.address||"地址待登记"}>{h.address||h.catalog?.address||"地址待登记"}</code><span>{h.environment}</span></div>},
    {key:"state",label:"接管状态",width:"30%",render:h=><State host={h}/>},
    {key:"action",label:"操作",width:"18%",render:h=>action(h)},
  ]} rows={rows} getRowKey={h=>h.nodeId} emptyText={w.resource.loading?"正在读取 SSH 状态…":filtered.length===0&&query?"没有匹配的主机":"当前授权范围暂无主机，系统将继续自动读取"} mobileCard={h=><><header className="ssh-mobile-host-heading">{identity(h)}<State host={h}/></header><code className="ssh-host-address">{h.address||h.catalog?.address||"地址待登记"}</code><span>{h.environment}</span><footer>{action(h,"mobile")}</footer></>}/><div className="ssh-directory-footer"><span>{filtered.length} 台匹配主机{compact&&filtered.length>4?"，展示前 4 台":""}</span><SshHostFreshness workspace={w}/></div></div>;
}
export function SshHosts({ workspace:w,detail }: {workspace:SshWorkspace;detail:boolean}) {
  const { hostId, navigate, resource: { data } } = w;
  const selected=w.hosts.find(h=>h.nodeId===w.hostId),opened=detail&&!!selected;
  useEffect(()=>{if(!opened)return;const oldOverflow=document.body.style.overflow;const oldPadding=document.body.style.paddingRight;const gutter=document.documentElement.clientWidth?Math.max(0,window.innerWidth-document.documentElement.clientWidth):0;if(gutter)document.body.style.paddingRight=`${(Number.parseFloat(getComputedStyle(document.body).paddingRight)||0)+gutter}px`;document.body.style.overflow="hidden";return()=>{document.body.style.overflow=oldOverflow;document.body.style.paddingRight=oldPadding;};},[opened]);
  useEffect(()=>{if(detail&&hostId&&data&&!selected)navigate("ssh-hosts",null);},[detail,hostId,data,selected,navigate]);
  const catalog=selected?.catalog, policy=w.resource.data?.policies.find(p=>p.nodeId===w.hostId&&p.userId===w.user?.id);
  const pct=(v:number|null|undefined)=>v===null||v===undefined?"等待采集":`${v.toFixed(1)}%`;
  return <><div className="ssh-filter-row"><label className="ssh-search-field"><span>搜索主机</span><input value={w.search} onChange={e=>w.setSearch(e.target.value)} placeholder="主机名、IP 或负责人"/></label><label className="ssh-select-field"><span>环境</span><select value={w.environment} onChange={e=>w.setEnvironment(e.target.value)}><option>全部环境</option>{[...new Set(w.hosts.map(h=>h.environment))].sort().map(item=><option key={item}>{item}</option>)}</select></label><button className="ssh-button ssh-button-primary" disabled={!w.can("ssh:manage")} onClick={()=>w.navigate("ssh-precheck",w.hostId)}>主机接管</button></div><HostDirectory workspace={w}/>
    <SshNote title="接管按真实入口验收">仅支持 Debian 12、Ubuntu 24.04 的原生 OpenSSH、PAM 和 systemd。无法识别的服务、额外 SSH 入口与配置漂移会阻止接管或暂停签发。</SshNote>
    {opened&&selected&&<DetailDrawer title={selected.name} subtitle={`${selected.address||catalog?.address||"地址待登记"} · ${selected.environment}`} className="ssh-host-drawer" modal onClose={w.closeDetail} closeLabel="关闭 SSH 主机详情" actions={<button className="ssh-button ssh-button-primary" onClick={()=>w.navigate(selected.available?"ssh-issue":"ssh-precheck",selected.nodeId)}>{selected.available?"申请临时密码":"查看接管流程"}</button>}><State host={selected}/><SshDefinition items={[
      ["节点 ID",<code>{selected.nodeId}</code>],["当前说明",selected.reason],["平台",selected.helperPlatform??catalog?.platform??"等待确认"],["负责人",selected.owner],["SSH 状态时间",date(selected.collectedAt)],["主机端采集时间",date(selected.helperCollectedAt)],["SSH 主机指纹",selected.fingerprints.length?selected.fingerprints.map(pin=><code key={pin}>{pin}</code>):"尚未预检"],["当前账号授权",policy?`${policy.account} · ${sshProfiles[policy.profile]}`:"未配置"],["连接状态",catalog?.connectionStatus??"等待采集"],["延迟",catalog?.latency!=null?`${catalog.latency} ms`:"等待采集"],["CPU / 内存",`${pct(catalog?.cpuPercent)} / ${pct(catalog?.memory?.percent)}`],["磁盘",<SshDiskDetails disk={catalog?.disk??null}/>],["版本",catalog?.version??"等待采集"],["运行时间",catalog?.uptimeSeconds!=null?`${Math.floor(catalog.uptimeSeconds/3600)} 小时`:"等待采集"],["备份",catalog?.backup?.detail??"未提供"],["更新状态",catalog?.updateStatus??"未提供"],["服务实例",catalog?.services.length?catalog.services.map(s=><span key={s.name}>{s.name} · {s.status}<br/></span>):"未提供"],
    ]}/><SshNote title="带外恢复独立于 SSH">云控制台、VNC 或串口是故障恢复入口。断开连接不会撤销已经完成的系统操作。</SshNote></DetailDrawer>}
  </>;
}
