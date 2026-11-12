import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execute = promisify(execFile);
export type SystemdRunner = (file: string, args: readonly string[]) => Promise<void>;
export class SessionScopes {
  constructor(private readonly run: SystemdRunner = async (file, args) => { await execute(file, [...args], { timeout: 10_000, maxBuffer: 64 * 1024, env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C", LC_ALL: "C" } }); }) {}
  private name(value: string) { if (!/^stackpilot-ssh-[0-9a-f-]{36}\.scope$/.test(value)) throw new Error("Invalid SSH scope"); return value; }
  async create(name: string, pids: number[], milliseconds: number) {
    this.name(name);
    if (!pids.length || pids.some(pid => !Number.isSafeInteger(pid) || pid <= 1) || !Number.isFinite(milliseconds) || milliseconds <= 0 || milliseconds > 28_800_000) throw new Error("Invalid SSH scope bounds");
    await this.run("/usr/bin/busctl", ["call", "org.freedesktop.systemd1", "/org/freedesktop/systemd1", "org.freedesktop.systemd1.Manager", "StartTransientUnit", "ssa(sv)a(sa(sv))", name, "fail", "7", "Description", "s", "StackPilot managed SSH connection", "PIDs", "au", String(pids.length), ...pids.map(String), "RuntimeMaxUSec", "t", String(Math.floor(milliseconds * 1000)), "TimeoutStopUSec", "t", "5000000", "KillMode", "s", "control-group", "SendSIGKILL", "b", "true", "Delegate", "b", "false", "0"]);
  }
  async stop(name: string) { await this.run("/usr/bin/systemctl", ["stop", "--", this.name(name)]); }
}
