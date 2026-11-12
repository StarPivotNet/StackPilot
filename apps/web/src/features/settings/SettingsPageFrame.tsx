import { resolvePageMeta } from "../../app/navigation";
import { settingsPagePreset } from "../../app/pagePresets";
import { ModulePageShell } from "../../components/layout/ModulePageShell";
import type { PageKey, SetPage } from "../../types/app";
import { SettingsTabs } from "./SettingsTabs";

const settingsCopy: Record<string, { subtitle: string }> = {
  "settings-general": {
    subtitle: "查看面板环境、管理访问令牌与操作记录。",
  },
  "settings-proxy": {
    subtitle: "查看出口代理、路由规则与运行时配置能力。",
  },
  "settings-security": {
    subtitle: "集中维护登录保护、会话边界和来源网络访问策略。",
  },
  "settings-notice": {
    subtitle: "配置事件范围、通知渠道和投递策略，并核对最近投递结果。",
  },
  "settings-backup": {
    subtitle: "管理 Controller 控制面数据的系统备份、完整性校验与隔离恢复演练。",
  },
  "settings-audit": {
    subtitle: "只读查看设置变更，快速定位操作人、来源地址和具体修改内容。",
  },
};

function SettingsPageFrame({
  page,
  setPage,
  inert,
  actions,
  filters,
  metrics,
  side,
  sideModal,
  children,
}: {
  page: PageKey;
  setPage: SetPage;
  inert?: boolean;
  actions?: React.ReactNode;
  filters?: React.ReactNode;
  metrics?: React.ReactNode;
  side?: React.ReactNode;
  sideModal?: boolean;
  children: React.ReactNode;
}) {
  const copy = settingsCopy[page] ?? settingsCopy["settings-general"];
  return (
    <ModulePageShell
      title={resolvePageMeta(page).title}
      subtitle={copy.subtitle}
      page={page}
      className="settings-page"
      viewContext={false}
      tabs={<SettingsTabs activeTab={settingsPagePreset(page)} setPage={setPage} inert={inert} />}
      actions={actions}
      filters={filters}
      metrics={metrics}
      side={side}
      sideModal={sideModal}
    >
      {children}
    </ModulePageShell>
  );
}

export { SettingsPageFrame };
