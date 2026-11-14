import { AlertTriangle, CheckCircle2, Download, Loader, ShieldAlert, Timer } from "lucide-react";
import { useId, useMemo, useState } from "react";
import type { HostMonitoringRecord } from "@stackpilot/contracts";
import { createDownload, fetchDownloadJobs, fetchEgressPlan, retryDownload } from "../api/cacheApi";
import { fetchHosts } from "../api/hostsApi";
import { reauthenticate } from "../api/identityApi";
import { ModulePageShell } from "../components/layout/ModulePageShell";
import { MetricTile } from "../components/ui/Cards";
import { DataTable } from "../components/ui/DataTable";
import { ResourceNavigation } from "../features/hosts/ResourceNavigation";
import { toEgressView, type EgressNodeView, type EgressView } from "../features/network/egressModel";
import { toDownloadJobsView, type DownloadJobView, type DownloadJobsView, type DownloadTrafficRowView, type DownloadTrafficView } from "../features/network/downloadJobsModel";
import { usePollingResource } from "../hooks/usePollingResource";
import type { PageKey } from "../types/app";
import { formatBackendDateTime } from "../utils/time";

const page: PageKey = "hosts-downloads";

function DownloadMetrics({ view }: { view: DownloadJobsView | null }) {
  const count = (value: string) => (view ? value : "等待采集");
  return (
    <>
      <MetricTile icon={Loader} label="传输中" value={count(`${view?.runningCount ?? 0} 个`)} tone={(view?.runningCount ?? 0) > 0 ? "blue" : "gray"} />
      <MetricTile icon={AlertTriangle} label="失败" value={count(`${view?.failedCount ?? 0} 个`)} tone={(view?.failedCount ?? 0) > 0 ? "red" : "green"} />
      <MetricTile icon={CheckCircle2} label="已完成" value={count(`${view?.succeededCount ?? 0} 个`)} tone="green" />
      <MetricTile icon={Timer} label="分片任务" value={count(`${view?.segmentedCount ?? 0} 个`)} tone="purple" />
    </>
  );
}

function StatusChip({ row }: { row: DownloadJobView }) {
  const Icon = row.statusIcon;
  return <span className={`pill ${row.statusTone}`}><Icon size={13} />{row.statusLabel}</span>;
}

function RouteCell({ row }: { row: DownloadJobView }) {
  // Live per-part rates only: a finished job's parts have no current speed to show.
  const parts = row.live ? row.parts.slice(0, 4) : [];
  const hidden = row.live ? row.parts.length - parts.length : 0;
  return (
    <span className="mesh-handshake-mobile" title={`${row.routeLabel} · ${row.originLabel}`}>
      <span>{row.routeLabel}</span>
      <small className="mesh-muted">{row.partsLabel}{row.resumedLabel ? ` · ${row.resumedLabel}` : ""}</small>
      {parts.map((part) => <small className="mesh-muted" key={part.key}>{part.label} {part.rateLabel}</small>)}
      {hidden > 0 && <small className="mesh-muted">另有 {hidden} 片</small>}
    </span>
  );
}

const trafficColumns = [
  { key: "node", label: "节点", width: "200px", render: (row: DownloadTrafficRowView) => <span className="mesh-node-name" title={row.nodeName}>{row.nodeName}</span> },
  { key: "received", label: "本月下行", width: "140px", render: (row: DownloadTrafficRowView) => <code className="mesh-address">{row.receivedLabel}</code> },
  { key: "origin", label: "其中回源", width: "140px", render: (row: DownloadTrafficRowView) => <span className="mesh-muted">{row.originLabel}</span> },
  { key: "served", label: "转发对端", width: "140px", render: (row: DownloadTrafficRowView) => <span className="mesh-muted">{row.servedLabel}</span> },
  { key: "status", label: "配额", width: "132px", render: (row: DownloadTrafficRowView) => <TrafficStatusChip row={row} /> },
];

function TrafficStatusChip({ row }: { row: DownloadTrafficRowView }) {
  const Icon = row.statusIcon;
  return <span className={`mesh-chip ${row.statusTone}`}><Icon size={14} />{row.statusLabel}</span>;
}

/**
 * Month-to-date traffic per node, summed by the Controller from the same rows the queue reads.
 * The figures are what the mesh actually carried, so an operator can see why a node stopped
 * sharding instead of guessing from a failed job.
 */
function TrafficCard({ view }: { view: DownloadTrafficView }) {
  return (
    <section className="mesh-overlay-card" aria-labelledby="download-traffic-title">
      <header className="mesh-overlay-head">
        <div>
          <p className="mesh-overlay-eyebrow">本月节点流量</p>
          <h2 id="download-traffic-title">{view.headlineLabel}</h2>
        </div>
        <span className={`mesh-chip ${view.degradedCount > 0 ? "degraded" : "healthy"}`}>
          {view.degradedCount > 0 ? <AlertTriangle size={14} /> : <CheckCircle2 size={14} />}
          {view.quotaLabel}
        </span>
      </header>
      <dl className="mesh-overlay-stats">
        <div><dt>计费月</dt><dd>{view.monthLabel}</dd></div>
        <div><dt>下行合计</dt><dd>{view.receivedLabel}</dd></div>
        <div><dt>转发给对端</dt><dd>{view.servedLabel}</dd></div>
        <div><dt>停用加速</dt><dd>{view.degradedCount} 个节点</dd></div>
      </dl>
      {view.degradedLabel && (
        <ul className="mesh-warnings" aria-label="流量配额告警">
          <li><AlertTriangle size={14} /><span>{view.degradedLabel}</span></li>
        </ul>
      )}
      {view.rows.length > 0 && (
        <DataTable
          columns={trafficColumns}
          rows={view.rows}
          emptyText="本月还没有节点流量"
          getRowKey={(row) => row.nodeId}
          mobileCard={(row) => (
            <>
              <div className="module-card-head host-mobile-head">
                <span className="mesh-node-name" title={row.nodeName}>{row.nodeName}</span>
                <TrafficStatusChip row={row} />
              </div>
              <div className="module-card-meta">
                <span><b>本月下行</b><em>{row.receivedLabel}</em></span>
                <span><b>其中回源</b><em>{row.originLabel}</em></span>
                <span><b>转发对端</b><em>{row.servedLabel}</em></span>
              </div>
            </>
          )}
        />
      )}
    </section>
  );
}

function EgressStatusChip({ row }: { row: EgressNodeView }) {
  const Icon = row.statusIcon;
  return <span className={`mesh-chip ${row.statusTone}`}><Icon size={14} />{row.statusLabel}</span>;
}

const egressColumns = [
  { key: "node", label: "节点", width: "180px", render: (row: EgressNodeView) => <span className="mesh-node-name" title={row.nodeName}>{row.nodeName}</span> },
  { key: "address", label: "出口地址", width: "164px", render: (row: EgressNodeView) => <code className="mesh-address">{row.addressLabel}</code> },
  { key: "ttfb", label: "首字节", width: "104px", render: (row: EgressNodeView) => <span className="mesh-muted">{row.ttfbLabel}</span> },
  { key: "rate", label: "吞吐", width: "120px", render: (row: EgressNodeView) => <code className="mesh-address">{row.rateLabel}</code> },
  { key: "samples", label: "样本", width: "140px", render: (row: EgressNodeView) => <span className="mesh-muted">{row.sampleLabel}</span> },
  { key: "status", label: "状态", width: "132px", render: (row: EgressNodeView) => <EgressStatusChip row={row} /> },
];

/**
 * The egress quality table the Controller already keeps in memory: which node measured what to the
 * probe sources, and whether that sample is still fresh. Read-only, so it never starts a probe.
 */
function EgressCard({ view }: { view: EgressView }) {
  return (
    <section className="mesh-overlay-card" aria-labelledby="download-egress-title">
      <header className="mesh-overlay-head">
        <div>
          <p className="mesh-overlay-eyebrow">出口质量表</p>
          <h2 id="download-egress-title">{view.headlineLabel}</h2>
        </div>
        <span className={`mesh-chip ${view.readyCount > 0 ? "healthy" : "degraded"}`}>
          {view.readyCount > 0 ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}
          {view.readyCount > 0 ? "可委派出口" : "无可用出口"}
        </span>
      </header>
      <dl className="mesh-overlay-stats">
        <div><dt>读取时间</dt><dd>{view.updatedLabel}</dd></div>
        <div><dt>最新样本</dt><dd>{view.freshestLabel}</dd></div>
        <div><dt>可作出口</dt><dd>{view.readyCount} 个节点</dd></div>
        <div><dt>参与节点</dt><dd>{view.nodes.length} 个</dd></div>
      </dl>
      {view.warnings.length > 0 && (
        <ul className="mesh-warnings" aria-label="出口探测告警">
          {view.warnings.map((warning) => <li key={warning}><AlertTriangle size={14} /><span>{warning}</span></li>)}
        </ul>
      )}
      {view.nodes.length > 0 && (
        <DataTable
          columns={egressColumns}
          rows={view.nodes}
          emptyText="暂无节点"
          getRowKey={(row) => row.nodeId}
          mobileCard={(row) => (
            <>
              <div className="module-card-head host-mobile-head">
                <span className="mesh-node-name" title={row.nodeName}>{row.nodeName}</span>
                <EgressStatusChip row={row} />
              </div>
              <div className="module-card-meta">
                <span><b>出口地址</b><em>{row.addressLabel}</em></span>
                <span><b>首字节</b><em>{row.ttfbLabel}</em></span>
                <span><b>吞吐</b><em>{row.rateLabel}</em></span>
                <span><b>样本</b><em>{row.sampleLabel}</em></span>
              </div>
            </>
          )}
        />
      )}
    </section>
  );
}

type DownloadJobsPageProps = { canCreate: boolean; canRetry: boolean; canReadNodes: boolean };

function DownloadJobsPage({ canCreate, canRetry, canReadNodes }: DownloadJobsPageProps) {
  const { data, loading, error, backgroundError, retry: refresh } = usePollingResource(fetchDownloadJobs, null, true, "network-downloads");
  // The quality table needs `nodes:read`, which `tasks:read` does not imply: polling it anyway would
  // just 403 every ten seconds behind a card that never appears.
  const egress = usePollingResource(fetchEgressPlan, null, canReadNodes, "network-egress");
  const hosts = usePollingResource(fetchHosts, null, canCreate, "network-downloads-hosts");
  const view = useMemo(() => (data ? toDownloadJobsView(data) : null), [data]);
  const egressView = useMemo(() => (egress.data ? toEgressView(egress.data) : null), [egress.data]);

  const [url, setUrl] = useState("");
  const [nodeId, setNodeId] = useState("");
  const [segmented, setSegmented] = useState(true);
  const [digest, setDigest] = useState("");
  // The helper lives inside the label for spacing, so the input names itself and describes itself.
  const digestHelpId = useId();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingRetry, setPendingRetry] = useState<string | null>(null);

  // Only a node the Agent has reported can run a fill; a local-only record has no Agent to call.
  const options = useMemo(() => (hosts.data?.hosts ?? []).filter((host: HostMonitoringRecord) => host.source === "agent"), [hosts.data]);

  const submit = async () => {
    if (!canCreate || busy) return;
    const target = url.trim();
    if (!target || !nodeId || !password) { setFormError("请填写目标地址、节点与当前密码"); return; }
    // A digest is optional, but a malformed one would only fail after the password was spent.
    const expected = digest.trim().toLowerCase();
    if (expected !== "" && !/^[a-f0-9]{64}$/.test(expected)) { setFormError("SHA-256 摘要需要 64 位十六进制字符，或留空"); return; }
    setBusy(true); setFormError(null);
    try {
      const proof = (await reauthenticate(password)).proof;
      await createDownload({
        nodeId, url: target,
        ...(expected !== "" ? { digest: expected } : {}),
        ...(segmented ? { segments: { maxNodes: 4 } } : {}),
        idempotencyKey: `download:${crypto.randomUUID()}`,
      }, proof);
      setPassword(""); setUrl(""); setDigest("");
      await refresh();
    } catch (caught) {
      setFormError(caught instanceof Error ? caught.message : "拉取请求失败");
    } finally { setBusy(false); }
  };

  const retryJob = async (taskId: string) => {
    if (pendingRetry) return;
    setPendingRetry(taskId); setActionError(null);
    try { await retryDownload(taskId); await refresh(); }
    catch (caught) { setActionError(caught instanceof Error ? caught.message : "重试失败"); }
    finally { setPendingRetry(null); }
  };

  const columns = [
    { key: "target", label: "目标", width: "240px", render: (row: DownloadJobView) => (
      <span className="mesh-handshake-mobile" title={row.url}>
        <code className="mesh-address">{row.host}</code>
        <small className="mesh-muted">{row.nodeName}</small>
      </span>
    ) },
    { key: "status", label: "状态", width: "112px", render: (row: DownloadJobView) => <StatusChip row={row} /> },
    { key: "progress", label: "进度", width: "190px", render: (row: DownloadJobView) => (
      <span className="mesh-handshake-mobile"><span>{row.progressLabel}</span><small className="mesh-muted">{row.percent === null ? row.attemptLabel : `${row.percent}% · ${row.attemptLabel}`}</small></span>
    ) },
    { key: "rate", label: "速率", width: "128px", render: (row: DownloadJobView) => <code className="mesh-address">{row.rateLabel}</code> },
    { key: "route", label: "路由", width: "176px", render: (row: DownloadJobView) => <RouteCell row={row} /> },
    { key: "failure", label: "失败原因", width: "168px", render: (row: DownloadJobView) => row.failureLabel
      ? <span className="red-text" title={row.failureLabel}>{row.failureLabel}</span>
      : <span className="mesh-muted">—</span> },
    { key: "updated", label: "更新时间", width: "188px", render: (row: DownloadJobView) => <span className="mesh-muted">{row.updatedLabel}</span> },
    { key: "ops", label: "操作", width: "96px", control: true, render: (row: DownloadJobView) => (
      <span className="table-actions actions-1">
        {row.retryable && canRetry
          ? <button type="button" disabled={pendingRetry !== null} onClick={() => void retryJob(row.taskId)}>{pendingRetry === row.taskId ? "重试中" : "重试"}</button>
          : <span className="mesh-muted">—</span>}
      </span>
    ) },
  ];

  const subtitle = loading && !view
    ? "正在读取各节点的缓存下载任务"
    : "下载任务按 10 秒自动刷新：进度与速率来自 Agent 自己上报的计数，分片、出口与回源都由 Controller 决策，失败的任务可以重试";

  return (
    <ModulePageShell
      title="下载任务"
      subtitle={subtitle}
      page={page}
      className="resource-cloudpulse mesh-topology"
      viewContext={false}
      tabs={<ResourceNavigation module="hosts" page={page} />}
      metrics={<DownloadMetrics view={view} />}
    >
      <p className="resource-freshness">后端采集于 {formatBackendDateTime(view?.collectedAt)}</p>
      {loading && !view && <span className="sr-only" role="status" aria-live="polite">正在从 /api/network/cache/downloads 读取下载任务</span>}
      {error && (
        <div className="overview-error-state hosts-error-state">
          <ShieldAlert size={18} />
          <span>{error}</span>
          <button type="button" disabled={loading} onClick={() => void refresh()}>重试</button>
        </div>
      )}
      {backgroundError && view && <p className="resource-freshness"><span className="red-text">最近一次刷新失败，展示上次成功数据</span></p>}
      {actionError && <p className="form-error" role="alert">{actionError}</p>}

      {view && view.jobs.length === 0 && (
        <div className="mesh-empty">
          <Download size={20} />
          <div>
            <strong>还没有下载任务</strong>
            <p>{canCreate ? "在下方选择源站地址与接收节点开始一次拉取；命中缓存的构件不会再回源。" : "当前账号可以查看下载任务，但开始拉取需要任务创建权限。"}本页每 10 秒自动刷新。</p>
          </div>
        </div>
      )}
      {view && view.jobs.length > 0 && (
        <DataTable
          columns={columns}
          rows={view.jobs}
          emptyText="没有匹配的任务，系统会继续自动刷新"
          getRowKey={(row) => row.taskId}
          mobileCard={(row) => (
            <>
              <div className="module-card-head host-mobile-head">
                <code className="module-card-code mesh-address" title={row.url}>{row.host}</code>
                <StatusChip row={row} />
              </div>
              <div className="module-card-meta">
                <span><b>节点</b><em>{row.nodeName}</em></span>
                <span><b>进度</b><em>{row.progressLabel}</em></span>
                <span><b>速率</b><em>{row.rateLabel}</em></span>
                <span><b>路由</b><em>{row.routeLabel}</em></span>
                <span><b>分片</b><em>{row.partsLabel}</em></span>
                <span><b>失败原因</b><em>{row.failureLabel ?? "—"}</em></span>
                <span><b>更新时间</b><em>{row.updatedLabel}</em></span>
              </div>
              {row.live && row.parts.length > 0 && (
                <div className="module-card-meta" aria-label="分片速率">
                  {row.parts.map((part) => <span key={part.key}><b>{part.label}</b><em>{part.rateLabel}</em></span>)}
                </div>
              )}
              {row.retryable && canRetry && (
                <div className="module-card-footer">
                  <div className="table-actions actions-1">
                    <button type="button" disabled={pendingRetry !== null} onClick={() => void retryJob(row.taskId)}>{pendingRetry === row.taskId ? "重试中" : "重试"}</button>
                  </div>
                </div>
              )}
            </>
          )}
        />
      )}

      {/* The queue leads; the month's traffic explains why a node stopped accelerating. */}
      {view && <TrafficCard view={view.traffic} />}

      {/* Then the table behind the routing decision: which node is a usable egress right now. */}
      {egressView && <EgressCard view={egressView} />}
      {egressView !== null && egress.backgroundError !== null && (
        <p className="resource-freshness"><span className="red-text">最近一次刷新失败，展示上次成功数据</span></p>
      )}
      {!canReadNodes && <p className="resource-freshness">出口质量表需要节点读取权限，当前账号不可见。</p>}
      {canReadNodes && egress.error !== null && egressView === null && (
        <p className="resource-freshness">出口质量表读取失败：{egress.error}</p>
      )}

      {canCreate && (
        <section className="settings-token-form" aria-labelledby="download-create-title">
          <h2 id="download-create-title">拉取构件</h2>
          <label>
            <span>源站地址</span>
            <input type="url" inputMode="url" placeholder="https://example.com/releases/app.tar.gz" value={url} onChange={(event) => setUrl(event.target.value)} disabled={busy} />
          </label>
          <label>
            <span>SHA-256 摘要（可选）</span>
            <input type="text" autoComplete="off" spellCheck={false} placeholder="64 位十六进制" aria-label="SHA-256 摘要（可选）" aria-describedby={digestHelpId} value={digest} onChange={(event) => setDigest(event.target.value)} disabled={busy} />
            <small id={digestHelpId}>填写后整包按此摘要校验，中断后可续传；留空则不校验，也不会续传。</small>
          </label>
          <label>
            <span>接收节点</span>
            <select value={nodeId} onChange={(event) => setNodeId(event.target.value)} disabled={busy || hosts.loading}>
              <option value="">{hosts.loading ? "正在读取节点" : "选择接收节点"}</option>
              {options.map((host: HostMonitoringRecord) => <option key={host.id} value={host.id}>{host.name}</option>)}
            </select>
          </label>
          <label>
            <span>分片并行</span>
            <select value={segmented ? "on" : "off"} onChange={(event) => setSegmented(event.target.value === "on")} disabled={busy}>
              <option value="on">按可用节点分片（最多 4 路）</option>
              <option value="off">单路拉取</option>
            </select>
          </label>
          <label className="settings-reauth-field">
            <span>当前密码</span>
            <input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} disabled={busy} />
          </label>
          {hosts.error && <p className="form-error" role="alert">{hosts.error}</p>}
          {formError && <p className="form-error" role="alert">{formError}</p>}
          <p className="resource-freshness">开始拉取会记录一次重新认证，任务与分片来源写入审计日志。</p>
          <button type="button" disabled={busy || !url.trim() || !nodeId || !password} onClick={() => void submit()}>{busy ? "提交中" : "开始拉取"}</button>
        </section>
      )}
    </ModulePageShell>
  );
}

export { DownloadJobsPage };
