import type { Permission } from "@stackpilot/contracts";
import type { Notify, PageKey } from "../types/app";
import { CertificateRenewalPage } from "../features/sites/CertificateRenewalPage";
import { SiteDeploymentPage } from "../features/sites/SiteDeploymentPage";
import { SitesMonitoringView } from "../features/sites/SitesMonitoringView";

const defaultPermissions: Permission[] = ["sites:read", "sites:logs", "sites:deploy", "sites:operate", "sites:renew", "nodes:read"];

function SitesPage({ page, notify, permissions = defaultPermissions }: { page: PageKey; notify: Notify; permissions?: Permission[] }) {
  const allowed = (permission: Permission) => permissions.includes(permission);
  return page === "sites-create"
    ? allowed("sites:deploy") ? <SiteDeploymentPage notify={notify} canListNodes={allowed("nodes:read")} /> : <p className="overview-error-state" role="alert">没有站点部署权限</p>
    : page === "sites-cert"
      ? <CertificateRenewalPage notify={notify} canRenew={allowed("sites:renew")} canDeploy={allowed("sites:deploy")} />
      : <SitesMonitoringView page={page} canReadLogs={allowed("sites:logs")} canOperate={allowed("sites:operate")} canDeploy={allowed("sites:deploy")} />;
}

export { SitesPage };
