import { useEffect, useRef } from "react";
import type { Notify, PageKey, SetPage } from "../types/app";
import { sshPageMeta, sshTabs, SSH_DISABLED_REASON } from "../features/ssh/model";
import { useSshWorkspace } from "../features/ssh/useSshWorkspace";
import { SshNote } from "../features/ssh/SshPrimitives";
import { SshOverview, SshHosts } from "../features/ssh/SshHosts";
import { SshCredentialView, SshPolicyView, SshAuditView, SshRescueView, SshFlowView } from "../features/ssh/SshViews";

export function SshManagementPage({ page, setPage, notify }: { page: PageKey; setPage: SetPage; notify: Notify }) {
  const workspace = useSshWorkspace(page, setPage);
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
  else if (page === "ssh-audit") content = <SshAuditView />;
  else if (page === "ssh-rescue") content = <SshRescueView workspace={workspace} notify={notify} />;
  else if (page === "ssh-keys" || page === "ssh-issue" || page === "ssh-revoke") content = <SshCredentialView page={page} workspace={workspace} notify={notify} />;
  else content = <SshFlowView page={page} workspace={workspace} notify={notify} />;

  const detailOpen = page === "ssh-host-detail" && workspace.hosts.some((host) => host.id === workspace.hostId);
  return <div className="ssh-page" inert={detailOpen || undefined} aria-hidden={detailOpen ? "true" : undefined}>
    <header className="ssh-page-heading"><div><span className="ssh-eyebrow">MANAGED SSH ACCESS</span><h1 ref={headingRef} tabIndex={-1}>{meta.title}</h1><p>{meta.description}</p></div><span className="ssh-integration-label">等待能力接入</span></header>
    <nav className="ssh-tabs" aria-label="SSH 管理视图">{sshTabs.map((tab) => <button key={tab.page} type="button" aria-current={meta.active === tab.page ? "page" : undefined} onClick={() => workspace.navigate(tab.page)}>{tab.title}</button>)}</nav>
    <div id="ssh-integration-reason"><SshNote title="SSH 托管尚未启用">{SSH_DISABLED_REASON}</SshNote></div>
    {content}
    <footer className="ssh-page-footer"><span>托管范围：指定 SSH 入口的新登录</span><span>平台签发凭据 · 账号与主机范围校验</span></footer>
  </div>;
}
