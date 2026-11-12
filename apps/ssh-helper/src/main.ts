import { constants } from "node:fs";
import { open, readFile } from "node:fs/promises";
import { createPublicKey } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ControllerClient } from "./controllerClient.js";
import { RootStore } from "./store.js";
import { ProcessInspector } from "./processes.js";
import { SessionScopes } from "./systemd.js";
import { SessionRuntime } from "./runtime.js";
import { startPamSocket } from "./server.js";

export async function readEnrollment(path: string) {
  const fd = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try { const stat = await fd.stat(); if (!stat.isFile() || stat.uid !== 0 || stat.nlink !== 1 || (stat.mode & 0o077) || stat.size > 1024) throw new Error("Enrollment file must be root-only"); const token = (await fd.readFile("utf8")).trim(); if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error("Invalid SSH enrollment credential"); return token; } finally { await fd.close(); }
}
async function main() {
  if (process.platform !== "linux" || process.getuid?.() !== 0 || process.geteuid?.() !== 0) throw new Error("SSH helper requires native Linux root");
  if (process.arch !== "x64") throw new Error("SSH helper requires x86_64");
  if ((await readFile("/proc/1/comm", "utf8")).trim() !== "systemd") throw new Error("SSH helper requires systemd");
  try { await promisify(execFile)("/usr/bin/systemd-detect-virt", ["--container", "--quiet"], { timeout: 5000 }); throw new Error("Container SSH takeover is unsupported"); } catch (error) { if ((error as { code?: unknown }).code !== 1) throw error; }
  const os = await readFile("/etc/os-release", "utf8");
  const id = /^ID=["']?([^\n"']+)/m.exec(os)?.[1]; const version = /^VERSION_ID=["']?([^\n"']+)/m.exec(os)?.[1];
  if (!((id === "debian" && version === "12") || (id === "ubuntu" && version === "24.04"))) throw new Error("SSH helper requires Debian 12 or Ubuntu 24.04");
  const store = new RootStore(process.env.STACKPILOT_SSH_STATE_DIR ?? "/var/lib/stackpilot-ssh-helper"); await store.prepare();
  const ca = process.env.STACKPILOT_SSH_CA_FILE ? await readFile(process.env.STACKPILOT_SSH_CA_FILE, "utf8") : undefined;
  const controller = new ControllerClient(process.env.STACKPILOT_SSH_CONTROLLER_URL ?? "", ca);
  const privateKey = await store.key();
  if (process.argv[2] === "enroll") {
    const expectedNode = process.env.STACKPILOT_SSH_NODE_ID;
    if (!expectedNode || !/^[0-9a-f-]{36}$/.test(expectedNode)) throw new Error("Expected SSH node ID is required");
    const credential = await controller.enroll(await readEnrollment(process.env.STACKPILOT_SSH_ENROLLMENT_FILE ?? "/etc/stackpilot-ssh-helper/enrollment-token"), createPublicKey(privateKey).export({ type: "spki", format: "pem" }).toString());
    if (credential.nodeId !== expectedNode) throw new Error("SSH enrollment targeted a different node");
    await store.write("identity.json", JSON.stringify({ nodeId: credential.nodeId, credentialId: credential.credentialId }));
    process.stdout.write("SSH helper enrolled. SSH authentication configuration is unchanged.\n"); return;
  }
  if (process.argv[2] !== undefined && process.argv[2] !== "run") throw new Error("Unknown SSH helper command");
  const identity = { ...await store.identity(), privateKey };
  const processes = new ProcessInspector(); await processes.cgroup(process.pid);
  const runtime = new SessionRuntime(store, controller, identity, processes, new SessionScopes()); await runtime.initialize();
  const socket = await startPamSocket(runtime); let timer: NodeJS.Timeout | undefined; let stopped = false;
  const tick = async () => { try { await runtime.synchronize(); } catch { process.stderr.write("SSH session reconciliation failed; local systemd deadlines remain active.\n"); } finally { if (!stopped) timer = setTimeout(() => void tick(), 10_000); } };
  timer = setTimeout(() => void tick(), 10_000);
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { stopped = true; clearTimeout(timer); socket.close(); });
  process.stdout.write("SSH PAM helper listening on its root-only local socket.\n");
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main().catch(() => { process.stderr.write("SSH helper failed. Verify root-only configuration and Controller trust.\n"); process.exitCode = 1; });
