import type { PageKey } from "../../types/app";

const terminalViews = [
  ["terminal", "受控终端"],
  ["terminal-sessions", "会话列表"],
  ["terminal-snippets", "常用命令"],
  ["terminal-history", "执行历史"],
] as const;

function TerminalTabs({ page }: { page: PageKey }) {
  return <nav className="module-tabs" aria-label="终端视图">{terminalViews.map(([route, label]) => <a key={route} href={`#${route}`} className={page === route ? "active" : undefined} aria-current={page === route ? "page" : undefined}>{label}</a>)}</nav>;
}

export { TerminalTabs };
