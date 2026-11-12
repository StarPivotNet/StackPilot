import { createHash } from "node:crypto";
import { glob, lstat, readFile, readlink, realpath, readdir } from "node:fs/promises";
import { isIP, createConnection } from "node:net";
import { dirname, resolve } from "node:path";
import { rootDirectory, rootExecutable, rootFile } from "./files.js";
import { runCommand, type CommandRunner } from "./commands.js";
import { ProcessInspector, type ProcessIdentity } from "./processes.js";

export type ConfigurationFile = { path: string; sha256: string; mode: number; uid: number; gid: number };
export type SshListener = { address: string; port: number; pids: number[] };
export type SshPreflight = { collectedAt: string; digest: string; files: ConfigurationFile[]; listeners: SshListener[]; fingerprints: string[]; hostKeys: string[]; authentication: Record<string, string[]>; matches: string[]; listener: ProcessIdentity; connections: ProcessIdentity[]; socketActive: boolean };
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const properties = (text: string) => Object.fromEntries(text.trim().split("\n").map(line => { const equal = line.indexOf("="); if (equal < 0) throw new Error("Invalid systemd metadata"); return [line.slice(0, equal), line.slice(equal + 1)]; }));

export function parseListeners(text: string): SshListener[] {
  const result: SshListener[] = [];
  for (const line of text.trim().split("\n").filter(Boolean)) {
    const fields = line.trim().split(/\s+/), endpoint = fields[3];
    if (fields[0] !== "LISTEN" || !endpoint) throw new Error("Unrecognized TCP listener inventory");
    const match = /^(\[[^\]]+\]|[^\s]+):(\d+)$/.exec(endpoint);
    if (!match) throw new Error("Unrecognized listening address");
    let address = match[1]!.replace(/^\[|\]$/g, ""); const port = Number(match[2]);
    if (/^\d+\.\d+\.\d+\.\d+%[a-zA-Z0-9_.-]+$/.test(address)) address = address.split("%")[0]!;
    if (address !== "*" && !isIP(address) || port < 1 || port > 65535) throw new Error("Unsupported listening address");
    const pids = [...new Set([...line.matchAll(/pid=(\d+)/g)].map(value => Number(value[1])))];
    result.push({ address, port, pids });
  }
  if (result.length > 128) throw new Error("Too many listening entrances for safe preflight");
  return result;
}
export function effectiveConfiguration(text: string) {
  const result: Record<string, string[]> = {};
  for (const line of text.trim().split("\n")) { const match = /^(\S+)\s+(.*)$/.exec(line); if (!match) throw new Error("Unrecognized effective SSH configuration"); (result[match[1]!] ??= []).push(match[2]!.trim()); }
  return result;
}
async function fileReceipt(path: string): Promise<ConfigurationFile> {
  await rootDirectory(dirname(path)); const contents = await rootFile(path); const stat = await lstat(path);
  return { path, sha256: hash(contents), mode: stat.mode & 0o7777, uid: stat.uid, gid: stat.gid };
}
async function sshBanner(listener: SshListener) {
  return new Promise<string | null>(resolve => {
    const host = listener.address === "*" || listener.address === "0.0.0.0" ? "127.0.0.1" : listener.address === "::" ? "::1" : listener.address;
    const socket = createConnection({ host, port: listener.port }); let raw = "", settled = false;
    const finish = (value: string | null) => { if (!settled) { settled = true; socket.destroy(); resolve(value); } };
    socket.setTimeout(750, () => finish(null)); socket.on("error", () => finish(null)); socket.on("end", () => finish(null));
    socket.on("data", chunk => { raw += chunk.toString("ascii"); if (raw.length > 4096) finish(null); else { const banner = /^SSH-[^\r\n]+/m.exec(raw)?.[0]; if (banner) finish(banner); } });
  });
}
export class SshPreflightInspector {
  constructor(private readonly run: CommandRunner = runCommand, private readonly processes = new ProcessInspector()) {}
  async inspect(): Promise<SshPreflight> {
    await rootExecutable(await realpath("/usr/sbin/sshd"));
    const unit = properties(await this.run("/usr/bin/systemctl", ["show", "ssh.service", "--property=ActiveState,MainPID,FragmentPath,DropInPaths,ExecStart,Environment,EnvironmentFiles,KillMode"]));
    if (unit.ActiveState !== "active" || !/^\d+$/.test(unit.MainPID ?? "") || Number(unit.MainPID) <= 1 || unit.KillMode !== "process" || unit.Environment || unit.DropInPaths || unit.EnvironmentFiles !== "/etc/default/ssh (ignore_errors=yes)" || !/argv\[\]=\/usr\/sbin\/sshd -D \$SSHD_OPTS ;/.test(unit.ExecStart ?? "")) throw new Error("Unsupported SSH startup overrides or service definition");
    if (!/^\/(?:usr\/)?lib\/systemd\/system\/ssh\.service$/.test(unit.FragmentPath ?? "")) throw new Error("Unsupported SSH systemd unit");
    const files = new Map<string, ConfigurationFile>();
    const capture = async (path: string) => { const canonical = await realpath(path); const receipt = await fileReceipt(canonical); files.set(canonical, receipt); return await rootFile(canonical); };
    await capture(unit.FragmentPath!);
    const defaults = await capture("/etc/default/ssh");
    if (defaults.split("\n").map(line => line.trim()).some(line => line && !line.startsWith("#") && !/^SSHD_OPTS=(?:""|''|)\s*(?:#.*)?$/.test(line))) throw new Error("Unsupported SSH environment options");
    const socket = properties(await this.run("/usr/bin/systemctl", ["show", "ssh.socket", "--property=ActiveState,FragmentPath,DropInPaths,Listen"]));
    if (socket.DropInPaths || !["active", "inactive"].includes(socket.ActiveState ?? "")) throw new Error("Unsupported SSH socket activation overrides");
    if (socket.FragmentPath) await capture(socket.FragmentPath);
    const matches: string[] = [];
    const visitSsh = async (path: string) => {
      const canonical = await realpath(path); if (files.has(canonical)) return;
      if (files.size >= 128) throw new Error("SSH configuration include limit exceeded");
      const source = await capture(canonical);
      for (const line of source.split("\n")) {
        const match = /^\s*Match\s+(.+)$/i.exec(line);
        if (match) { if (matches.length >= 128 || match[1]!.length > 512) throw new Error("SSH Match inventory limit exceeded"); matches.push(match[1]!.trim()); }
        const include = /^\s*Include\s+(.+)$/i.exec(line); if (!include) continue;
        for (const pattern of include[1]!.replace(/\s+#.*$/, "").trim().split(/\s+/)) {
          if (!/^[a-zA-Z0-9_./*?[\]-]+$/.test(pattern) || pattern.split("/").includes("..")) throw new Error("Unsupported SSH include syntax");
          for await (const child of glob(resolve("/etc/ssh", pattern))) await visitSsh(child);
        }
      }
    };
    await visitSsh("/etc/ssh/sshd_config");
    const visitPam = async (name: string) => {
      if (!/^[a-zA-Z0-9_.-]+$/.test(name)) throw new Error("Unsupported PAM include");
      const path = `/etc/pam.d/${name}`; if (files.has(path)) return;
      if (files.size >= 128) throw new Error("PAM configuration include limit exceeded");
      const source = await capture(path);
      for (const line of source.split("\n")) { const include = /^\s*@include\s+(\S+)\s*$/.exec(line) ?? /^\s*(?:auth|account|password|session)\s+(?:include|substack)\s+(\S+)\s*$/.exec(line); if (include) await visitPam(include[1]!); }
    };
    await visitPam("sshd");
    await this.run("/usr/sbin/sshd", ["-t"]);
    const effective = effectiveConfiguration(await this.run("/usr/sbin/sshd", ["-T"]));
    const hostKeys = effective.hostkey ?? []; if (!hostKeys.length || hostKeys.length > 8) throw new Error("SSH host keys are unavailable");
    const fingerprints: string[] = [];
    for (const key of hostKeys) {
      if (!/^\/[a-zA-Z0-9_./-]+$/.test(key) || key.split("/").includes("..")) throw new Error("Unsupported SSH host key location");
      // Fingerprint private keys through ssh-keygen; never return their contents.
      await rootDirectory(dirname(key)); const metadata = await lstat(key);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.uid !== 0 || metadata.nlink !== 1 || metadata.mode & 0o077) throw new Error("Unsafe SSH host key");
      const output = await this.run("/usr/bin/ssh-keygen", ["-l", "-E", "sha256", "-f", key]); const fingerprint = /\bSHA256:[A-Za-z0-9+/]{43}\b/.exec(output)?.[0];
      if (!fingerprint) throw new Error("Cannot fingerprint SSH host key"); fingerprints.push(fingerprint);
    }
    const listener = await this.processes.sshd(Number(unit.MainPID));
    if (await this.processes.cgroup(listener.pid) !== "/system.slice/ssh.service") throw new Error("SSH listener is not owned by the stock service");
    const native = new Set<number>();
    const expected = await realpath("/usr/sbin/sshd");
    for (const name of await readdir("/proc")) {
      if (!/^\d+$/.test(name)) continue;
      let binary: string;
      try { binary = await readlink(`/proc/${name}/exe`); } catch (error) { if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) continue; throw error; }
      if (binary === expected) native.add(Number(name));
      else if (/(?:^|\/)(?:sshd|sshd-session|dropbear|tinysshd|teleport)(?: \(deleted\))?$/.test(binary)) throw new Error("Unmanaged or unrecognized SSH server process");
    }
    const all = parseListeners(await this.run("/usr/bin/ss", ["-ltnpH"])); const listeners: SshListener[] = [];
    for (let index = 0; index < all.length; index += 16) {
      const batch = all.slice(index, index + 16), banners = await Promise.all(batch.map(sshBanner));
      for (const [offset, entrance] of batch.entries()) {
        const known = entrance.pids.some(pid => native.has(pid)), banner = banners[offset];
        if (!known && !banner) continue;
        if (!banner?.startsWith("SSH-2.0-OpenSSH_") || !entrance.pids.includes(listener.pid) || entrance.pids.some(pid => pid !== listener.pid && pid !== 1)) throw new Error("An SSH listening entrance is outside the managed service");
        if (!/^SSH-2\.0-OpenSSH_(?:9\.2p1|9\.6p1)(?:\s|$)/.test(banner)) throw new Error("Only distribution-native Debian 12/Ubuntu 24.04 OpenSSH is supported");
        listeners.push(entrance);
      }
    }
    if (!listeners.length) throw new Error("No verified native SSH listening entrance");
    const connections: ProcessIdentity[] = [];
    const children = (await readFile(`/proc/${listener.pid}/task/${listener.pid}/children`, "utf8")).trim();
    for (const pid of children ? children.split(/\s+/).map(Number) : []) {
      try { connections.push(await this.processes.sshd(pid)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT" && (error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    }
    const receipts = [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
    if ((await this.processes.sshd(listener.pid)).start !== listener.start) throw new Error("SSH listener changed during preflight");
    const authentication = Object.fromEntries(Object.entries(effective).filter(([key]) => /^(?:authenticationmethods|passwordauthentication|pubkeyauthentication|kbdinteractiveauthentication|usepam|hostbasedauthentication|gssapiauthentication|kerberosauthentication|permitrootlogin|authorizedkeysfile|authorizedkeyscommand|authorizedprincipalsfile|authorizedprincipalscommand|trustedusercakeys|allowusers|denyusers|allowgroups|denygroups)$/.test(key)).map(([key, values]) => [key, key.endsWith("command") ? values.map(value => value === "none" ? "none" : "configured") : values]));
    const digest = hash(JSON.stringify({ files: receipts, listeners: listeners.map(({ address, port }) => ({ address, port })).sort((a, b) => `${a.address}:${a.port}`.localeCompare(`${b.address}:${b.port}`)), fingerprints: [...fingerprints].sort(), socketActive: socket.ActiveState === "active" }));
    return { collectedAt: new Date().toISOString(), digest, files: receipts, listeners, fingerprints, hostKeys, authentication, matches, listener, connections, socketActive: socket.ActiveState === "active" };
  }
}
