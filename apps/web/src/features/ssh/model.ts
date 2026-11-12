import type { HostMonitoringRecord } from "../../api/hostsApi";

export const SSH_DISABLED_REASON = "SSH 托管服务尚未启用。当前仅可查看资源目录和编辑本页草稿，不会修改主机、签发凭据或执行 SSH 登录。";
export const SSH_BACKEND_CAPABILITY = Object.freeze({ available: false, authorized: false, verifiedEvidence: false });

export const sshTabs = [
  { page: "ssh", title: "托管总览" },
  { page: "ssh-hosts", title: "托管主机" },
  { page: "ssh-keys", title: "凭据与证书" },
  { page: "ssh-policies", title: "授权策略" },
  { page: "ssh-audit", title: "SSH 审计" },
] as const;

export const sshPageMeta: Record<string, { title: string; description: string; active: string }> = {
  ssh: { title: "SSH 管理", description: "统一管理 SSH 入口、平台证书与登录授权。", active: "ssh" },
  "ssh-hosts": { title: "托管主机", description: "从真实资源目录准备接管范围，SSH 托管状态等待后端核验。", active: "ssh-hosts" },
  "ssh-host-detail": { title: "托管主机", description: "按稳定主机 ID 查看资源身份与 SSH 接入条件。", active: "ssh-hosts" },
  "ssh-keys": { title: "凭据与证书", description: "按操作者与主机范围管理短期 SSH 用户证书。", active: "ssh-keys" },
  "ssh-policies": { title: "授权策略", description: "将登录授权同时绑定到主机、Linux 账号与操作者。", active: "ssh-policies" },
  "ssh-audit": { title: "SSH 审计", description: "追溯接管、凭据生命周期、新连接验证与救援操作。", active: "ssh-audit" },
  "ssh-precheck": { title: "接管前预检", description: "先准备目标与恢复草稿，再由后端执行真实来源盘点。", active: "ssh-hosts" },
  "ssh-confirm": { title: "确认接管策略", description: "审查计划中的认证收敛与恢复条件；当前草稿尚未应用。", active: "ssh-hosts" },
  "ssh-verify": { title: "验证新的 SSH 登录", description: "全新连接、负向验证与有效配置证据全部通过后才能提交。", active: "ssh-hosts" },
  "ssh-complete": { title: "接管结果", description: "只有真实验证与提交证据才能形成已托管结论。", active: "ssh-hosts" },
  "ssh-rollback": { title: "回滚结果", description: "按真实任务核对恢复状态，不将失败或未知状态展示为已恢复。", active: "ssh-hosts" },
  "ssh-issue": { title: "签发与一次性下载", description: "核对操作者、主机、账号和有效期后交付短期凭据。", active: "ssh-keys" },
  "ssh-revoke": { title: "吊销与轮换", description: "将撤销后续登录与终止当前会话分开管理。", active: "ssh-keys" },
  "ssh-rescue": { title: "平台救援凭据", description: "在相同信任体系内恢复受控访问，不另开密码入口。", active: "ssh-hosts" },
};

export type SshDraftKind = "takeover" | "issue" | "policy" | "rescue";
export type SshDraft = { hostId: string; account: string; operator: string; purpose: string; incident: string; minutes: number };
export type SshDraftErrors = Partial<Record<keyof SshDraft, string>>;
export function emptySshDraft(kind: SshDraftKind): SshDraft {
  return { hostId: "", account: "", operator: "", purpose: "", incident: "", minutes: kind === "rescue" ? 15 : 60 };
}
export function validateSshDraft(draft: SshDraft, hosts: HostMonitoringRecord[], kind: SshDraftKind): SshDraftErrors {
  const errors: SshDraftErrors = {};
  const host = hosts.find((row) => row.id === draft.hostId);
  if (!host) errors.hostId = "请选择资源目录中的目标主机；原目标可能已被移除。";
  else if (host.platform !== "linux") errors.hostId = "当前草稿仅支持 Linux 账号，其他平台需等待能力接入。";
  if (!/^[a-z_][a-z0-9_-]{0,31}$/i.test(draft.account.trim())) errors.account = "请输入有效 Linux 账号，使用字母、数字、下划线或连字符。";
  if (!draft.operator.trim()) errors.operator = "请填写待授权的操作者或用户组。";
  if (!draft.purpose.trim()) errors.purpose = "请填写本次访问的用途说明。";
  if (kind === "rescue" && !draft.incident.trim()) errors.incident = "请填写用于关联救援审批的事故编号。";
  if (!Number.isInteger(draft.minutes) || draft.minutes < 1 || draft.minutes > (kind === "rescue" ? 15 : 480)) errors.minutes = "有效期超出当前草稿上限。";
  return errors;
}

/** This front-end does not have an SSH service contract. Form input is never evidence. */
export function sshActionAllowed(capability: { available: boolean; authorized: boolean; verifiedEvidence: boolean }): boolean {
  return capability.available && capability.authorized && capability.verifiedEvidence;
}
export function sshConnectionLabel(host: HostMonitoringRecord): string {
  return ({ local: "本机资源", online: "资源在线", pending: "资源待连接", offline: "资源离线" })[host.connectionStatus];
}
export const sshPreflightItems = [
  ["主机身份与所有 SSH 入口", "核验主机指纹、监听进程、端口和启动参数，不把资源在线当成 SSH 可登录。"],
  ["认证来源逐项盘点", "检查密码、交互式认证、GSSAPI、hostbased、原授权文件、云注入、外部授权命令及非平台 CA。"],
  ["实际生效配置", "检查 Include / Match 与各账号、地址和端口条件下的有效值，不只读取主配置文件。"],
  ["备份与事务保护", "先保存配置与授权来源，准备独立本地回滚；在验证完成前保留可用的原控制通道。"],
  ["恢复路径准备", "核对预置平台签发离线救援包及独立带外恢复是否可用并已演练。"],
] as const;
export const sshVerificationItems = [
  ["目标身份与全新连接", "通过正式地址建立新 TCP / SSH 完整认证并核验主机指纹，禁用连接复用。"],
  ["平台凭据与访问范围", "校验 CA、操作者、主机、Linux 账号、principal、有效期和实际最小权限。"],
  ["旧来源与范围外凭据拒绝", "原公钥、密码、无证书裸公钥、其他 CA 和越权 / 过期证书必须不能新登录。"],
  ["配置收敛与恢复准备", "全部入口与策略一致，备份和本地回滚证据仍有效后才能提交接管。"],
] as const;
