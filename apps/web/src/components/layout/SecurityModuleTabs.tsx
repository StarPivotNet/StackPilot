import { pushPageRoute } from "../../app/routing";
import type { PageKey } from "../../types/app";

const sections = {
  firewall: [["firewall-rules", "规则列表"], ["firewall-open", "开放端口"], ["firewall-deny", "拦截记录"]],
  audit: [["audit-all", "全部日志"], ["audit-failed", "失败操作"], ["audit-export", "导出记录"]],
} as const;

/** Shared security navigation uses the same canonical routes as the shell. */
export function SecurityModuleTabs({ module, page, canExport = false }: { module: keyof typeof sections; page: PageKey; canExport?: boolean }) {
  const active = page === module ? sections[module][0][0] : page;
  return <nav className="security-module-tabs" aria-label={module === "firewall" ? "防火墙视图" : "审计视图"}>
    {sections[module].filter(([route]) => route !== "audit-export" || canExport).map(([route, label]) => <button key={route} type="button" aria-current={active === route ? "page" : undefined} onClick={() => pushPageRoute(route)}>{label}</button>)}
  </nav>;
}
