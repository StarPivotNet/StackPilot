import type { PageKey } from "../../types/app";

function DeploymentTabs({ page }: { page: PageKey }) {
  return <nav className="module-tabs" aria-label="发布视图">{([["deploy", "全部发布"], ["deploy-prod", "生产环境"], ["deploy-staging", "预发环境"], ["deploy-rollbacks", "版本记录"]] as const).map(([route, label]) => <a key={route} href={`#${route}`} className={page === route ? "active" : undefined} aria-current={page === route ? "page" : undefined}>{label}</a>)}</nav>;
}

export { DeploymentTabs };
