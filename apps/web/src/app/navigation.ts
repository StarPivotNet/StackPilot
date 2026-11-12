import { CalendarDays, CloudUpload, Database, FileText, Folder, Globe2, Home, KeyRound, Lock, Server, Settings, Shield, TerminalSquare } from "lucide-react";
import type { NavChild, NavItem, TopbarChrome, TopbarSearchResult } from "../components/layout/types";
import { filesPagePreset } from "../features/files/model";
import { firewallPagePreset } from "../features/firewall/validation";
import { schedulePagePreset } from "../features/schedule/model";
import { sitesPagePreset } from "../features/sites/model";
import { aclPagePreset, auditPagePreset, databasePagePreset, deployPagePreset, settingsPagePreset, systemdPagePreset, terminalPagePreset } from "./pagePresets";
import type { Permission } from "@stackpilot/contracts";
import type { PageKey, PageMeta, ParentPageKey, ViewContext } from "../types/app";

const parentPageKeys = [
  "overview",
  "hosts",
  "sites",
  "databases",
  "files",
  "terminal",
  "ssh",
  "systemd",
  "firewall",
  "deploy",
  "schedule",
  "audit",
  "acl",
  "settings",
] as const;

const pageMeta: Record<string, PageMeta> = {
  overview: { title: "工作台", breadcrumb: "控制台", search: "搜索主机、脚本、风险、提交..." },
  "overview-health": { title: "集群状态", breadcrumb: "工作台", search: "搜索节点、IP、服务、版本..." },
  "overview-tasks": { title: "任务流", breadcrumb: "工作台", search: "搜索设备任务、服务、计划任务..." },
  "overview-risks": { title: "风险中心", breadcrumb: "工作台", search: "搜索风险、主机、对象..." },
  hosts: { title: "主机", breadcrumb: "资源管理", search: "搜索主机名、IP、环境..." },
  sites: { title: "网站", breadcrumb: "应用管理", search: "搜索域名、服务、证书..." },
  "sites-create": { title: "部署站点", breadcrumb: "网站", search: "搜索部署计划..." },
  databases: { title: "数据库管理", breadcrumb: "资源管理", search: "搜索数据库名称" },
  "databases-backups": { title: "备份恢复", breadcrumb: "数据库", search: "搜索备份文件" },
  files: { title: "文件", breadcrumb: "资源管理", search: "搜索文件名、路径、类型..." },
  terminal: { title: "终端", breadcrumb: "运维工具", search: "搜索会话主机或命令..." },
  ssh: { title: "SSH 管理", breadcrumb: "运维工具", search: "搜索 SSH 主机、密钥、策略..." },
  "ssh-host-detail": { title: "SSH 主机详情", breadcrumb: "SSH 管理", search: "搜索 SSH 主机..." },
  "ssh-precheck": { title: "连接预检", breadcrumb: "SSH 管理", search: "搜索 SSH 主机..." },
  "ssh-confirm": { title: "确认托管策略", breadcrumb: "SSH 管理", search: "搜索 SSH 策略..." },
  "ssh-verify": { title: "独立连接验证", breadcrumb: "SSH 管理", search: "搜索 SSH 主机..." },
  "ssh-complete": { title: "托管结果", breadcrumb: "SSH 管理", search: "搜索 SSH 主机..." },
  "ssh-rollback": { title: "回滚结果", breadcrumb: "SSH 管理", search: "搜索 SSH 主机..." },
  "ssh-issue": { title: "签发凭据", breadcrumb: "SSH 管理", search: "搜索 SSH 密钥..." },
  "ssh-revoke": { title: "撤销凭据", breadcrumb: "SSH 管理", search: "搜索 SSH 密钥..." },
  systemd: { title: "systemd 服务", breadcrumb: "系统管理", search: "搜索服务、主机、状态..." },
  firewall: { title: "防火墙", breadcrumb: "安全管理", search: "搜索端口、协议、来源..." },
  deploy: { title: "部署", breadcrumb: "发布管理", search: "搜索应用、版本、提交..." },
  schedule: { title: "定时任务", breadcrumb: "自动化", search: "搜索任务名、cron、命令..." },
  audit: { title: "审计日志", breadcrumb: "安全管理", search: "搜索用户、对象、trace id..." },
  acl: { title: "权限", breadcrumb: "安全管理", search: "搜索用户、角色、权限..." },
  settings: { title: "面板设置", breadcrumb: "设置", search: "搜索主机、网站、数据库、文件..." },
  "settings-general": { title: "基础设置", breadcrumb: "设置", search: "搜索基础设置..." },
  "settings-security": { title: "安全策略", breadcrumb: "设置", search: "搜索安全设置..." },
  "settings-proxy": { title: "代理设置", breadcrumb: "设置", search: "搜索代理设置..." },
  "settings-notice": { title: "通知设置", breadcrumb: "设置", search: "搜索通知设置..." },
  "settings-backup": { title: "备份策略", breadcrumb: "设置", search: "搜索备份策略..." },
  "settings-audit": { title: "设置审计", breadcrumb: "设置", search: "搜索设置变更..." },
  mobile: { title: "移动端", breadcrumb: "控制台", search: "搜索移动端模块..." },
};

const navItems: NavItem[] = [
  // One shared navigation model supplies desktop, mobile and global search.
  {
    key: "overview",
    label: "工作台",
    icon: Home,
    children: [
      { id: "overview-health", label: "集群状态", meta: "实时采样", page: "overview-health" },
      { id: "overview-tasks", label: "任务流", meta: "设备任务", page: "overview-tasks" },
      { id: "overview-risks", label: "风险中心", meta: "实时风险", page: "overview-risks" },
    ],
  },
  {
    key: "hosts",
    label: "主机",
    icon: Server,
    children: [
      { id: "hosts-prod", label: "生产环境", meta: "按环境筛选" },
      { id: "hosts-alert", label: "健康告警", meta: "按状态筛选" },
    ],
  },
  {
    key: "sites",
    label: "网站",
    icon: Globe2,
    children: [
      { id: "sites-create", label: "部署站点", meta: "Git 计划" },
      { id: "sites-running", label: "运行中站点", meta: "站点列表" },
      { id: "sites-cert", label: "证书续期", meta: "续期检查" },
      { id: "sites-runtime", label: "服务分组", meta: "Node / PHP" },
    ],
  },
  {
    key: "databases",
    label: "数据库",
    icon: Database,
    children: [
      { id: "databases-instances", label: "实例列表", meta: "资源列表" },
      { id: "databases-backups", label: "备份恢复", meta: "文件管理" },
      { id: "databases-slow", label: "慢查询", meta: "查询分析" },
    ],
  },
  {
    key: "files",
    label: "文件",
    icon: Folder,
    children: [
      { id: "files-www", label: "受管目录", meta: "虚拟根 /" },
      { id: "files-upload", label: "上传队列", meta: "传输记录" },
      { id: "files-trash", label: "回收站", meta: "7 天保留" },
    ],
  },
  {
    key: "terminal",
    label: "终端",
    icon: TerminalSquare,
    children: [
      { id: "terminal-sessions", label: "会话列表", meta: "在线会话" },
      { id: "terminal-snippets", label: "常用命令", meta: "命令片段" },
      { id: "terminal-history", label: "执行历史", meta: "历史记录" },
    ],
  },
  {
    key: "ssh",
    label: "SSH 管理",
    icon: KeyRound,
    children: [
      { id: "ssh-hosts", label: "主机托管", meta: "只读能力状态" },
      { id: "ssh-keys", label: "凭据与密钥", meta: "凭据管理" },
      { id: "ssh-policies", label: "访问策略", meta: "主机与账号范围" },
      { id: "ssh-audit", label: "访问审计", meta: "SSH 操作记录" },
      { id: "ssh-rescue", label: "救援与恢复", meta: "恢复边界" },
    ],
  },
  {
    key: "systemd",
    label: "systemd 服务",
    icon: Settings,
    children: [
      { id: "systemd-active", label: "Active 服务", meta: "服务列表" },
      { id: "systemd-failed", label: "Failed 服务", meta: "异常服务" },
      { id: "systemd-logs", label: "服务日志", meta: "实时追踪" },
    ],
  },
  {
    key: "firewall",
    label: "防火墙",
    icon: Shield,
    children: [
      { id: "firewall-rules", label: "规则列表", meta: "规则管理" },
      { id: "firewall-open", label: "开放端口", meta: "端口视图" },
      { id: "firewall-deny", label: "拦截记录", meta: "拒绝记录" },
    ],
  },
  {
    key: "deploy",
    label: "部署",
    icon: CloudUpload,
    children: [
      { id: "deploy-prod", label: "生产发布", meta: "发布队列" },
      { id: "deploy-staging", label: "预发环境", meta: "预发布" },
      { id: "deploy-rollbacks", label: "版本记录", meta: "发布历史" },
    ],
  },
  {
    key: "schedule",
    label: "定时任务",
    icon: CalendarDays,
    children: [
      { id: "schedule-enabled", label: "启用任务", meta: "任务列表" },
      { id: "schedule-failed", label: "失败任务", meta: "失败记录" },
      { id: "schedule-calendar", label: "执行日历", meta: "日历视图" },
    ],
  },
  {
    key: "audit",
    label: "审计日志",
    icon: FileText,
    children: [
      { id: "audit-all", label: "全部日志", meta: "只读" },
      { id: "audit-failed", label: "失败操作", meta: "失败记录" },
      { id: "audit-export", label: "导出记录", meta: "CSV / JSON" },
    ],
  },
  {
    key: "acl",
    label: "权限",
    icon: Lock,
    children: [
      { id: "acl-users", label: "用户", meta: "用户列表" },
      { id: "acl-roles", label: "角色", meta: "角色列表" },
      { id: "acl-policies", label: "权限项", meta: "权限清单" },
    ],
  },
  {
    key: "settings",
    label: "设置",
    icon: Settings,
    children: [
      { id: "settings-general", label: "基础设置", meta: "面板偏好" },
      { id: "settings-security", label: "安全策略", meta: "MFA / 白名单" },
      { id: "settings-backup", label: "备份策略", meta: "S3 / MinIO" },
      { id: "settings-proxy", label: "代理设置", meta: "HTTP / NO_PROXY" },
      { id: "settings-notice", label: "通知设置", meta: "Webhook / 邮件" },
      { id: "settings-audit", label: "设置审计", meta: "配置变更" },
    ],
  },
];

const overviewChildPages: Partial<Record<PageKey, string>> = {
  "overview-health": "overview-health",
  "overview-tasks": "overview-tasks",
  "overview-risks": "overview-risks",
};

function navPageFor(page: PageKey): ParentPageKey {
  if (page === "ssh" || page.startsWith("ssh-")) return "ssh";
  if ((parentPageKeys as readonly string[]).includes(page)) return page as ParentPageKey;
  const childParent = navItems.find((item) => item.children.some((child) => (child.page ?? child.id) === page));
  return childParent?.key ?? (overviewChildPages[page] ? "overview" : "overview");
}

function activeChildForPage(page: PageKey) {
  const exactChild = navItems.flatMap((item) => item.children).find((child) => (child.page ?? child.id) === page);
  return exactChild?.id;
}

function navChildMetaText(child: NavChild) {
  if (!child.meta) return "";
  if (!child.badge) return child.meta;
  const escapedBadge = child.badge.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return child.meta.replace(new RegExp(`^${escapedBadge}\\s*(个|条|项|台|人|组|风险|待执行)?\\s*`), "").trim();
}

function activeNavEntryForPage(page: PageKey) {
  const parentKey = navPageFor(page);
  const parent = navItems.find((item) => item.key === parentKey);
  const child = parent?.children.find((item) => (item.page ?? item.id) === page);
  return { parent, child };
}

function desktopTopbarChrome(page: PageKey): TopbarChrome {
  void page; // Keep the route-aware call signature; CloudPulse uses shared chrome.
  return {
    white: true,
    showBreadcrumb: true,
    showCompactSearch: true,
    showStatus: true,
    showActivity: true,
  };
}

function navItemsForPermissions(permissions: readonly Permission[]) {
  return navItems.reduce<NavItem[]>((visible, item) => {
    if (item.key === "ssh" && !permissions.includes("nodes:read")) return visible;
    if (item.key === "files" && !permissions.includes("files:read")) return visible;
    if (item.key === "systemd" && !permissions.includes("systemd:read")) return visible;
    if (item.key === "schedule" && !permissions.includes("schedules:read")) return visible;
    if (item.key === "firewall" && !permissions.includes("firewall:read")) return visible;
    if (item.key === "audit" && !permissions.includes("audit:read")) return visible;
    if (item.key === "audit") return [...visible, { ...item, children: item.children.filter((child) => child.id !== "audit-export" || permissions.includes("audit:export")) }];
    if (item.key === "databases" && !permissions.includes("databases:read")) return visible;
    if (item.key === "deploy" && !permissions.includes("sites:read")) return visible;
    if (item.key === "sites") {
      return [...visible, { ...item, children: item.children.filter((child) => child.id !== "sites-create" || permissions.includes("sites:deploy")) }];
    }
    if (item.key !== "databases") return [...visible, item];
    const children = item.children.filter((child) => {
      if (child.id === "databases-backups") return permissions.includes("databases:backup");
      return true;
    });
    return [...visible, { ...item, children }];
  }, []);
}

function topbarSearchResults(query: string, permissions: readonly Permission[] = []): TopbarSearchResult[] {
  const normalized = query.trim().toLowerCase();
  const entries: TopbarSearchResult[] = navItemsForPermissions(permissions).flatMap((item) => [
    { id: item.key, label: item.label, detail: resolvePageMeta(item.key).breadcrumb, page: item.key, kind: "模块" },
    ...item.children.map((child) => ({
      id: child.page ?? child.id,
      label: `${item.label} / ${child.label}`,
      detail: child.meta,
      page: child.page ?? child.id,
      kind: "入口",
    })),
  ]);
  const quickActions: TopbarSearchResult[] = [
    { id: "quick-create-host", label: "新增主机", detail: "打开主机新增页", page: "hosts", kind: "动作" },
    { id: "quick-open-terminal", label: "开启终端", detail: "进入终端会话", page: "terminal", kind: "动作" },
    ...(permissions.includes("firewall:read") && permissions.includes("firewall:operate") ? [{ id: "quick-create-rule", label: "新增防火墙规则", detail: "打开防火墙规则列表", page: "firewall", kind: "动作" } satisfies TopbarSearchResult] : []),
    ...(permissions.includes("audit:read") && permissions.includes("audit:export") ? [{ id: "quick-audit-export", label: "导出审计日志", detail: "进入审计导出记录", page: "audit-export", kind: "动作" } satisfies TopbarSearchResult] : []),
  ];
  const allEntries = [...entries, ...quickActions.filter((item) => item.page !== "audit-export" || permissions.includes("audit:read"))];
  if (!normalized) return allEntries.slice(0, 6);
  return allEntries
    .filter((item) => `${item.label} ${item.detail} ${item.kind}`.toLowerCase().includes(normalized))
    .slice(0, 7);
}

function viewContextForPage(page: PageKey): ViewContext | null {
  const { parent, child } = activeNavEntryForPage(page);
  if (!parent) return null;
  const eyebrow = child ? `${parent.label} / ${child.label}` : `${parent.label} / 默认视图`;
  const title = child ? child.label : parent.label;
  const baseChip = child?.meta ?? "全部";

  switch (parent.key) {
    case "overview":
      return { eyebrow, title, chips: [baseChip] };
    case "hosts":
      return null;
    case "sites": {
      const preset = sitesPagePreset(page);
      const chips = [`状态 ${preset.status}`, `服务 ${preset.runtime}`];
      if (page === "sites-cert") chips.push("证书 < 14 天");
      return { eyebrow, title, chips };
    }
    case "databases": {
      const preset = databasePagePreset(page);
      return { eyebrow, title, chips: [`类型 ${preset.type}`, `状态 ${preset.status}`, `主机 ${preset.host}`] };
    }
    case "files": {
      const preset = filesPagePreset(page);
      return { eyebrow, title, chips: [`路径 ${preset.path}`, `类型 ${preset.type}`] };
    }
    case "terminal": {
      const preset = terminalPagePreset(page);
      return { eyebrow, title, chips: [`面板 ${preset.panel === "sessions" ? "会话" : preset.panel === "snippets" ? "常用命令" : "执行历史"}`] };
    }
    case "systemd": {
      const preset = systemdPagePreset(page);
      return { eyebrow, title, chips: [`状态 ${preset.status}`] };
    }
    case "firewall": {
      const preset = firewallPagePreset(page);
      return { eyebrow, title, chips: [`协议 ${preset.protocol}`, `来源 ${preset.source}`] };
    }
    case "deploy": {
      const preset = deployPagePreset(page);
      return { eyebrow, title, chips: [`环境 ${preset.env}`, `模式 ${preset.mode === "rollbacks" ? "回滚" : "任务"}`] };
    }
    case "schedule": {
      const preset = schedulePagePreset(page);
      return { eyebrow, title, chips: [`状态 ${preset.state}`, `模式 ${preset.mode === "calendar" ? "日历" : "列表"}`] };
    }
    case "audit": {
      const preset = auditPagePreset(page);
      return { eyebrow, title, chips: [`操作者 ${preset.user}`, `结果 ${preset.result}`, `模式 ${preset.mode === "exports" ? "导出" : "日志"}`] };
    }
    case "acl": {
      const preset = aclPagePreset(page);
      const viewName = preset.tab === "users" ? "用户" : preset.tab === "roles" ? "角色" : "权限项";
      return { eyebrow, title, chips: [`视图 ${viewName}`] };
    }
    case "settings": {
      if (page === "settings-proxy") {
        return { eyebrow, title, chips: ["代理节点", "路由规则", "NO_PROXY"] };
      }
      const tab = settingsPagePreset(page);
      return { eyebrow, title, chips: [`Tab ${tab}`] };
    }
    default:
      return { eyebrow, title, chips: [baseChip] };
  }
}

function resolvePageMeta(page: PageKey): PageMeta {
  const direct = pageMeta[page];
  if (direct) return direct;
  const parent = navItems.find((item) => item.children.some((child) => (child.page ?? child.id) === page));
  const child = parent?.children.find((item) => (item.page ?? item.id) === page);
  if (parent && child) {
    return {
      title: child.label,
      breadcrumb: parent.label,
      search: pageMeta[parent.key].search,
    };
  }
  return pageMeta.overview;
}

export { parentPageKeys, pageMeta, navItems, navItemsForPermissions, overviewChildPages, navPageFor, activeChildForPage, navChildMetaText, activeNavEntryForPage, desktopTopbarChrome, topbarSearchResults, viewContextForPage, resolvePageMeta };
