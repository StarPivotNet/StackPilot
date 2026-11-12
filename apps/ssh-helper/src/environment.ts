import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

export async function requireNativeSshHost() {
  if (process.platform !== "linux" || process.getuid?.() !== 0 || process.geteuid?.() !== 0 || process.arch !== "x64") throw new Error("SSH helper requires native x86_64 Linux root");
  if ((await readFile("/proc/1/comm", "utf8")).trim() !== "systemd") throw new Error("SSH helper requires systemd");
  try { await promisify(execFile)("/usr/bin/systemd-detect-virt", ["--container", "--quiet"], { timeout: 5000 }); throw new Error("Container SSH takeover is unsupported"); } catch (error) { if ((error as { code?: unknown }).code !== 1) throw error; }
  const os = await readFile("/etc/os-release", "utf8"), id = /^ID=["']?([^\n"']+)/m.exec(os)?.[1], version = /^VERSION_ID=["']?([^\n"']+)/m.exec(os)?.[1];
  if (!((id === "debian" && version === "12") || (id === "ubuntu" && version === "24.04"))) throw new Error("SSH helper requires Debian 12 or Ubuntu 24.04");
  const cgroup = await readFile("/proc/self/cgroup", "utf8"); if (!/^0::\//m.test(cgroup)) throw new Error("SSH helper requires unified cgroup v2");
}
