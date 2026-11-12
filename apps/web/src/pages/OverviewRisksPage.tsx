import { exportOverviewRisks, fetchOverviewRisks } from "../api/overviewApi";
import type { OverviewRiskRecord } from "../api/overviewApi";
import { OverviewRiskDetailModal } from "../components/ui/OverviewRiskDetailModal";
import { AlertTriangle, Clock3, Download, Eye, KeyRound, Shield, ShieldAlert } from "lucide-react";
import { useState } from "react";
import { ModulePageShell } from "../components/layout/ModulePageShell";
import { MetricTile } from "../components/ui/Cards";
import { DataTable } from "../components/ui/DataTable";
import { useOptionalOverviewData } from "../features/overview/OverviewDataProvider";
import { reportApiError } from "../features/overview/model";
import { useOverviewResource } from "../features/overview/useOverviewResource";
import { OverviewFreshness, OverviewNavigation, OverviewState } from "../features/overview/OverviewUI";
import type { Notify, Tone } from "../types/app";
import { formatBackendDateTime } from "../utils/time";

function OverviewRisksPage({ notify }: { notify: Notify }) {
  const shared = useOptionalOverviewData();
  const local = useOverviewResource(fetchOverviewRisks, !shared, (reason) => reportApiError(reason, notify, "风险中心后端加载失败"));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const rows = shared?.overview?.risks ?? local.data?.risks ?? [];
  const hasData = Boolean(shared?.overview || local.data);
  const loading = (shared?.loading ?? local.loading) && !hasData;
  const error = shared?.error ?? local.error;
  const collectedAt = shared?.overview?.collectedAt ?? local.data?.scannedAt;
  const scannedAt = formatBackendDateTime(collectedAt, "等待采集");
  const selected = rows.find((row) => row.id === selectedId) ?? null;
  if (selectedId && !selected) setSelectedId(null);
  const openCount = rows.filter((row) => row.status === "待处理").length;
  const highCount = rows.filter((row) => row.level === "高危" && row.status === "待处理").length;
  const retry = () => { void (shared ? shared.reload() : local.reload()); };

  const exportRisksFromApi = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const payload = await exportOverviewRisks();
      notify(payload.message, payload.tone ?? "info");
    } catch (error) {
      reportApiError(error, notify, "导出风险报告失败");
    } finally { setExporting(false); }
  };

  return (
    <ModulePageShell
      title="风险中心"
      subtitle="按等级、目标和影响判断下一步处置。"
      tabs={<OverviewNavigation active="overview-risks" />}
      actions={<OverviewFreshness value={collectedAt} />}
      page="overview-risks"
      viewContext={false}
      metrics={<><MetricTile icon={Shield} label="待处理风险" value={hasData ? `${openCount}` : "—"} tone={openCount ? "orange" : "green"} /><MetricTile icon={KeyRound} label="高危风险" value={hasData ? `${highCount}` : "—"} tone={highCount ? "red" : "green"} /><MetricTile icon={Clock3} label="最近扫描" value={scannedAt || "-"} tone="blue" /></>}
    >
      {loading && <OverviewState loading title="正在采集风险" />}
      {error && <OverviewState error={error} title="风险数据暂不可用" onRetry={retry} />}
      {selected && (
        <OverviewRiskDetailModal risk={selected} onClose={() => setSelectedId(null)} />
      )}
      <section className="risk-list-section" aria-label="风险列表">
        <div className="risk-list-toolbar" role="toolbar" aria-label="风险列表操作">
          <h2>风险列表</h2>
          <button className="ghost" type="button" onClick={exportRisksFromApi} disabled={exporting}><Download size={14} /> {exporting ? "正在导出" : "导出报告"}</button>
        </div>
        <DataTable
          columns={[
            { key: "title", label: "风险", width: "208px", render: (row) => <b>{row.title}</b> },
            { key: "level", label: "等级", width: "96px", render: (row) => <RiskLevel level={row.level} /> },
            { key: "status", label: "状态", width: "104px", render: (row) => <span className="risk-status"><Clock3 size={14} />{row.status}</span> },
            { key: "target", label: "目标", width: "176px", render: (row) => <span className="risk-target" title={row.target}>{row.target}</span> },
            { key: "owner", label: "负责人", width: "86px", render: (row) => row.owner },
            { key: "detected", label: "发现时间", width: "105px", render: (row) => row.detected },
            { key: "impact", label: "影响", width: "208px", render: (row) => row.impact },
            { key: "actions", label: "操作", width: "92px", render: (row) => (
              <div className="table-actions">
                <button type="button" onClick={() => setSelectedId(row.id)}><Eye size={13} /> 详情</button>
              </div>
            ) },
          ]}
          rows={rows}
          emptyText={error ? "风险数据暂不可用" : loading ? "正在采集风险" : "暂无风险"}
          getRowKey={(row) => row.id}
          mobileCard={(row) => (
            <>
              <header className="module-card-head">
                <span className="module-card-title"><strong>{row.title}</strong></span>
                <RiskLevel level={row.level} />
              </header>
              <div className="module-card-meta">
                <span><b>目标</b><em>{row.target}</em></span>
                <span><b>状态</b><em className="risk-status"><Clock3 size={14} />{row.status}</em></span>
                <span><b>负责人</b><em>{row.owner}</em></span>
                <span><b>发现时间</b><em>{row.detected}</em></span>
              </div>
              <p className="module-card-code">{row.impact}</p>
              <footer className="module-card-footer"><span>风险处置</span><button className="ghost small" type="button" onClick={() => setSelectedId(row.id)}><Eye size={13} /> 查看详情</button></footer>
            </>
          )}
        />
      </section>
    </ModulePageShell>
  );
}

function RiskLevel({ level }: { level: OverviewRiskRecord["level"] }) {
  const tone: Tone = level === "高危" ? "red" : level === "中危" ? "orange" : "blue";
  const Icon = level === "高危" ? ShieldAlert : AlertTriangle;
  return <span className={`pill risk-level ${tone}`}><Icon size={13} />{level}</span>;
}

export { OverviewRisksPage };
