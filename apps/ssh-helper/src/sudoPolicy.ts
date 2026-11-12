import { sshAccountName, SshPolicySchema, type SshPolicy } from "@stackpilot/contracts";

const protectedUnit = /^(?:ssh(?:d)?\.service|stackpilot[-.]|systemd[-.]|user@|dbus[-.]|polkit[-.]|cron\.service|atd\.service)/i;
export function validateServiceUnit(unit: string) {
  if (unit !== unit.trim() || !/^[a-zA-Z0-9][a-zA-Z0-9_.@-]{0,127}\.service$/.test(unit) || protectedUnit.test(unit)) throw new Error("Service is not eligible for restricted SSH operations");
}
export function buildSudoPolicy(raw: SshPolicy, nodeId: string) {
  const policy = SshPolicySchema.parse(raw);
  if (policy.nodeId !== nodeId || policy.account !== sshAccountName(policy.userId)) throw new Error("SSH account binding mismatch");
  if (!policy.enabled || policy.profile === "shell") return { sudoers: "", grants: "" };
  const defaults = `Defaults:${policy.account} env_reset,!setenv,!env_keep,!env_check,secure_path="/usr/sbin:/usr/bin:/sbin:/bin"\n`;
  if (policy.profile === "host-admin") return { sudoers: `${defaults}${policy.account} ALL=(root) NOPASSWD: ALL\n`, grants: "" };
  const units = [...new Set(policy.services)].sort(); for (const unit of units) validateServiceUnit(unit);
  const commands = units.flatMap(unit => ["start", "stop", "restart"].map(action => `/usr/libexec/stackpilot-ssh-service ${action} ${unit}`));
  return { sudoers: `${defaults}${policy.account} ALL=(root) NOPASSWD: NOSETENV: EXEC: ${commands.join(", ")}\n`, grants: `${units.join("\n")}\n` };
}
