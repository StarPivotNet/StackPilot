import { createHash, randomUUID } from "node:crypto";
import { chown, lstat, unlink } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { atomicRootFile, rootFile, rootExecutable } from "./files.js";
import { runCommand, type CommandRunner } from "./commands.js";
import { SshPreflightInspector, type SshPreflight } from "./preflight.js";
import { ProcessInspector } from "./processes.js";
import { RollbackTimer } from "./rollbackTimer.js";
import { managedSshConfiguration, MANAGED_PAM, verifyManagedSshConfiguration } from "./sshConfiguration.js";
import type { TakeoverOperations } from "./takeover.js";
import type { TakeoverJournal } from "./takeoverJournal.js";
import { requireBootRecovery } from "./recoveryReadiness.js";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
export class TakeoverHost implements TakeoverOperations {
  private readonly timer: RollbackTimer;
  private readonly inspector: SshPreflightInspector;
  constructor(private readonly run: CommandRunner = runCommand, private readonly processes = new ProcessInspector()) { this.timer = new RollbackTimer(run); this.inspector = new SshPreflightInspector(run, processes); }
  now() { return Date.now(); }
  bootMs() { return this.processes.bootMs(); }
  bootId() { return this.processes.bootId(); }
  inspect() { return this.inspector.inspect(); }
  async armRollback(planId: string, deadlineBootMs: number) { await requireBootRecovery(this.run); return this.timer.arm(planId, deadlineBootMs); }
  rollbackArmed(planId: string) { return this.timer.armed(planId); }
  cancelRollback(planId: string) { return this.timer.cancel(planId); }
  async backup(): Promise<TakeoverJournal["backups"]> {
    const result: TakeoverJournal["backups"] = [];
    for (const path of ["/etc/ssh/sshd_config", "/etc/pam.d/sshd"] as const) {
      const contents = await rootFile(path), stat = await lstat(path);
      if (stat.isSymbolicLink() || stat.uid !== 0) throw new Error("Unsafe SSH rollback target");
      result.push({ path, contents, sha256: sha256(contents), mode: stat.mode & 0o7777, gid: stat.gid });
    }
    return result;
  }
  async apply(snapshot: SshPreflight) {
    await rootExecutable("/usr/lib/security/pam_stackpilot.so");
    const config = managedSshConfiguration(snapshot);
    // Validate generated sshd syntax before changing the PAM stack.
    const validation = `/etc/ssh/.stackpilot-validation-${randomUUID()}`;
    try { await atomicRootFile(validation, config, 0o600, async temporary => { await this.run("/usr/sbin/sshd", ["-t", "-f", temporary]); }); }
    finally { await unlink(validation).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; }); }
    await atomicRootFile("/etc/pam.d/sshd", MANAGED_PAM, 0o644);
    await atomicRootFile("/etc/ssh/sshd_config", config, 0o644, async temporary => { await this.run("/usr/sbin/sshd", ["-t", "-f", temporary]); });
    await this.run("/usr/sbin/sshd", ["-t"]);
    verifyManagedSshConfiguration(await this.run("/usr/sbin/sshd", ["-T"]));
    await this.run("/usr/bin/systemctl", ["reload", "ssh.service"]);
  }
  async restore(backups: TakeoverJournal["backups"]) {
    for (const backup of [...backups].sort((a, b) => a.path.localeCompare(b.path))) {
      if (!["/etc/ssh/sshd_config", "/etc/pam.d/sshd"].includes(backup.path) || sha256(backup.contents) !== backup.sha256) throw new Error("SSH backup integrity verification failed");
      await atomicRootFile(backup.path, backup.contents, backup.mode); await chown(backup.path, 0, backup.gid);
    }
    await this.run("/usr/sbin/sshd", ["-t"]);
    const active = (await this.run("/usr/bin/systemctl", ["show", "ssh.service", "--property=ActiveState", "--value"])).trim();
    // Boot recovery runs before ssh.service. It restores and validates files;
    // public readiness still requires a fresh successful listener inspection.
    if (active === "active") await this.run("/usr/bin/systemctl", ["reload", "ssh.service"]);
    else if (active !== "inactive" && active !== "activating") throw new Error("SSH service requires out-of-band recovery");
  }
  async verifyRestored(backups: TakeoverJournal["backups"]) {
    for (const backup of backups) { const stat = await lstat(backup.path); if (sha256(await rootFile(backup.path)) !== backup.sha256 || (stat.mode & 0o7777) !== backup.mode || stat.uid !== 0 || stat.gid !== backup.gid) throw new Error("SSH restored files do not match their backup"); }
    await this.run("/usr/sbin/sshd", ["-t"]);
    const active = (await this.run("/usr/bin/systemctl", ["show", "ssh.service", "--property=ActiveState", "--value"])).trim();
    if (active === "active") await this.inspect();
    else if (active !== "inactive" && active !== "activating") throw new Error("Restored SSH service is not operational");
  }
  async terminateLegacy(connections: TakeoverJournal["connections"]) {
    const targets = new Map<number, string>();
    for (const connection of connections) {
      try {
        const actual = await this.processes.sshd(connection.pid); if (actual.start !== connection.start) continue;
        for (const pid of await this.processes.descendants(connection.pid)) { const value = await this.processes.identity(pid); targets.set(pid, value.start); }
      } catch (error) { if (!["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
    }
    if (targets.has(process.pid)) throw new Error("SSH takeover worker must run independently of legacy SSH connections");
    const alive = async (pid: number, start: string) => { try { return (await this.processes.identity(pid)).start === start; } catch (error) { if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) return false; throw error; } };
    for (const signal of ["SIGTERM", "SIGKILL"] as const) {
      for (const [pid, start] of targets) if (await alive(pid, start)) { try { process.kill(pid, signal); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; } }
      for (let attempt = 0; attempt < 50; attempt++) { if (!(await Promise.all([...targets].map(([pid, start]) => alive(pid, start)))).some(Boolean)) return; await delay(20); }
    }
    throw new Error("Legacy SSH processes have not all exited");
  }
}
