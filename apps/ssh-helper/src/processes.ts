import { readFile, readlink, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";

export type ProcessIdentity = { pid: number; ppid: number; start: string };
export function parseProcessStat(value: string): ProcessIdentity {
  const close = value.lastIndexOf(")"); const pid = Number(value.slice(0, value.indexOf(" "))); const fields = value.slice(close + 2).trim().split(/\s+/);
  if (close < 0 || !Number.isSafeInteger(pid) || pid <= 0 || !/^\d+$/.test(fields[19] ?? "") || !/^\d+$/.test(fields[1] ?? "")) throw new Error("Invalid process identity");
  return { pid, ppid: Number(fields[1]), start: fields[19]! };
}
export class ProcessInspector {
  constructor(private readonly proc = "/proc", private readonly groups = "/sys/fs/cgroup") {}
  async bootId() { const value = (await readFile(`${this.proc}/sys/kernel/random/boot_id`, "utf8")).trim(); if (!/^[0-9a-f-]{36}$/.test(value)) throw new Error("Invalid boot identity"); return value; }
  async bootMs() { const value = Number((await readFile(`${this.proc}/uptime`, "utf8")).split(" ")[0]); if (!Number.isFinite(value) || value < 0) throw new Error("Invalid monotonic clock"); return value * 1000; }
  async identity(pid: number) { if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error("Invalid SSH process"); return parseProcessStat(await readFile(`${this.proc}/${pid}/stat`, "utf8")); }
  async sshd(pid: number) {
    const identity = await this.identity(pid); const status = await readFile(`${this.proc}/${pid}/status`, "utf8");
    if (!/^Uid:\s+0\s+0\s+0\s+0\s*$/m.test(status) || await readlink(`${this.proc}/${pid}/exe`) !== await realpath("/usr/sbin/sshd")) throw new Error("Caller is not a privileged sshd process");
    return identity;
  }
  async connection(monitorPid: number, phasePid: number) {
    const phase = await this.sshd(phasePid); const monitor = await this.sshd(monitorPid);
    if (phase.ppid !== monitor.pid) throw new Error("PAM process is not a child of this monitor");
    await this.sshd(monitor.ppid); // Reject the listener itself or unrelated root processes.
    const bootId = await this.bootId();
    return { monitor, bootId, connectionId: createHash("sha256").update(`${bootId}:${monitor.pid}:${monitor.start}`).digest("hex") };
  }
  async descendants(pid: number): Promise<number[]> {
    const found = new Set<number>();
    const visit = async (current: number) => {
      if (found.has(current) || found.size >= 1024) throw new Error("Invalid SSH process tree"); found.add(current);
      const children = (await readFile(`${this.proc}/${current}/task/${current}/children`, "utf8")).trim();
      for (const value of children ? children.split(/\s+/) : []) { const child = Number(value); if (!Number.isSafeInteger(child) || child <= 1) throw new Error("Invalid SSH child"); try { await visit(child); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
    };
    await visit(pid); if (found.has(process.pid)) throw new Error("Helper must run independently of the SSH connection"); return [...found];
  }
  async cgroup(pid: number) {
    const line = (await readFile(`${this.proc}/${pid}/cgroup`, "utf8")).split("\n").find(value => value.startsWith("0::/"));
    if (!line) throw new Error("Unified cgroup v2 is required"); const path = line.slice(3);
    if (!/^\/[a-zA-Z0-9_./@:-]+$/.test(path) || path.split("/").includes("..")) throw new Error("Unsafe SSH cgroup path"); return path;
  }
  async members(path: string) {
    if (!/^\/[a-zA-Z0-9_./@:-]+$/.test(path) || path.split("/").includes("..")) throw new Error("Unsafe SSH cgroup path");
    try { const value = (await readFile(`${this.groups}${path}/cgroup.procs`, "utf8")).trim(); return value ? value.split(/\s+/).map(value => { const pid = Number(value); if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error("Invalid cgroup member"); return pid; }) : []; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  }
}
