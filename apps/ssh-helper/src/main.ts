import { constants } from "node:fs";
import { open, readFile } from "node:fs/promises";
import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { dirname } from "node:path";
import { ControllerClient, ControllerError } from "./controllerClient.js";
import { SshInventorySchema, type SshTakeoverReceipt } from "@stackpilot/contracts";
import { RootStore } from "./store.js";
import { ProcessInspector } from "./processes.js";
import { SessionScopes } from "./systemd.js";
import { SessionRuntime } from "./runtime.js";
import { startPamSocket } from "./server.js";
import { AccountManager } from "./accounts.js";
import { ServiceInspector } from "./services.js";
import { SshPreflightInspector } from "./preflight.js";
import { requireNativeSshHost } from "./environment.js";
import { isEntrypoint } from "./entrypoint.js";
import { TakeoverCommands } from "./takeoverCommands.js";
import { rootDirectory, rootFile } from "./files.js";

export async function readEnrollment(path: string) {
  await rootDirectory(dirname(path));
  const fd = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try { const stat = await fd.stat(); if (!stat.isFile() || stat.uid !== 0 || stat.nlink !== 1 || (stat.mode & 0o077) || stat.size > 1024) throw new Error("Enrollment file must be root-only"); const token = (await fd.readFile("utf8")).trim(); if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error("Invalid SSH enrollment credential"); return token; } finally { await fd.close(); }
}
async function main() {
  const platform = await requireNativeSshHost();
  if (process.argv[2] === "preflight") { process.stdout.write(`${JSON.stringify(await new SshPreflightInspector().inspect())}\n`); return; }
  const store = new RootStore(process.env.STACKPILOT_SSH_STATE_DIR ?? "/var/lib/stackpilot-ssh-helper"); await store.prepare();
  const caPath = process.env.STACKPILOT_SSH_CA_FILE;
  if (caPath) await rootDirectory(dirname(caPath));
  const ca = caPath ? await rootFile(caPath) : undefined;
  const controller = new ControllerClient(process.env.STACKPILOT_SSH_CONTROLLER_URL ?? "", ca);
  if (process.argv[2] === "enroll") {
    const expectedNode = process.env.STACKPILOT_SSH_NODE_ID;
    if (!expectedNode || !/^[0-9a-f-]{36}$/.test(expectedNode)) throw new Error("Expected SSH node ID is required");
    // Explicit enrollment always replaces the host key. Store the returned
    // credential and matching private key in one atomic protected record.
    const privateKey = generateKeyPairSync("ed25519").privateKey;
    const credential = await controller.enroll(await readEnrollment(process.env.STACKPILOT_SSH_ENROLLMENT_FILE ?? "/etc/stackpilot-ssh-helper/enrollment-token"), createPublicKey(privateKey).export({ type: "spki", format: "pem" }).toString());
    if (credential.nodeId !== expectedNode) throw new Error("SSH enrollment targeted a different node");
    await store.saveEnrollment({ nodeId: credential.nodeId, credentialId: credential.credentialId }, privateKey.export({ type: "pkcs8", format: "pem" }).toString());
    process.stdout.write("SSH helper enrolled. SSH authentication configuration is unchanged.\n"); return;
  }
  if (process.argv[2] !== undefined && process.argv[2] !== "run") throw new Error("Unknown SSH helper command");
  const identity = { ...await store.identity(), privateKey: await store.key() };
  const processes = new ProcessInspector(); await processes.cgroup(process.pid);
  const services = new ServiceInspector();
  const accounts: AccountManager = new AccountManager(store, identity.nodeId, account => runtime.terminateAccount(account), unit => services.validate(unit)); await accounts.initialize();
  const runtime: SessionRuntime = new SessionRuntime(store, controller, identity, processes, new SessionScopes(), accounts); await runtime.initialize();
  const socket = await startPamSocket(runtime); let timer: NodeJS.Timeout | undefined; let reportTimer: NodeJS.Timeout | undefined; let stopped = false;
  const commands = new TakeoverCommands(store, accounts), completed = new Set<string>(); let working = false, receipt: SshTakeoverReceipt | null = null;
  const version = (JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;
  const tick = async () => {
    try {
      const desired = await runtime.synchronize();
      for (const policy of desired?.policies ?? []) {
        try { const receipt = await accounts.apply(policy); if (policy.appliedRevision !== policy.revision || policy.systemUid !== receipt.uid) await controller.policyAck(identity, policy, true, receipt.uid); }
        catch { await controller.policyAck(identity, policy, false).catch(() => undefined); process.stderr.write("SSH account policy could not be applied; access remains unavailable.\n"); }
      }
      if (receipt) {
        const pending = receipt;
        try { await controller.takeoverReceipt(identity, pending); completed.add(pending.commandId); receipt = null; }
        catch (error) { if (error instanceof ControllerError && error.status === 409) { completed.add(pending.commandId); receipt = null; } }
        while (completed.size > 128) completed.delete(completed.values().next().value!);
      }
      const command = desired?.takeover;
      if (command && !working && !receipt && !completed.has(command.id)) {
        working = true; void commands.execute(command).then(value => { receipt = value; }).catch(() => { receipt = { commandId: command.id, planId: command.planId, successful: false, inventory: null, local: null, error: "TRANSACTION_FAILED" }; }).finally(() => { working = false; });
      }
    } catch { process.stderr.write("SSH session reconciliation failed; local systemd deadlines remain active.\n"); }
    finally { if (!stopped) timer = setTimeout(() => void tick(), 10_000); }
  };
  const report = async () => {
    try {
      const inventory = await new SshPreflightInspector().inspect().then(value => SshInventorySchema.parse(value)).catch(() => null);
      await controller.report(identity, { collectedAt: new Date().toISOString(), platform, version, supported: !!inventory, reason: inventory ? "原生 SSH 入口预检正常" : "SSH 入口预检失败，暂停签发", inventory, takeover: await commands.local() });
    } catch { /* Local leases and rollback stay independent of status delivery. */ }
    finally { if (!stopped) reportTimer = setTimeout(() => void report(), 10_000); }
  };
  timer = setTimeout(() => void tick(), 0); reportTimer = setTimeout(() => void report(), 0);
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { stopped = true; clearTimeout(timer); clearTimeout(reportTimer); socket.close(); });
  process.stdout.write("SSH PAM helper listening on its root-only local socket.\n");
}
if (await isEntrypoint(import.meta.url)) void main().catch(() => { process.stderr.write("SSH helper failed. Verify root-only configuration and Controller trust.\n"); process.exitCode = 1; });
