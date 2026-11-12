import { isIP } from "node:net";
import type { SshPreflight } from "./preflight.js";
import { effectiveConfiguration } from "./preflight.js";

export const MANAGED_PAM = "# Managed by StackPilot. Restore only through the takeover rollback journal.\nauth required /usr/lib/security/pam_stackpilot.so\naccount required /usr/lib/security/pam_stackpilot.so\nsession required /usr/lib/security/pam_stackpilot.so\n";
const directives = {
  UsePAM: "yes", AuthenticationMethods: "keyboard-interactive:pam", KbdInteractiveAuthentication: "yes", PasswordAuthentication: "no", PubkeyAuthentication: "no", HostbasedAuthentication: "no", GSSAPIAuthentication: "no", KerberosAuthentication: "no", PermitRootLogin: "no", PermitEmptyPasswords: "no", AuthorizedKeysFile: "none", AuthorizedKeysCommand: "none", AuthorizedPrincipalsFile: "none", AuthorizedPrincipalsCommand: "none", TrustedUserCAKeys: "none", AllowUsers: "sp_*", DenyUsers: "root", DisableForwarding: "yes", AllowTcpForwarding: "no", AllowStreamLocalForwarding: "no", AllowAgentForwarding: "no", X11Forwarding: "no", PermitTunnel: "no", GatewayPorts: "no", PermitOpen: "none", PermitListen: "none", PermitUserEnvironment: "no", PermitUserRC: "no", PermitTTY: "yes", ForceCommand: "none", ChrootDirectory: "none", StrictModes: "yes", LoginGraceTime: "30", MaxAuthTries: "3", MaxSessions: "10", UseDNS: "no", LogLevel: "VERBOSE", PrintMotd: "no", Subsystem: "sftp internal-sftp",
};
/** Replace the whole top-level configuration: no inherited Include or Match can
 * re-enable old authentication, forwarding or session hooks. */
export function managedSshConfiguration(snapshot: Pick<SshPreflight, "listeners" | "hostKeys">) {
  if (!snapshot.listeners.length || snapshot.listeners.length > 32 || !snapshot.hostKeys.length || snapshot.hostKeys.length > 8) throw new Error("Unsupported SSH entrance count");
  const ports = new Set<number>(), addresses = new Set<string>();
  for (const { address, port } of snapshot.listeners) {
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535 || !isIP(address)) throw new Error("Unsupported managed SSH entrance");
    ports.add(port); addresses.add(`${isIP(address) === 6 ? `[${address}]` : address}:${port}`);
  }
  for (const key of snapshot.hostKeys) if (!/^\/[a-zA-Z0-9_./-]+$/.test(key) || key.split("/").includes("..")) throw new Error("Unsafe SSH host key path");
  return ["# Managed by StackPilot. Local rollback remains armed until independent verification.", ...[...ports].sort((a, b) => a - b).map(port => `Port ${port}`), ...[...addresses].sort().map(address => `ListenAddress ${address}`), ...snapshot.hostKeys.map(path => `HostKey ${path}`), ...Object.entries(directives).map(([key, value]) => `${key} ${value}`), ""].join("\n");
}
export function verifyManagedSshConfiguration(output: string) {
  const effective = effectiveConfiguration(output);
  for (const [key, expected] of Object.entries(directives)) {
    if (["LoginGraceTime", "LogLevel", "Subsystem"].includes(key)) continue;
    if (effective[key.toLowerCase()]?.join(" ") !== expected) throw new Error(`Effective SSH control does not match: ${key}`);
  }
  if (effective.subsystem?.join(" ") !== "sftp internal-sftp") throw new Error("SFTP bypassed the managed session path");
}
