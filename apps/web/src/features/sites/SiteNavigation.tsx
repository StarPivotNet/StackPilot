import { navItems } from "../../app/navigation";
import { deleteContextRouteParams } from "../../app/routing";
import type { PageKey } from "../../types/app";

export function SiteNavigation({ page, canDeploy = false }: { page: PageKey; canDeploy?: boolean }) {
  const parent = navItems.find((item) => item.key === "sites");
  if (!parent) return null;
  const params = new URLSearchParams(window.location.search);
  deleteContextRouteParams(params);
  const query = params.toString();
  const links = [{ page: "sites", label: "全部站点" },
    ...parent.children.filter((child) => child.id !== "sites-create").map((child) => ({ page: child.page ?? child.id, label: child.label })),
    ...(canDeploy ? [{ page: "sites-create", label: "部署站点" }] : []),
  ];
  return <nav className="resource-module-tabs" aria-label="网站视图">{links.map((link) =>
    <a key={link.page} href={`${window.location.pathname}${query ? `?${query}` : ""}#${link.page}`} aria-current={page === link.page ? "page" : undefined}>{link.label}</a>,
  )}</nav>;
}
