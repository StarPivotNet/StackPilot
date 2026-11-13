import { useEffect, useRef } from "react";
import type { Notify, PageKey, SetPage } from "../types/app";
import type { PublicUser } from "@stackpilot/contracts";
import { sshPageMeta, sshTabs } from "../features/ssh/model";
import { useSshWorkspace } from "../features/ssh/useSshWorkspace";
import { SshNote } from "../features/ssh/SshPrimitives";
import { SshOverview, SshHosts } from "../features/ssh/SshHosts";
import { SshCredentialView, SshPolicyView, SshAuditView, SshRescueView, SshFlowView } from "../features/ssh/SshViews";
import { formatBackendDateTime } from "../utils/time";

export function SshManagementPage({ page, setPage, notify, user }: { page: PageKey; setPage: SetPage; notify: Notify; user?: PublicUser }) {
  const workspace = useSshWorkspace(page, setPage, user);
  const meta = sshPageMeta[page] ?? sshPageMeta.ssh;
  const headingRef = useRef<HTMLHeadingElement>(null);
  const previousPage = useRef(page);
  useEffect(() => {
    if (previousPage.current !== page && page !== "ssh-host-detail" && previousPage.current !== "ssh-host-detail") headingRef.current?.focus({ preventScroll: true });
    previousPage.current = page;
  }, [page]);
  let content;
  if (page === "ssh" ) content = <SshOverview workspace={workspace} />;
  else if (page === "ssh-hosts" || page === "ssh-host-detail") content = <SshHosts workspace={workspace} detail={page === "ssh-host-detail"} />;
  else if (page === "ssh-policies") content = <SshPolicyView workspace={workspace} notify={notify} />;
  else if (page === "ssh-audit") content = <SshAuditView workspace={workspace} />;
  else if (page === "ssh-rescue") content = <SshRescueView />;
  else if (page === "ssh-keys" || page === "ssh-issue" || page === "ssh-revoke") content = <SshCredentialView key={`${page}:${workspace.hostId??""}`} page={page} workspace={workspace} notify={notify} />;
  else content = <SshFlowView key={`${page}:${workspace.hostId??""}`} page={page} workspace={workspace} notify={notify} />;

  const detailOpen = page === "ssh-host-detail" && workspace.hosts.some((host) => host.nodeId === workspace.hostId);
  return <div className={`ssh-page${page==="ssh"?" ssh-overview":""}`} inert={detailOpen || undefined} aria-hidden={detailOpen ? "true" : undefined}>
    <header className="ssh-page-heading"><div><span className="ssh-eyebrow">MANAGED SSH ACCESS</span><h1 ref={headingRef} tabIndex={-1}>{meta.title}</h1><p>{meta.description}</p></div><span className="ssh-integration-label">一次性密码访问</span></header>
    <nav className="ssh-tabs" aria-label="SSH 管理视图">{sshTabs.map((tab) => <button key={tab.page} type="button" aria-current={meta.active === tab.page ? "page" : undefined} onClick={() => workspace.navigate(tab.page)}>{tab.title}</button>)}</nav>
    {workspace.resource.error&&!workspace.resource.data&&<div className="ssh-load-error" role="alert"><span>{workspace.resource.error}</span><button className="ssh-button ssh-button-ghost" onClick={()=>void workspace.resource.retry()}>重试</button></div>}
    {workspace.resource.backgroundError&&<SshNote title="状态更新暂时中断">保留上次成功结果与采集时间。新的操作需等待权限及主机状态恢复确认。</SshNote>}
    {workspace.resource.data?.catalogUnavailable&&<SshNote title="资源详情暂不可用">SSH 授权与连接状态仍来自独立接口。主机资源信息保留上次结果，缺失字段等待采集。</SshNote>}
    {content}
    <footer className="ssh-page-footer"><span>断网拒绝新登录，已有连接保持原期限</span><span>后端采集于 {formatBackendDateTime(workspace.resource.data?.collectedAt,"等待后端时间")}</span></footer>
  </div>;
}
