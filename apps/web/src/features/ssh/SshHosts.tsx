import { ArrowRight, Eye, FileKey2, LockKeyhole, Server, Shield } from "lucide-react";
import { useEffect } from "react";
import type { HostMonitoringRecord } from "../../api/hostsApi";
import { DataTable } from "../../components/ui/DataTable";
import { DetailDrawer } from "../../components/ui/DetailDrawer";
import { formatBackendDateTime } from "../../utils/time";
import { sshConnectionLabel } from "./model";
import { SshDefinition, SshNote, SshPanel, SshWaiting } from "./SshPrimitives";
import type { SshWorkspace } from "./useSshWorkspace";

export function SshHostFreshness({ workspace }: { workspace: SshWorkspace }) {
  return <span className="ssh-freshness">资源目录采集于 {formatBackendDateTime(workspace.resource.data?.collectedAt, "等待后端时间")}<span>SSH 保护证据：等待接入</span></span>;
}

export function SshOverview({ workspace }: { workspace: SshWorkspace }) {
  const { resource, hosts, navigate } = workspace;
  return <>
    <section className="ssh-metrics" aria-label="SSH 接入概览">
      <article><Server size={20} aria-hidden="true" /><span>资源目录主机</span><strong>{resource.data ? hosts.length : "—"}</strong><small>实际资源数量，不代表已接管</small></article>
      <article><Shield size={20} aria-hidden="true" /><span>当前托管保护</span><strong className="ssh-metric-label">尚未核验</strong><small>等待主机端真实保护证据</small></article>
      <article><FileKey2 size={20} aria-hidden="true" /><span>平台有效凭据</span><strong className="ssh-metric-label">等待接入</strong><small>未读取到签发服务</small></article>
      <article><LockKeyhole size={20} aria-hidden="true" /><span>当前 SSH 会话</span><strong className="ssh-metric-label">等待接入</strong><small>未取得会话归因数据</small></article>
    </section>
    <section className="ssh-section"><div className="ssh-section-heading"><div><h2>准备托管范围</h2><p>从真实主机目录选择目标，保留账号与操作者的明确边界。</p></div><button className="ssh-button ssh-button-ghost" type="button" onClick={() => navigate("ssh-hosts", null)}>查看主机 <ArrowRight size={16} /></button></div><HostDirectory workspace={workspace} compact /></section>
    <div className="ssh-columns"><SshPanel title="平台签发与范围校验"><SshDefinition items={[["允许的凭据", "平台签发的短期 SSH 用户证书"], ["授权范围", "主机 + Linux 账号 + 操作者"], ["交付材料", "专用私钥、公钥、用户证书与连接配置"], ["CA 私钥", "保留在签发服务，不向用户下发"]]} /><button className="ssh-button ssh-button-ghost" type="button" onClick={() => navigate("ssh-policies")}>查看授权策略</button></SshPanel><SshPanel title="恢复与保证边界"><p className="ssh-body-small">预检、备份、独立新连接及负向验证都需要后端证据。root 或云控制台仍能修改主机；失联或证据过期时只能显示保护状态未知。</p><button className="ssh-button ssh-button-ghost" type="button" onClick={() => navigate("ssh-rescue")}>查看救援条件</button></SshPanel></div>
  </>;
}

export function HostDirectory({ workspace, compact = false }: { workspace: SshWorkspace; compact?: boolean }) {
  const { hosts, resource, search, environment, openDetail } = workspace;
  const query = search.trim().toLocaleLowerCase();
  const filtered = hosts.filter((host) => (!query || `${host.name} ${host.address ?? ""} ${host.owner}`.toLocaleLowerCase().includes(query)) && (environment === "全部环境" || host.environment === environment));
  const rows = compact ? filtered.slice(0, 4) : filtered;
  const hostIdentity = (host: HostMonitoringRecord) => <div className="ssh-host-identity"><strong className="ssh-host-name" title={host.name}>{host.name}</strong><span>{host.platform === "linux" ? "Linux" : host.platform} · {host.owner}</span></div>;
  const actions = (host: HostMonitoringRecord, view = "desktop") => <button className="ssh-button ssh-button-ghost ssh-host-detail-action" type="button" data-ssh-detail-host={host.id} data-ssh-detail-view={view} aria-label={`查看 ${host.name} 的 SSH 托管详情`} onClick={() => openDetail(host.id, view)}><Eye size={16} aria-hidden="true" />详情</button>;
  const empty = resource.loading ? "正在读取真实资源目录…" : resource.error ? "资源目录暂不可用，未显示示例主机。" : query || environment !== "全部环境" ? "没有匹配的主机，请调整筛选条件。" : "资源目录尚无主机，系统将继续自动读取。";
  return <div className="ssh-host-list">
    {resource.error && !resource.data && <div className="ssh-load-error" role="alert"><Shield size={20} aria-hidden="true" /><span>{resource.error}</span><button className="ssh-button ssh-button-ghost" type="button" onClick={() => void resource.retry()}>重试</button></div>}
    {resource.backgroundError && resource.data && <p className="ssh-body-small" role="status">资源目录更新暂时中断，保留上次采集结果与时间。</p>}
    <DataTable columns={[
      { key: "name", label: "主机", width: "26%", render: hostIdentity },
      { key: "address", label: "地址 / 环境", width: "22%", render: (host) => <div className="ssh-host-identity"><code title={host.address ?? "地址未提供"}>{host.address ?? "地址未提供"}</code><span>{host.environment}</span></div> },
      { key: "connection", label: "资源连接", width: "14%", render: (host) => <span className="ssh-resource-state">{sshConnectionLabel(host)}</span> },
      { key: "ssh", label: "SSH 托管", width: "24%", render: () => <SshWaiting>尚未启用</SshWaiting> },
      { key: "action", label: "操作", width: "14%", render: (host) => actions(host) },
    ]} rows={rows} getRowKey={(host) => host.id} emptyText={empty} mobileCard={(host) => <><header className="ssh-mobile-host-heading">{hostIdentity(host)}<SshWaiting>尚未启用</SshWaiting></header><code className="ssh-host-address">{host.address ?? "地址未提供"}</code><div className="ssh-mobile-host-meta"><span>{host.environment}</span><span>{sshConnectionLabel(host)}</span></div><footer>{actions(host, "mobile")}</footer></>} />
    <div className="ssh-directory-footer"><span>{resource.data ? `${filtered.length} 台匹配资源${compact && filtered.length > 4 ? "，展示前 4 台" : ""}` : "等待资源目录"}</span><SshHostFreshness workspace={workspace} /></div>
  </div>;
}

export function SshHosts({ workspace, detail }: { workspace: SshWorkspace; detail: boolean }) {
  const { hosts, hostId, resource, search, setSearch, environment, setEnvironment, navigate } = workspace;
  const selected = hosts.find((host) => host.id === hostId) ?? null;
  const opened = detail && selected !== null;
  useEffect(() => {
    if (!opened) return;
    const oldOverflow = document.body.style.overflow;
    const oldPadding = document.body.style.paddingRight;
    const gutter = document.documentElement.clientWidth ? Math.max(0, window.innerWidth - document.documentElement.clientWidth) : 0;
    if (gutter) document.body.style.paddingRight = `${(Number.parseFloat(getComputedStyle(document.body).paddingRight) || 0) + gutter}px`;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = oldOverflow; document.body.style.paddingRight = oldPadding; };
  }, [opened]);
  return <>
    <div className="ssh-filter-row"><label className="ssh-search-field"><span>搜索主机</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="主机名、IP 或负责人" /></label><label className="ssh-select-field"><span>环境</span><select value={environment} onChange={(event) => setEnvironment(event.target.value)}><option>全部环境</option>{[...new Set(hosts.map((host) => host.environment))].sort().map((item) => <option key={item}>{item}</option>)}</select></label><button className="ssh-button ssh-button-primary" type="button" onClick={() => navigate("ssh-precheck", hostId)}>准备接管草稿</button></div>
    {detail && hostId && resource.data && !selected && <SshNote title="原目标已不在资源目录，详情已关闭">未切换到其他主机。请返回清单选择可用目标。<button className="ssh-button ssh-button-ghost" type="button" onClick={() => navigate("ssh-hosts", null)}>返回主机清单</button></SshNote>}
    {detail && !hostId && <SshNote title="尚未选择目标主机">从资源目录选择主机后再查看身份与接入条件。</SshNote>}
    <HostDirectory workspace={workspace} />
    <SshNote title="资源在线不等于 SSH 已验证">当前仅有资源目录数据，尚未取得 SSH 主机指纹、认证来源、有效配置或平台证书验证结果。</SshNote>
    {opened && <DetailDrawer title={selected.name} subtitle={`${selected.address ?? "地址未提供"} · ${selected.environment}`} className="ssh-host-drawer" modal closeLabel="关闭 SSH 主机详情" onClose={workspace.closeDetail} actions={<button className="ssh-button ssh-button-ghost" type="button" onClick={() => navigate("ssh-precheck", selected.id)}>准备此主机草稿</button>}><SshWaiting>SSH 托管尚未启用</SshWaiting><SshDefinition items={[["稳定主机 ID", <code>{selected.id}</code>], ["资源地址", selected.address ?? "未提供"], ["平台", selected.platform], ["负责人", selected.owner], ["资源连接", sshConnectionLabel(selected)], ["资源采集时间", formatBackendDateTime(selected.telemetryCollectedAt ?? resource.data?.collectedAt)], ["SSH 主机指纹", "等待后端预检"], ["平台 CA / principal", "等待授权与验证"], ["当前保护证据", "尚未取得，不能确认托管保护"], ["策略 / 吊销版本", "等待后端接入"]]} /><SshNote title="只作用于托管 SSH 入口">拥有 root 或云控制台权限的人仍可能修改配置；额外入口、失联或证据过期都需独立判断。</SshNote></DetailDrawer>}
  </>;
}
