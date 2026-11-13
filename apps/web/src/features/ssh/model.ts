import type { SshHost } from "@stackpilot/contracts";
export const sshTabs = [{ page: "ssh", title: "托管总览" }, { page: "ssh-hosts", title: "托管主机" }, { page: "ssh-keys", title: "临时密码与会话" }, { page: "ssh-policies", title: "授权策略" }, { page: "ssh-audit", title: "SSH 审计" }];
const entry = (title: string, description: string, active: string) => ({ title, description, active });
export const sshPageMeta: Record<string, ReturnType<typeof entry>> = {
  ssh: entry("SSH 管理", "使用平台账号领取一次性密码，以独立系统账号直连授权主机。", "ssh"),
  "ssh-hosts": entry("托管主机", "查看认证接管、主机采集和当前可用状态。", "ssh-hosts"),
  "ssh-host-detail": entry("托管主机", "检查主机身份、权限、连接与验证证据。", "ssh-hosts"),
  "ssh-keys": entry("临时密码与会话", "密码领取后 15 分钟内可使用一次，会话期限按授权策略执行。", "ssh-keys"),
  "ssh-issue": entry("申请临时密码", "仅能为当前账号及已生效的主机授权申请密码。", "ssh-keys"),
  "ssh-revoke": entry("撤销与断开", "分别确认撤销已登记、等待主机执行和主机已确认终止。", "ssh-keys"),
  "ssh-policies": entry("授权策略", "明确绑定平台用户、目标主机、权限档位与会话上限。", "ssh-policies"),
  "ssh-audit": entry("SSH 审计", "查询接管、授权、签发、认证、断开与恢复的实际记录。", "ssh-audit"),
  "ssh-rescue": entry("带外恢复", "通过云控制台、VNC 或串口恢复管理入口。", "ssh-hosts"),
};
for (const key of ["ssh-precheck", "ssh-confirm", "ssh-verify", "ssh-complete", "ssh-rollback"]) sshPageMeta[key] = entry("主机接管", "先完成安装与预检，通过独立验证后提交接管。", "ssh-hosts");
export const sshStateLabel: Record<string, string> = { unmanaged: "未接管", prechecking: "正在预检", prechecked: "预检完成", applying: "正在应用", "awaiting-verification": "待验证", managed: "已接管", "rolling-back": "回滚中", "rolled-back": "已回滚", "manual-recovery-required": "需要带外恢复", failed: "执行失败", drifted: "配置漂移" };
export const sshProfiles = { shell: "普通用户", "service-operator": "服务运维", "host-admin": "主机管理员" } as const;
export const hostStateLabel = (host: SshHost) => host.supported === false ? "不支持接管" : host.state === "managed" && !host.available ? "已接管 · 暂停签发" : sshStateLabel[host.state];
export const durationLabel = (seconds: number) => seconds >= 3600 ? `${seconds / 3600} 小时` : `${seconds / 60} 分钟`;
export const sshCheckLabels: Record<string, string> = { "legacy-probe-key-accepted":"切换前探针登录成功", "entrances.effective-configuration":"入口与实际生效配置", "authentication.pam":"一次性密码登录", "identity.uid":"受管账号实际身份", "sudo.profile":"sudo 权限档位", "sftp.session":"SFTP 会话受控", "forwarding.disabled":"转发功能已禁用", "authentication.reuse-denied":"重复密码被拒绝", "authentication.old-key-denied":"原公钥认证被拒绝", "authentication.password-method-denied":"原密码认证路径被拒绝", "authentication.expired-denied":"过期密码被拒绝", "authentication.revoked-denied":"撤销密码被拒绝", "authentication.other-account-denied":"跨账号密码被拒绝", "authentication.other-node-denied":"跨主机凭据校验", "session.local-deadline":"本地会话期限执行" };
