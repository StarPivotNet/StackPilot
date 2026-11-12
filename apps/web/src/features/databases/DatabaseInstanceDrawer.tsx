import { Clock3, Copy, Database, LockKeyhole, Power, Users } from "lucide-react";
import { useState } from "react";
import type { DatabaseOperationPlan, Permission } from "@stackpilot/contracts";
import { createDatabaseOperationPlan, fetchDatabaseDetail } from "../../api/databasesApi";
import { DetailDrawer } from "../../components/ui/DetailDrawer";
import type { DatabaseInstance } from "./types";
import { usePollingResource } from "../../hooks/usePollingResource";
import { DatabasePlanDialog } from "./DatabasePlanDialog";
import { formatBackendDateTime } from "../../utils/time";

export function DatabaseInstanceDrawer({ instance, permissions, onClose, onCopy, notify }: { instance: DatabaseInstance; permissions: Permission[]; onClose: () => void; onCopy: () => void; notify: (message: string, tone?: "success" | "info" | "warning" | "danger") => void }) {
  const { data: loadedData, loading, error, retry, refresh } = usePollingResource((signal) => fetchDatabaseDetail(instance.id, signal), null, true, instance.id);
  const data = loadedData?.instance.id === instance.id ? loadedData : null;
  const [plan, setPlan] = useState<DatabaseOperationPlan | null>(null); const [planning, setPlanning] = useState(false);
  const createPlan = async (input: Parameters<typeof createDatabaseOperationPlan>[0]) => {
    setPlanning(true); try { setPlan((await createDatabaseOperationPlan(input)).plan); } catch (caught) { notify(caught instanceof Error ? caught.message : "无法创建操作计划", "danger"); } finally { setPlanning(false); }
  };
  const canOperate = permissions.includes("databases:operate");
  return <><DetailDrawer className="database-instance-drawer" title="数据库详情" subtitle={instance.name} modal onClose={onClose} actions={instance.port !== "待采集" ? <button className="ghost" type="button" onClick={onCopy}><Copy size={15} /> 复制端点</button> : undefined}>
    {loading && !data && <p role="status">正在读取实例详情...</p>}
    {error && !data && <div className="overview-error-state"><span>{error}</span><button type="button" onClick={() => void retry()}>重试</button></div>}
    {data && <div className="database-detail">
      <div className="database-detail-grid"><p><span>引擎</span><b>{instance.engine}</b></p><p><span>节点</span><b>{instance.nodeName}</b></p><p><span>端点</span><b>{instance.host}:{instance.port}</b></p><p><span>版本</span><b>{data.instance.version ?? "暂不可用"}</b></p><p><span>访问模式</span><b>{instance.access}</b></p><p><span>运行状态</span><b>{instance.connectionHealth}</b></p><p><span>存储</span><b>{instance.storage}</b></p><p><span>连接</span><b>{instance.connections}</b></p><p><span>备份</span><b>{instance.backupStatus}</b></p><p><span>延迟</span><b>{instance.latency}</b></p><p><span>服务来源</span><b>{data.instance.source}</b></p><p><span>采集时间</span><b>{formatBackendDateTime(data.instance.collectedAt)}</b></p><p><span>管理边界</span><b>{data.instance.managed ? "StackPilot 受管" : "外部实例"}</b></p></div>
      {canOperate && <div className="database-detail-actions"><button type="button" disabled={planning} onClick={() => void createPlan({ kind: data.instance.accessMode === "read-only" ? "set-read-write" : "set-read-only", instanceId: instance.id })}><LockKeyhole size={14} /> {data.instance.accessMode === "read-only" ? "恢复读写" : "切换只读"}</button></div>}
      <section className="database-detail-section"><h3><Users size={16} /> 活跃会话</h3>{data.sessions.length ? data.sessions.map((session) => <article key={session.id}><div><b>{session.username ?? "未知用户"}</b><span>{session.database ?? "未知数据库"} · {session.applicationName ?? "未知应用"}</span><small><Clock3 size={12} />{formatBackendDateTime(session.startedAt, "开始时间不可用")}</small></div>{canOperate && <button type="button" disabled={planning || session.protected} title={session.protectedReason ?? undefined} onClick={() => void createPlan({ kind: "terminate-session", instanceId: instance.id, sessionId: session.id })}><Power size={14} />终止</button>}</article>) : <p>当前没有可见会话</p>}</section>
      <section className="database-detail-section"><h3><Database size={16} /> 近期慢查询</h3>{data.recentQueries.length ? data.recentQueries.map((query) => <code key={query.id}>{query.sql ?? `${query.fingerprint}（无权查看完整 SQL）`}</code>) : <p>当前没有近期慢查询</p>}</section>
    </div>}
  </DetailDrawer>{plan && <DatabasePlanDialog plan={plan} onClose={() => setPlan(null)} onComplete={() => { setPlan(null); notify("数据库操作已完成", "success"); void refresh(); }} />}</>;
}
