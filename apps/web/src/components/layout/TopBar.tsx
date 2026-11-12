import type { OverviewSummaryPayload } from "../../api/overviewApi";
import { Bell, ChevronDown, CircleHelp, FileClock, KeyRound, LogOut, Moon, Search, Sun, UserRound, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { resolvePageMeta, topbarSearchResults } from "../../app/navigation";
import { useTheme } from "../../theme/theme";
import type { TopbarChrome, TopbarSearchResult } from "./types";
import type { Notify, PageKey, SetPage } from "../../types/app";
import type { Permission } from "@stackpilot/contracts";
import { formatBackendDateTime, overviewCollectedAt } from "../../utils/time";

function TopBar({
  page,
  setPage,
  chrome,
  notify,
  unreadCount,
  setUnreadCount,
  overview,
  interactionsDisabled,
  onLogout,
  permissions,
  accountName,
}: {
  page: PageKey;
  setPage: SetPage;
  chrome: TopbarChrome;
  notify: Notify;
  unreadCount: number;
  setUnreadCount: React.Dispatch<React.SetStateAction<number>>;
  overview: OverviewSummaryPayload | null;
  interactionsDisabled: boolean;
  onLogout: () => void;
  permissions?: Permission[];
  accountName?: string;
}) {
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const searchRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const userMenuRef = useRef<HTMLDivElement>(null);
  const userMenuPanelRef = useRef<HTMLDivElement>(null);
  const userTriggerRef = useRef<HTMLButtonElement>(null);
  const { theme, toggleTheme } = useTheme();
  const meta = resolvePageMeta(page);
  const results = topbarSearchResults(query, permissions);
  const selectedIndex = results.length ? Math.min(activeIndex, results.length - 1) : 0;
  const visibleSearchOpen = searchOpen && !interactionsDisabled;
  const freshness = overview ? formatBackendDateTime(overviewCollectedAt(overview), "等待首次采集") : "等待首次采集";
  const health = overview?.cluster?.health || "采集中";
  const healthTone = !overview ? "info" : health === "健康" ? "success" : health === "警告" ? "warning" : "neutral";
  const userName = accountName || "当前账号";

  const closeSearch = () => {
    setSearchOpen(false);
    setActiveIndex(0);
  };

  const openResult = (result: TopbarSearchResult) => {
    setQuery("");
    closeSearch();
    setPage(result.page, { message: `已打开${result.label}`, tone: "info" });
  };

  const openUserPage = (target: PageKey, message: string) => {
    setUserMenuOpen(false);
    setPage(target, { message, tone: "info" });
  };

  const handleUserMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(userMenuPanelRef.current?.querySelectorAll<HTMLElement>("[role='menuitem']") ?? []);
    if (!items.length) return;
    const current = items.indexOf(document.activeElement as HTMLElement);
    let next = current;
    if (event.key === "ArrowDown") next = (current + 1) % items.length;
    else if (event.key === "ArrowUp") next = (current - 1 + items.length) % items.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = items.length - 1;
    else return;
    event.preventDefault();
    items[next]?.focus();
  };

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      if (!searchRef.current?.contains(event.target as Node)) closeSearch();
      if (!userMenuRef.current?.contains(event.target as Node)) setUserMenuOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k" && !interactionsDisabled) {
        event.preventDefault();
        setSearchOpen(true);
        window.requestAnimationFrame(() => inputRef.current?.focus());
      }
      if (event.key === "Escape") {
        const restoreUserFocus = Boolean(userMenuRef.current?.contains(document.activeElement));
        closeSearch();
        setUserMenuOpen(false);
        if (restoreUserFocus) userTriggerRef.current?.focus({ preventScroll: true });
      }
    };
    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [interactionsDisabled]);

  return (
    <header className={`cloud-header ${chrome.white ? "is-surface" : ""} ${chrome.showBreadcrumb ? "" : "without-context"}`}>
      {chrome.showBreadcrumb && (
        <div className="cloud-header-context" aria-label="当前位置">
          <span>{meta.breadcrumb}</span>
          <strong>{meta.title}</strong>
        </div>
      )}

      <div ref={searchRef} className={`cloud-header-search ${visibleSearchOpen ? "is-open" : ""}`}>
        <Search size={18} aria-hidden="true" />
        <label className="sr-only" htmlFor="cloud-header-search-input">全局搜索</label>
        <input
          id="cloud-header-search-input"
          ref={inputRef}
          value={query}
          placeholder={meta.search}
          disabled={interactionsDisabled}
          role="combobox"
          aria-expanded={visibleSearchOpen}
          aria-controls={visibleSearchOpen ? "cloud-header-search-results" : undefined}
          aria-activedescendant={visibleSearchOpen && results.length ? `cloud-search-result-${selectedIndex}` : undefined}
          onFocus={() => setSearchOpen(true)}
          onChange={(event) => {
            setQuery(event.target.value);
            setActiveIndex(0);
            setSearchOpen(true);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" && results.length) {
              event.preventDefault();
              setActiveIndex((current) => (current + 1) % results.length);
            } else if (event.key === "ArrowUp" && results.length) {
              event.preventDefault();
              setActiveIndex((current) => (current - 1 + results.length) % results.length);
            } else if (event.key === "Enter" && results[selectedIndex]) {
              event.preventDefault();
              openResult(results[selectedIndex]);
            }
          }}
        />
        {query && (
          <button type="button" className="cloud-header-clear" onClick={() => { setQuery(""); inputRef.current?.focus(); }} aria-label="清除搜索">
            <X size={16} />
          </button>
        )}
        {visibleSearchOpen && (
          <div id="cloud-header-search-results" className="cloud-header-results" role="listbox" aria-label="全局搜索结果">
            <div className="cloud-header-results-meta">
              <span>{query.trim() ? "搜索结果" : "快速打开"}</span>
              <small>{results.length} 项</small>
            </div>
            {results.length ? results.map((result, index) => (
              <button
                id={`cloud-search-result-${index}`}
                key={result.id}
                type="button"
                role="option"
                aria-selected={index === selectedIndex}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => openResult(result)}
              >
                <span>{result.label}</span>
                <small>{result.kind} · {result.detail}</small>
              </button>
            )) : <p>没有匹配结果</p>}
          </div>
        )}
      </div>

      <div className="cloud-header-actions">
        {chrome.showStatus && (
          <div className="cloud-header-freshness" data-tone={healthTone} title={`最近更新：${freshness}`}>
            <span aria-hidden="true" />
            <div><strong>{health}</strong><small>更新于 {freshness}</small></div>
          </div>
        )}
        <button type="button" className="cloud-header-icon" onClick={toggleTheme} disabled={interactionsDisabled} aria-label={theme === "light" ? "切换到深色主题" : "切换到浅色主题"} title={theme === "light" ? "深色主题" : "浅色主题"}>
          {theme === "light" ? <Moon size={18} /> : <Sun size={18} />}
        </button>
        <button
          type="button"
          className="cloud-header-icon cloud-header-notifications"
          disabled={interactionsDisabled}
          aria-label={unreadCount ? `${unreadCount} 条未读通知` : "暂无未读通知"}
          title={unreadCount ? "标记通知为已读" : "暂无未读通知"}
          onClick={() => {
            if (!unreadCount) return;
            setUnreadCount(0);
            notify("通知已全部标记为已读", "info");
          }}
        >
          <Bell size={18} />
          {unreadCount > 0 && <span aria-hidden="true">{unreadCount}</span>}
        </button>
        <div ref={userMenuRef} className="cloud-header-user">
          <button
            ref={userTriggerRef}
            type="button"
            className="cloud-header-user-trigger"
            disabled={interactionsDisabled}
            aria-label="用户菜单"
            aria-haspopup="menu"
            aria-expanded={userMenuOpen && !interactionsDisabled}
            aria-controls={userMenuOpen && !interactionsDisabled ? "cloud-header-user-menu" : undefined}
            onClick={() => {
              closeSearch();
              const opening = !userMenuOpen;
              setUserMenuOpen(opening);
              if (opening) window.requestAnimationFrame(() => userMenuPanelRef.current?.querySelector<HTMLElement>("[role='menuitem']")?.focus());
            }}
          >
            <UserRound size={18} aria-hidden="true" />
            <span>{userName}</span>
            <ChevronDown className="cloud-header-user-chevron" size={15} aria-hidden="true" />
          </button>
          {userMenuOpen && !interactionsDisabled && (
            <div ref={userMenuPanelRef} id="cloud-header-user-menu" className="cloud-header-user-menu" role="menu" aria-label="用户菜单" onKeyDown={handleUserMenuKeyDown}>
              <div className="cloud-header-user-summary">
                <span>当前账号</span>
                <strong>{userName}</strong>
              </div>
              <button type="button" role="menuitem" onClick={() => openUserPage("settings-general", "已打开个人资料设置")}>
                <UserRound size={18} aria-hidden="true" /><span>个人资料</span>
              </button>
              <button type="button" role="menuitem" onClick={() => openUserPage("settings-general", "已打开访问令牌设置")}>
                <KeyRound size={18} aria-hidden="true" /><span>访问令牌</span>
              </button>
              <button type="button" role="menuitem" onClick={() => openUserPage("audit", "已打开登录记录审计")}>
                <FileClock size={18} aria-hidden="true" /><span>登录记录</span>
              </button>
              <button type="button" role="menuitem" onClick={() => openUserPage("audit", "已打开操作记录审计")}>
                <FileClock size={18} aria-hidden="true" /><span>操作记录</span>
              </button>
              <a href={`${__APP_REPOSITORY_URL__}/blob/main/docs/help.md`} target="_blank" rel="noreferrer" role="menuitem" onClick={() => setUserMenuOpen(false)}>
                <CircleHelp size={18} aria-hidden="true" /><span>帮助中心</span>
              </a>
              <button type="button" role="menuitem" onClick={onLogout}>
                <LogOut size={18} aria-hidden="true" /><span>退出登录</span>
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}

export { TopBar };
