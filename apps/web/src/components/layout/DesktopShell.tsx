import type { PublicUser } from "@stackpilot/contracts";
import { Lock } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { desktopTopbarChrome, navPageFor } from "../../app/navigation";
import { lockedRouteForPage } from "../../app/routing";
import { DesktopFooter } from "./DesktopFooter";
import { PageTransition } from "./PageTransition";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";
import { SettingsProxyPage } from "../../features/settings/SettingsProxyPage";
import { MeshTopologyPage } from "../../pages/MeshTopologyPage";
import { MeshCachePage } from "../../pages/MeshCachePage";
import { OverviewDataProvider, useOverviewData } from "../../features/overview/OverviewDataProvider";
import { AclPage } from "../../pages/AclPage";
import { AuditPage } from "../../pages/AuditPage";
import { DatabaseBackupsPage } from "../../pages/DatabaseBackupsPage";
import { DatabaseSlowQueriesPage } from "../../pages/DatabaseSlowQueriesPage";
import { DatabasesPage } from "../../pages/DatabasesPage";
import { DeployPage } from "../../pages/DeployPage";
import { FilesModule } from "../../pages/FilesPages";
import { FirewallPage } from "../../pages/FirewallPage";
import { HostsPage } from "../../pages/HostsPage";
import { OverviewHealthPage } from "../../pages/OverviewHealthPage";
import { OverviewPage } from "../../pages/OverviewPage";
import { OverviewRisksPage } from "../../pages/OverviewRisksPage";
import { OverviewTasksPage } from "../../pages/OverviewTasksPage";
import { SchedulePage } from "../../pages/SchedulePage";
import { SshManagementPage } from "../../pages/SshManagementPage";
import { SettingsPage } from "../../pages/SettingsPage";
import { SitesPage } from "../../pages/SitesPage";
import { SystemdPage } from "../../pages/SystemdPage";
import { TerminalPage } from "../../pages/TerminalPage";
import { TerminalHistoryPage } from "../../pages/TerminalHistoryPage";
import type { Notify, PageKey, SetPage } from "../../types/app";
import { drawerFocusableElements } from "../../utils/focus";

function SessionLockOverlay({ page, onRestore }: { page: PageKey; onRestore: () => void }) {
  const overlayRef = useRef<HTMLElement>(null);
  const restoreButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    restoreButtonRef.current?.focus({ preventScroll: true });
  }, []);

  const trapFocus = (event: React.KeyboardEvent<HTMLElement>) => {
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      restoreButtonRef.current?.focus({ preventScroll: true });
      return;
    }
    if (event.key !== "Tab" || !overlayRef.current) return;
    const controls = drawerFocusableElements(overlayRef.current);
    if (controls.length === 0) {
      event.preventDefault();
      return;
    }
    const first = controls[0];
    const last = controls[controls.length - 1];
    const active = document.activeElement;
    if (!overlayRef.current.contains(active)) {
      event.preventDefault();
      first.focus();
      return;
    }
    if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
      return;
    }
    if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const restore = () => {
    const lockedRoute = lockedRouteForPage(page);
    if (`${window.location.pathname}${window.location.search}${window.location.hash}` !== lockedRoute) {
      window.history.replaceState(null, "", lockedRoute);
    }
    onRestore();
  };

  return (
    <section ref={overlayRef} className="session-lock-overlay" role="dialog" aria-modal="true" aria-labelledby="session-lock-title" onKeyDown={trapFocus}>
      <div>
        <Lock size={22} />
        <span>会话已退出</span>
        <h2 id="session-lock-title">StackPilot 控制台已锁定</h2>
        <p>服务端会话已经撤销。请重新登录后继续访问控制台。</p>
        <button ref={restoreButtonRef} className="primary" type="button" onClick={restore}>返回登录</button>
      </div>
    </section>
  );
}

function DesktopShellContent({
  page,
  setPage,
  notify,
  user,
  topbarUnreadCount,
  setTopbarUnreadCount,
  sessionLocked,
  onLogout,
}: {
  page: PageKey;
  setPage: SetPage;
  notify: Notify;
  topbarUnreadCount: number;
  setTopbarUnreadCount: React.Dispatch<React.SetStateAction<number>>;
  sessionLocked: boolean;
  onLogout: () => void;
  user: PublicUser;
}) {
  const activeModule = navPageFor(page);
  const topbarChrome = desktopTopbarChrome(page);
  const [isNarrowSidebar, setIsNarrowSidebar] = useState(() => (
    typeof window !== "undefined" && window.matchMedia("(max-width: 773px)").matches
  ));
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => (
    typeof window !== "undefined" && window.matchMedia("(max-width: 773px)").matches
  ));
  const [settingsReadOnly, setSettingsReadOnly] = useState(false);
  const { overview } = useOverviewData();
  const sidebarRestoreFocusRef = useRef<HTMLElement | null>(null);
  const desktopContentRef = useRef<HTMLDivElement | null>(null);
  const sidebarOverlayOpen = isNarrowSidebar && !sidebarCollapsed;
  const settingsReadOnlyState = { readOnly: settingsReadOnly, setReadOnly: setSettingsReadOnly };

  useEffect(() => {
    const mediaQuery = window.matchMedia("(max-width: 773px)");
    const syncSidebar = (event: MediaQueryListEvent | MediaQueryList) => {
      setIsNarrowSidebar(event.matches);
      setSidebarCollapsed(event.matches);
    };

    syncSidebar(mediaQuery);
    mediaQuery.addEventListener("change", syncSidebar);
    return () => mediaQuery.removeEventListener("change", syncSidebar);
  }, []);

  useLayoutEffect(() => {
    desktopContentRef.current?.scrollTo({ top: 0 });
  }, [page]);

  useEffect(() => {
    if (!sidebarOverlayOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setSidebarCollapsed(true);
        window.requestAnimationFrame(() => sidebarRestoreFocusRef.current?.focus({ preventScroll: true }));
        return;
      }
      if (event.key !== "Tab") return;
      const sidebar = document.querySelector<HTMLElement>("[data-sidebar-root]");
      if (!sidebar) return;
      const controls = drawerFocusableElements(sidebar);
      if (controls.length === 0) {
        event.preventDefault();
        return;
      }
      const first = controls[0];
      const last = controls[controls.length - 1];
      const active = document.activeElement;
      if (!sidebar.contains(active)) {
        event.preventDefault();
        first.focus();
        return;
      }
      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
        return;
      }
      if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.requestAnimationFrame(() => {
      const sidebar = document.querySelector<HTMLElement>("[data-sidebar-root]");
      const focusTarget = sidebar ? drawerFocusableElements(sidebar)[0] : null;
      focusTarget?.focus();
    });
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [sidebarOverlayOpen]);

  const expandSidebar = () => {
    sidebarRestoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setSidebarCollapsed(false);
  };
  const collapseSidebar = () => {
    setSidebarCollapsed(true);
    window.requestAnimationFrame(() => sidebarRestoreFocusRef.current?.focus({ preventScroll: true }));
  };
  const toggleSidebar = () => {
    if (sidebarCollapsed) {
      expandSidebar();
      return;
    }
    collapseSidebar();
  };

  return (
    <section className={`desktop-frame ${topbarChrome.white ? "white-top" : "dark-top"} ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}>
      {sidebarOverlayOpen && <div className="cloud-sidebar-backdrop" role="presentation" onClick={collapseSidebar} />}
      <Sidebar
        page={page}
        setPage={setPage}
        collapsed={sidebarCollapsed}
        onToggleCollapsed={toggleSidebar}
        onExpandCollapsed={expandSidebar}
        onNavigate={() => {
          if (isNarrowSidebar) collapseSidebar();
        }}
        permissions={user.permissions}
      />
      <div className="desktop-main" inert={sidebarOverlayOpen} aria-hidden={sidebarOverlayOpen ? "true" : undefined}>
        <TopBar page={page} setPage={setPage} chrome={topbarChrome} notify={notify} unreadCount={topbarUnreadCount} setUnreadCount={setTopbarUnreadCount} overview={overview} interactionsDisabled={sessionLocked} permissions={user.permissions} accountName={user.displayName || user.username} onLogout={onLogout} />
        <div className="desktop-content" ref={desktopContentRef}>
          <PageTransition page={page}>
            {page === "overview" && <OverviewPage setPage={setPage} notify={notify} />}
            {page === "overview-health" && <OverviewHealthPage notify={notify} />}
            {page === "overview-tasks" && <OverviewTasksPage notify={notify} setPage={setPage} />}
            {page === "overview-risks" && <OverviewRisksPage notify={notify} />}
            {page === "hosts-mesh" && user.permissions.includes("nodes:read") && <MeshTopologyPage />}
            {page === "hosts-cache" && user.permissions.includes("nodes:read") && <MeshCachePage />}
            {page === "hosts-cache" && !user.permissions.includes("nodes:read") && <section className="module-page"><div className="page-head"><div><h1>共享缓存</h1><p className="page-subtitle">当前账号没有节点读取权限，无法查看共享缓存指标。</p></div></div></section>}
            {page === "hosts-mesh" && !user.permissions.includes("nodes:read") && <section className="module-page"><div className="page-head"><div><h1>组网拓扑</h1><p className="page-subtitle">当前账号没有节点读取权限，无法查看共享网络状态。</p></div></div></section>}
            {activeModule === "hosts" && page !== "hosts-mesh" && page !== "hosts-cache" && <HostsPage page={page} notify={notify} />}
            {activeModule === "sites" && <SitesPage page={page} notify={notify} permissions={user.permissions} />}
            {activeModule === "databases" && (
              page === "databases-backups"
                ? <DatabaseBackupsPage page={page} notify={notify} permissions={user.permissions} />
                : page === "databases-slow"
                  ? <DatabaseSlowQueriesPage page={page} notify={notify} permissions={user.permissions} />
                  : <DatabasesPage page={page} setPage={setPage} notify={notify} permissions={user.permissions} />
            )}
            {activeModule === "files" && <FilesModule page={page} notify={notify} permissions={user.permissions} />}
            {page === "terminal-history" && <TerminalHistoryPage notify={notify} />}
            {activeModule === "terminal" && page !== "terminal-history" && <TerminalPage page={page} notify={notify} permissions={user.permissions} />}
            {activeModule === "systemd" && <SystemdPage page={page} notify={notify} canOperate={user.permissions.includes("services:operate")} />}
            {activeModule === "firewall" && <FirewallPage page={page} notify={notify} permissions={user.permissions} />}
            {activeModule === "deploy" && <DeployPage page={page} notify={notify} permissions={user.permissions} />}
            {activeModule === "schedule" && <SchedulePage page={page} notify={notify} permissions={user.permissions} />}
            {activeModule === "ssh" && user.permissions.includes("ssh:read") && <SshManagementPage page={page} setPage={setPage} notify={notify} user={user} />}
            {activeModule === "ssh" && !user.permissions.includes("ssh:read") && <section className="module-page"><div className="page-head"><div><h1>SSH 管理</h1><p className="page-subtitle">当前账号没有 SSH 读取权限，请联系管理员授权。</p></div></div></section>}
            {activeModule === "audit" && user.permissions.includes("audit:read") && <AuditPage page={page} notify={notify} permissions={user.permissions} />}
            {activeModule === "acl" && <AclPage page={page} setPage={setPage} notify={notify} />}
            {activeModule === "settings" && (
              page === "settings-proxy"
                ? <SettingsProxyPage page={page} setPage={setPage} notify={notify} readOnlyState={settingsReadOnlyState} />
                : <SettingsPage page={page} setPage={setPage} notify={notify} readOnlyState={settingsReadOnlyState} permissions={user.permissions} />
            )}
          </PageTransition>
        </div>
        <DesktopFooter />
      </div>
    </section>
  );
}

function DesktopShell(props: Parameters<typeof DesktopShellContent>[0]) {
  return <OverviewDataProvider><DesktopShellContent {...props} /></OverviewDataProvider>;
}

export { SessionLockOverlay, DesktopShell };
