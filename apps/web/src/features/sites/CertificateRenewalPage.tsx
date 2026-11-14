import { SiteNavigation } from "./SiteNavigation";
import { CheckCircle2, CircleHelp, Eye, KeyRound, RefreshCw, Shield, ShieldAlert, TriangleAlert } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import type { CertificateRenewalBatch } from "../../api/sitesApi";
import { resolvePageMeta } from "../../app/navigation";
import { ModulePageShell } from "../../components/layout/ModulePageShell";
import { MetricTile, ModuleSearch } from "../../components/ui/Cards";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog";
import { DataTable } from "../../components/ui/DataTable";
import type { TableColumn } from "../../components/ui/DataTable";
import { FieldSelect } from "../../components/ui/FormControls";
import type { Notify } from "../../types/app";
import { uniqueSorted } from "../../utils/data";
import { formatBackendDateTime } from "../../utils/time";
import {
  certificateRemainingLabel, certificateRiskLabel, certificateRiskTone, renewalStatusLabel,
} from "./certificateModel";
import { CertificateDetailDrawer } from "./CertificateDetailDrawer";
import { canRenewSiteCertificate, isSiteCertDue } from "./model";
import type { CertificateRenewalSelection, SiteRuntimeView } from "./types";
import { useCertificateRenewal } from "./useCertificateRenewal";
import { useSitesData } from "./useSitesData";

const riskOptions = ["全部证书", "需续期", "7 天内", "8-13 天", "有效", "不可用"];

function CertificateRenewalPage({ notify, canRenew, canDeploy = false }: { notify: Notify; canRenew: boolean; canDeploy?: boolean }) {
  const renewal = useCertificateRenewal(notify);
  const [search, setSearch] = useState("");
  const [riskFilter, setRiskFilter] = useState(riskOptions[0]);
  const [runtimeFilter, setRuntimeFilter] = useState("全部");
  const [selectedSiteId, setSelectedSiteId] = useState<string | null>(null);
  const reconcileRows = useCallback((nextRows: SiteRuntimeView[]) => {
    setSelectedSiteId((current) => current && nextRows.some((row) => row.id === current) ? current : null);
  }, []);
  const { rows, payload, loading, error, retry } = useSitesData(reconcileRows);
  const selectedSite = selectedSiteId ? rows.find((row) => row.id === selectedSiteId) ?? null : null;
  const initialError = Boolean(error && !payload);
  const count = (value: number) => payload ? payload.collectionStatus === "unavailable" ? "暂不可用" : String(value) : "等待采集";

  const riskRows = rows.filter(isSiteCertDue);
  const executableRows = canRenew ? riskRows.filter(canRenewSiteCertificate) : [];
  const filteredRows = useMemo(() => rows.filter((row) => {
    const query = search.trim().toLowerCase();
    const matchesSearch = !query || [row.domain, row.host, row.nodeId, row.source, row.certificateIssuer].join(" ").toLowerCase().includes(query);
    const matchesRuntime = runtimeFilter === "全部" || row.runtime === runtimeFilter;
    const matchesRisk = riskFilter === "全部证书"
      || (riskFilter === "需续期" && isSiteCertDue(row))
      || (riskFilter === "7 天内" && ["expired", "critical"].includes(row.certificate.status))
      || (riskFilter === "8-13 天" && row.certificate.status === "expiring")
      || (riskFilter === "有效" && row.certificate.status === "valid")
      || (riskFilter === "不可用" && row.certificate.status === "unavailable");
    return matchesSearch && matchesRuntime && matchesRisk;
  }), [riskFilter, rows, runtimeFilter, search]);
  const batchSelection: CertificateRenewalSelection = {
    siteIds: executableRows.map((row) => row.id), mode: "batch",
    executeCount: executableRows.length, skipCount: riskRows.length - executableRows.length,
  };

  return <ModulePageShell className="resource-cloudpulse"
    title={resolvePageMeta("sites-cert").title}
    subtitle={loading ? "正在加载已保存的证书快照" : `证书有效期、签发方与续期任务均来自后端 · 采集于 ${formatBackendDateTime(payload?.collectedAt)}`}
    page="sites-cert"
    viewContext={false} tabs={<SiteNavigation page="sites-cert" canDeploy={canDeploy} />}
    actions={initialError || !canRenew ? undefined : <button className="primary" type="button" disabled={!batchSelection.executeCount || loading} onClick={() => renewal.open(batchSelection)}><RefreshCw size={15} /> 批量续期</button>}
    filters={initialError ? undefined : <><ModuleSearch value={search} placeholder="搜索域名、节点、主机或签发方" onChange={setSearch} /><FieldSelect label="风险" value={riskFilter} options={riskOptions} onChange={setRiskFilter} /><FieldSelect label="运行时" value={runtimeFilter} options={["全部", ...uniqueSorted(rows.map((row) => row.runtime))]} onChange={setRuntimeFilter} /></>}
    metrics={initialError ? undefined : <><MetricTile icon={Shield} label="证书总数" value={count(rows.length)} tone="blue" /><MetricTile icon={ShieldAlert} label="7 天内或过期" value={count(riskRows.filter((row) => ["expired", "critical"].includes(row.certificate.status)).length)} tone="red" /><MetricTile icon={TriangleAlert} label="8-13 天" value={count(riskRows.filter((row) => row.certificate.status === "expiring").length)} tone="orange" /></>}
    side={selectedSite ? <CertificateDetailDrawer site={selectedSite} canRenew={canRenew} onClose={() => setSelectedSiteId(null)} onRenew={() => renewal.open(singleSelection(selectedSite))} /> : null}
  >
    <CertificateLoadState loading={loading} error={error} payload={payload} retry={() => void retry()} />
    {!initialError && renewal.batch && <CertificateBatchStatus batch={renewal.batch} />}
    {!initialError && <DataTable columns={certificateColumns(canRenew, setSelectedSiteId, (site) => renewal.open(singleSelection(site)))} rows={filteredRows} emptyText={loading ? "正在加载证书数据" : rows.length ? "没有符合当前筛选条件的证书" : "当前授权范围内尚未采集到证书"} getRowKey={(row) => row.id} mobileCard={(row) => <CertificateMobileCard site={row} canRenew={canRenew} onOpen={setSelectedSiteId} onRenew={() => renewal.open(singleSelection(row))} />} />}
    {renewal.selection && <RenewalConfirm selection={renewal.selection} password={renewal.password} error={renewal.error} submitting={renewal.submitting} onPassword={renewal.setPassword} onClose={renewal.close} onConfirm={() => void renewal.submit()} />}
  </ModulePageShell>;
}

function singleSelection(site: SiteRuntimeView): CertificateRenewalSelection {
  return { siteIds: [site.id], mode: "single", executeCount: 1, skipCount: 0 };
}

function CertificateLoadState({ loading, error, payload, retry }: { loading: boolean; error: string | null; payload: ReturnType<typeof useSitesData>["payload"]; retry: () => void }) {
  if (loading) return <span className="sr-only" role="status">正在从 /api/sites 加载证书快照</span>;
  if (error) return <div className="overview-error-state"><Shield size={18} /><span>{error}</span><button type="button" onClick={retry}>重试</button></div>;
  const status = payload?.collectionStatus === "complete" ? "采集完整" : payload?.collectionStatus === "partial" ? "部分采集" : "采集不可用";
  return <div className="runtime-collection-note" role="status"><Shield size={16} /><span><strong>证书来源：Controller 与授权 Agent 保存的 Nginx 快照</strong><small>{status} · 后端采集于 {formatBackendDateTime(payload?.collectedAt)}{payload?.warnings[0] ? ` · ${payload.warnings[0]}` : ""}</small></span></div>;
}

function certificateColumns(canRenew: boolean, onOpen: (id: string) => void, onRenew: (site: SiteRuntimeView) => void): Array<TableColumn<SiteRuntimeView>> {
  return [
    { key: "risk", label: "风险", width: "124px", sortValue: (row) => row.certDays, render: (row) => <CertificateRisk site={row} /> },
    { key: "domain", label: "域名", width: "244px", render: (row) => <span className="cert-domain"><b title={row.domain}>{row.domain}</b><small title={row.host}>{row.host}</small></span> },
    { key: "issuer", label: "签发方", width: "156px", render: (row) => <span className="site-truncate" title={row.certificateIssuer}>{row.certificateIssuer}</span> },
    { key: "freshness", label: "采集时间", width: "152px", render: (row) => <span className="cert-freshness"><b>{row.freshness === "current" ? "新鲜" : row.freshness === "stale" ? "陈旧" : "等待"}</b><small>{formatBackendDateTime(row.collectedAt)}</small></span> },
    { key: "renewal", label: "最新任务", width: "112px", render: (row) => <span className={`renewal-state is-${row.renewal.status}`}>{renewalStatusLabel(row.renewal.status)}</span> },
    { key: "actions", label: "操作", width: canRenew ? "152px" : "80px", control: true, render: (row) => <span className="cert-actions"><button className="ghost small" type="button" aria-label={`查看 ${row.domain} 证书详情`} onClick={() => onOpen(row.id)}><Eye size={15} /> 详情</button>{canRenew && <button className="primary small" type="button" disabled={!canRenewSiteCertificate(row)} aria-label={`续期 ${row.domain} 证书`} title={row.certificate.unavailableReason ?? undefined} onClick={() => onRenew(row)}><RefreshCw size={15} /> 续期</button>}</span> },
  ];
}

function CertificateRisk({ site }: { site: SiteRuntimeView }) {
  const Icon = ["expired", "critical"].includes(site.certificate.status) ? ShieldAlert : site.certificate.status === "unavailable" ? CircleHelp : site.certificate.status === "valid" ? CheckCircle2 : TriangleAlert;
  return <span className={`cert-risk ${certificateRiskTone(site)}`}><Icon size={16} /><b>{certificateRiskLabel(site)}</b><em>{certificateRemainingLabel(site)}</em></span>;
}

function CertificateMobileCard({ site, canRenew, onOpen, onRenew }: { site: SiteRuntimeView; canRenew: boolean; onOpen: (id: string) => void; onRenew: () => void }) {
  return <><div className="module-card-head"><span className="module-card-title site-mobile-domain"><Shield size={16} /><b title={site.domain}>{site.domain}</b></span><CertificateRisk site={site} /></div><code className="module-card-code" title={site.host}>{site.host}</code><div className="module-card-meta"><span><b>签发方</b><em>{site.certificateIssuer}</em></span><span><b>节点</b><em>{site.nodeId}</em></span><span><b>采集时间</b><em>{formatBackendDateTime(site.collectedAt)}</em></span><span><b>最新任务</b><em>{renewalStatusLabel(site.renewal.status)}</em></span></div><div className="module-card-footer cert-actions"><button className="ghost small" type="button" onClick={() => onOpen(site.id)}><Eye size={15} /> 详情</button>{canRenew && <button className="primary small" type="button" disabled={!canRenewSiteCertificate(site)} onClick={onRenew}><RefreshCw size={15} /> 续期</button>}</div></>;
}

function RenewalConfirm({ selection, password, error, submitting, onPassword, onClose, onConfirm }: { selection: CertificateRenewalSelection; password: string; error: string | null; submitting: boolean; onPassword: (value: string) => void; onClose: () => void; onConfirm: () => void }) {
  return <ConfirmDialog className="cert-renewal-confirm" title={selection.mode === "batch" ? "确认批量续期" : "确认证书续期"} message={`本次将执行 ${selection.executeCount} 个站点，跳过 ${selection.skipCount} 个站点。提交后由后端任务对账，不会预先修改有效期。`} confirmLabel={submitting ? "提交中..." : "确认续期"} tone="warning" confirmDisabled={!password || submitting} onClose={onClose} onConfirm={onConfirm}><label className="cert-reauth-field"><span><KeyRound size={15} /> 当前密码</span><input autoFocus type="password" autoComplete="current-password" value={password} disabled={submitting} onChange={(event) => onPassword(event.target.value)} /></label>{error && <p className="form-error" role="alert">{error}</p>}</ConfirmDialog>;
}

function CertificateBatchStatus({ batch }: { batch: CertificateRenewalBatch }) {
  const succeeded = batch.operations.filter((operation) => operation.status === "succeeded").length;
  const failed = batch.operations.filter((operation) => ["failed", "cancelled", "expired"].includes(operation.status)).length;
  return <section className={`cert-batch-status is-${batch.status}`} aria-live="polite"><header><RefreshCw size={18} /><span><strong>续期批次：{renewalStatusLabel(batch.status)}</strong><small>{batch.operations.length} 个证书操作 · 成功 {succeeded} · 失败或终止 {failed} · 后端更新于 {formatBackendDateTime(batch.updatedAt)}</small></span></header><div className="cert-batch-operations">{batch.operations.map((operation) => <span key={`${operation.taskId}-${operation.certificateId}`}><b title={operation.nodeId}>{operation.nodeId}</b><em>{operation.siteIds.length} 个站点</em><strong>{renewalStatusLabel(operation.status)}</strong>{operation.message && <small>{operation.message}</small>}</span>)}</div></section>;
}

export { CertificateRenewalPage };
