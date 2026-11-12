import type { FirewallExposure, FirewallOpenPort, Permission } from "@stackpilot/contracts";
import { CircleAlert, Clock3, Globe2, Network, RadioTower, Server, ShieldCheck } from "lucide-react";
import { useMemo, useState } from "react";
import { resolvePageMeta } from "../../app/navigation";
import { ModulePageShell } from "../../components/layout/ModulePageShell";
import { MetricTile, ModuleSearch } from "../../components/ui/Cards";
import { DataTable } from "../../components/ui/DataTable";
import { FieldSelect } from "../../components/ui/FormControls";
import { formatBackendDateTime } from "../../utils/time";
import { useFirewallOpenPorts } from "./useFirewallOpenPorts";
import { SecurityModuleTabs } from "../../components/layout/SecurityModuleTabs";

const exposureMeta: Record<FirewallExposure, { label: string; tone: string }> = {
  public: { label: "公网绑定", tone: "orange" },
  private: { label: "私网绑定", tone: "blue" },
  loopback: { label: "仅本机", tone: "green" },
  specific: { label: "指定地址", tone: "blue" },
};

function Endpoint({ row }: { row: FirewallOpenPort }) {
  return <code title={`${row.address}:${row.port}`}>{row.address.includes(":") ? `[${row.address}]:${row.port}` : `${row.address}:${row.port}`}</code>;
}

export function FirewallOpenPortsPage({ permissions }: { permissions: Permission[] }) {
  const allowed = permissions.includes("firewall:read");
  const { data, loading, error, backgroundError, retry } = useFirewallOpenPorts(allowed);
  const [search, setSearch] = useState("");
  const [protocol, setProtocol] = useState("全部");
  const [exposure, setExposure] = useState("全部");
  const rows = useMemo(() => (data?.ports ?? []).filter((row) => {
    const query = search.trim().toLowerCase();
    return (!query || `${row.port} ${row.address} ${row.host} ${row.source}`.toLowerCase().includes(query))
      && (protocol === "全部" || row.protocol === protocol)
      && (exposure === "全部" || exposureMeta[row.exposure].label === exposure);
  }), [data?.ports, exposure, protocol, search]);

  if (!allowed) return <ModulePageShell title={resolvePageMeta("firewall-open").title} page="firewall-open" className="cloudpulse-security" viewContext={false}>
    <section className="overview-error-state" role="status"><ShieldCheck size={18} /><span>当前角色没有 firewall:read 权限</span></section>
  </ModulePageShell>;
  const warningItems = [...(backgroundError ? [`后台刷新失败，保留上次数据：${backgroundError}`] : []), ...(data?.warnings ?? [])];
  const visibleWarnings = warningItems.length > 3 ? [...warningItems.slice(0, 2), `另有 ${warningItems.length - 2} 条监听端口提示`] : warningItems;

  return <ModulePageShell title={resolvePageMeta("firewall-open").title} subtitle="查看 TCP / UDP 监听地址与访问边界。" page="firewall-open" className="cloudpulse-security" viewContext={false}
    tabs={<SecurityModuleTabs module="firewall" page="firewall-open" />}
    filters={<><ModuleSearch value={search} placeholder="搜索端口、地址或主机" onChange={setSearch} /><FieldSelect label="协议" value={protocol} options={["全部", "TCP", "UDP"]} onChange={setProtocol} /><FieldSelect label="绑定范围" value={exposure} options={["全部", "公网绑定", "私网绑定", "仅本机", "指定地址"]} onChange={setExposure} /></>}
    metrics={<><MetricTile icon={RadioTower} label="监听端口" value={data ? `${data.ports.length}` : "暂不可用"} tone="blue" /><MetricTile icon={Globe2} label="公网绑定" value={data ? `${data.ports.filter((row) => row.exposure === "public").length}` : "暂不可用"} tone="orange" /><MetricTile icon={Network} label="本机 / 私网" value={data ? `${data.ports.filter((row) => row.exposure === "loopback" || row.exposure === "private").length}` : "暂不可用"} tone="green" /></>}>
    {error && !data && <div className="overview-error-state"><CircleAlert size={18} /><span>{error}</span><button type="button" onClick={() => void retry()}>重试</button></div>}
    {data && <div className="systemd-freshness"><Clock3 size={18} /><div><strong>采集时间 {formatBackendDateTime(data.collectedAt)}</strong><span>数据来自 Controller 主机的只读监听快照；监听不等于上游网络已经放行</span></div></div>}
    {visibleWarnings.map((warning) => <p className="database-collection-note" key={warning}><Clock3 size={15} />{warning}</p>)}
    <DataTable columns={[
      { key: "port", label: "端口", width: "90px", render: (row) => <b>{row.port}</b> },
      { key: "protocol", label: "协议", width: "90px", render: (row) => <span className="pill blue">{row.protocol}</span> },
      { key: "endpoint", label: "监听地址", render: (row) => <Endpoint row={row} /> },
      { key: "scope", label: "绑定范围", width: "110px", render: (row) => <span className={`pill ${exposureMeta[row.exposure].tone}`}>{exposureMeta[row.exposure].label}</span> },
      { key: "source", label: "可达来源", width: "120px", render: (row) => row.source },
      { key: "host", label: "主机", width: "160px", render: (row) => <span title={row.host}><Server size={14} /> {row.host}</span> },
    ]} rows={rows} emptyText={loading ? "正在读取真实监听端口" : error && !data ? "真实监听端口读取失败" : data?.collectionStatus === "unavailable" ? "监听端口数据暂不可用" : "没有匹配的真实监听端口"} getRowKey={(row) => row.id}
      mobileCard={(row) => <><div className="module-card-head"><strong>{row.port}/{row.protocol}</strong><span className={`pill ${exposureMeta[row.exposure].tone}`}>{exposureMeta[row.exposure].label}</span></div><div className="module-card-code"><Endpoint row={row} /></div><div className="module-card-meta"><span><b>来源</b><em>{row.source}</em></span><span><b>主机</b><em>{row.host}</em></span></div></>} />
  </ModulePageShell>;
}
