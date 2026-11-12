import { FileText, LockKeyhole, Settings2, Shield } from "lucide-react";
import type { Permission } from "@stackpilot/contracts";
import { settingsPagePreset } from "../app/pagePresets";
import { fetchAuditEvents } from "../api/auditApi";
import { DataTable } from "../components/ui/DataTable";
import { FormLine, ToggleLine } from "../components/ui/FormControls";
import { ApiTokensPanel } from "../features/settings/ApiTokensPanel";
import { SettingsCapabilityState } from "../features/settings/SettingsCapabilityState";
import { SettingsPageFrame } from "../features/settings/SettingsPageFrame";
import { SystemBackupsPanel } from "../features/settings/SystemBackupsPanel";
import { usePollingResource } from "../hooks/usePollingResource";
import type { Notify, PageKey, SetPage, SettingsReadOnlyState } from "../types/app";
import { formatBackendDateTime } from "../utils/time";

function SettingsPage({ page, setPage, notify, readOnlyState, permissions = [] }: {
  page: PageKey; setPage: SetPage; notify: Notify; readOnlyState: SettingsReadOnlyState; permissions?: Permission[];
}) {
  const activeTab = settingsPagePreset(page);
  const { readOnly, setReadOnly } = readOnlyState;
  return <SettingsPageFrame page={page} setPage={setPage} actions={<span className={`settings-mode-indicator ${readOnly || activeTab === "审计" ? "is-readonly" : ""}`}>{readOnly || activeTab === "审计" ? <LockKeyhole size={18} /> : <Settings2 size={18} />}<span><b>{activeTab === "审计" ? "只读审计" : readOnly ? "本会话只读" : "按服务端权限操作"}</b><small>{activeTab === "审计" ? "变更记录不可修改" : "敏感操作需要当前密码"}</small></span></span>}>
    <div className={`settings-page-content settings-layout settings-layout-${activeTab === "基础" ? "general" : activeTab === "安全" ? "security" : activeTab === "通知" ? "notice" : activeTab === "备份" ? "backup" : "audit"}`}>
      {activeTab === "基础" && <>
        <section className="settings-section settings-identity-panel"><header className="settings-section-head"><div><h2>面板身份</h2><p>当前访问环境与客户端版本。</p></div></header><div className="settings-form-grid">
          <FormLine label="面板名称" value="StackPilot" disabled />
          <FormLine label="当前访问地址" value={window.location.origin} disabled />
          <FormLine label="客户端版本" value={__APP_VERSION__} disabled />
          <FormLine label="浏览器时区" value={Intl.DateTimeFormat().resolvedOptions().timeZone} disabled />
        </div><div className="settings-local-preference"><ToggleLine label="本会话只读模式" active={readOnly} onToggle={setReadOnly} hint="限制本会话的前端变更入口，服务端仍独立校验权限。" /></div><SettingsCapabilityState title="面板身份配置暂不可编辑">当前服务未开放面板名称、管理员邮箱与区域偏好的配置接口。</SettingsCapabilityState></section>
        <ApiTokensPanel permissions={permissions} readOnly={readOnly} notify={notify} />
        <SettingsAuditPanel allowed={permissions.includes("audit:read")} setPage={setPage} />
      </>}
      {activeTab === "安全" && <>
        <section className="settings-section"><header className="settings-section-head"><div><h2>安全策略</h2><p>登录保护、会话与来源网络访问边界。</p></div></header><SettingsCapabilityState title="安全策略接口尚未开放">无法读取或保存两步验证、会话时限和 IP 白名单。现有登录认证与访问授权继续由 Controller 执行。</SettingsCapabilityState><div className="settings-form-grid"><FormLine label="两步验证策略" value="暂不可用" disabled /><FormLine label="会话超时时间" value="暂不可用" disabled /><FormLine label="IP 访问白名单" value="暂不可用" disabled /><FormLine label="登录失败锁定" value="暂不可用" disabled /></div><button className="primary" type="button" disabled>保存安全策略</button></section>
        <section className="settings-section"><h2>安全验证</h2><p className="settings-muted">尚无服务端验证结果，MFA 与会话策略状态暂不可用。</p><button className="ghost" type="button" onClick={() => setPage("acl-roles")}>查看角色授权</button></section>
      </>}
      {activeTab === "通知" && <>
        <section className="settings-section"><header className="settings-section-head"><div><h2>通知设置</h2><p>维护通知渠道、事件范围与投递策略。</p></div></header><SettingsCapabilityState title="通知配置暂不可用">当前服务尚未开放通知渠道配置和发送接口。</SettingsCapabilityState><div className="settings-form-grid"><FormLine label="Webhook 通知" value="" hint="尚未读取服务端配置" disabled /><FormLine label="通知收件人" value="" hint="尚未读取服务端配置" disabled /></div><button className="primary" type="button" disabled>保存通知设置</button></section>
        <section className="settings-section"><h2>投递状态</h2><div className="settings-empty"><FileText size={24} /><strong>暂无可查询的投递记录</strong><p>服务端提供投递结果后，将显示真实时间、渠道与结果。</p></div></section>
      </>}
      {activeTab === "备份" && <SystemBackupsPanel notify={notify} permissions={permissions} readOnly={readOnly} />}
      {activeTab === "审计" && <SettingsAuditPanel allowed={permissions.includes("audit:read")} setPage={setPage} />}
    </div>
  </SettingsPageFrame>;
}

function SettingsAuditPanel({ allowed, setPage }: { allowed: boolean; setPage: SetPage }) {
  const audit = usePollingResource((signal) => fetchAuditEvents({}, signal), null, allowed);
  const rows = (audit.data?.events ?? []).filter((event) => /(?:settings|token|backup|identity|role|user|policy|notification)/i.test(event.action));
  return <section className="settings-section settings-audit-section"><header className="settings-section-head"><div><h2>最近配置变更</h2><p>最近返回的审计记录中与设置、授权、令牌和备份相关的操作。</p></div>{allowed && <button className="ghost" type="button" onClick={() => setPage("audit")}>查看审计日志</button>}</header>
    {!allowed ? <SettingsCapabilityState title="设置审计受权限保护">当前角色没有 audit:read 权限。</SettingsCapabilityState> : <>
      {audit.error && !audit.data && <div className="overview-error-state" role="alert"><Shield size={18} /><span>{audit.error}</span><button type="button" onClick={() => void audit.retry()}>重试</button></div>}
      {audit.data && <p className="settings-freshness">后端采集于 {formatBackendDateTime(audit.data.collectedAt)}{audit.backgroundError ? " · 后台读取失败，保留上次记录" : " · 每 10 秒自动查询"}</p>}
      <DataTable columns={[
        { key: "time", label: "时间", width: "160px", render: (row) => formatBackendDateTime(row.occurredAt) },
        { key: "actor", label: "操作人", width: "140px", render: (row) => row.actorId ?? row.actorType },
        { key: "action", label: "操作", render: (row) => <span title={row.action}>{row.action}</span> },
        { key: "source", label: "来源", width: "160px", render: (row) => <code title={row.source}>{row.source}</code> },
        { key: "result", label: "结果", width: "100px", render: (row) => row.outcome },
      ]} rows={rows} emptyText={audit.loading ? "正在读取设置相关审计记录" : audit.error ? "设置审计暂不可用" : "最近返回的审计记录中尚无设置相关操作"} getRowKey={(row) => row.eventId}
        mobileCard={(row) => <><div className="module-card-head"><span className="module-card-title"><FileText size={18} /><b>{row.action}</b></span><span className="pill blue">{row.outcome}</span></div><div className="module-card-meta"><span><b>操作人</b><em>{row.actorId ?? row.actorType}</em></span><span><b>来源</b><em>{row.source}</em></span><span><b>时间</b><em>{formatBackendDateTime(row.occurredAt)}</em></span><span><b>对象</b><em>{row.targetId ?? row.targetType ?? "Controller"}</em></span></div></>} />
    </>}
  </section>;
}

export { SettingsPage };
