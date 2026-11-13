import { useCallback, useState } from "react";
import { fetchAuditEvents } from "../../api/auditApi";
import { usePollingResource } from "../../hooks/usePollingResource";
import { DataTable } from "../../components/ui/DataTable";
import { formatBackendDateTime as date } from "../../utils/time";
import { SshEmpty, SshPanel, SshStatus } from "./SshPrimitives";
import type { SshWorkspace } from "./useSshWorkspace";

export function SshAuditView({ workspace:w }: { workspace:SshWorkspace }) {
  const [draft,setDraft]=useState(""),[search,setSearch]=useState(""),[result,setResult]=useState<""|"success"|"failure">("");
  const load=useCallback((signal:AbortSignal)=>fetchAuditEvents({actionPrefix:"ssh.",...(search?{search}:{}),...(result?{result}:{})},signal),[search,result]);
  const resource=usePollingResource(load,null,w.can("audit:read"),`ssh-audit:${search}:${result}`);
  if(!w.can("audit:read"))return <SshEmpty title="需要审计读取权限">当前账号没有 audit:read 权限，请联系管理员授权。</SshEmpty>;
  return <><form className="ssh-filter-row" onSubmit={event=>{event.preventDefault();setSearch(draft.trim());}}><label className="ssh-search-field"><span>搜索 SSH 审计</span><input value={draft} onChange={e=>setDraft(e.target.value)} placeholder="操作者、主机或记录 ID" maxLength={512}/></label><label className="ssh-select-field"><span>结果</span><select value={result} onChange={e=>setResult(e.target.value as typeof result)}><option value="">全部结果</option><option value="success">成功</option><option value="failure">失败</option></select></label><button className="ssh-button ssh-button-ghost" type="submit">查询</button></form>
    {resource.error&&!resource.data&&<div className="ssh-load-error" role="alert"><span>{resource.error}</span><button className="ssh-button ssh-button-ghost" onClick={()=>void resource.retry()}>重试</button></div>}
    <SshPanel title="SSH 操作记录" description="按实际权限和节点范围查询。首版不记录终端录像，记录中不包含临时密码或主机私钥。"><DataTable columns={[
      {key:"time",label:"时间",width:"23%",render:event=>date(event.occurredAt)},
      {key:"actor",label:"操作者",width:"24%",render:event=><code>{event.actorId??event.actorType}</code>},
      {key:"action",label:"事件 / 目标",width:"33%",render:event=><div className="ssh-host-identity"><strong className="ssh-host-name" title={event.action}>{event.action}</strong><code>{event.targetId??"—"}</code></div>},
      {key:"state",label:"结果",width:"20%",render:event=><SshStatus state={event.outcome==="success"?"success":"error"}>{event.outcome==="success"?"成功":"失败"}</SshStatus>},
    ]} rows={resource.data?.events??[]} getRowKey={event=>event.eventId} emptyText={resource.loading?"正在读取审计记录…":"暂无匹配的 SSH 审计记录"} mobileCard={event=><><strong className="ssh-host-name" title={event.action}>{event.action}</strong><code>{event.actorId??event.actorType}</code><span>{date(event.occurredAt)}</span><span>{event.outcome==="success"?"成功":"失败"}</span></>}/><span className="ssh-freshness">后端采集于 {date(resource.data?.collectedAt,"等待后端时间")}{resource.backgroundError?" · 更新中断，保留上次结果":""}</span></SshPanel></>;
}
