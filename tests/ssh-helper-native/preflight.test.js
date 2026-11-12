import assert from "node:assert/strict";
import { readFile, writeFile, unlink, mkdtemp, rm } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { createServer, createConnection } from "node:net";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import test from "node:test";
import { SshPreflightInspector } from "../../apps/ssh-helper/dist/preflight.js";
import { managedSshConfiguration, verifyManagedSshConfiguration } from "../../apps/ssh-helper/dist/sshConfiguration.js";

test("native preflight inventories all entrances and rejects extra SSH servers without changing authentication", { timeout: 90_000 }, async () => {
  assert.equal(process.platform, "linux"); assert.equal(process.getuid(), 0); assert.equal(process.env.STACKPILOT_DISPOSABLE_SYSTEMD_TEST, "1");
  assert.equal((await readFile("/proc/1/comm", "utf8")).trim(), "systemd");
  const inspector = new SshPreflightInspector(), config = await readFile("/etc/ssh/sshd_config", "utf8"), pam = await readFile("/etc/pam.d/sshd", "utf8");
  const result = await inspector.inspect(); assert.equal(result.digest.length, 64); assert(result.listeners.length); assert(result.fingerprints.length);
  assert(result.files.some(value => value.path === "/etc/ssh/sshd_config")); assert(result.files.some(value => value.path === "/etc/pam.d/sshd"));
  assert.equal(await readFile("/etc/ssh/sshd_config", "utf8"), config); assert.equal(await readFile("/etc/pam.d/sshd", "utf8"), pam);
  // A new Include changes the receipt, even when it does not change authentication.
  const path = "/etc/ssh/sshd_config.d/99-stackpilot-disposable-preflight.conf";
  await writeFile(path, "# disposable preflight receipt probe\n", { mode: 0o644, flag: "wx" });
  try { assert.notEqual((await inspector.inspect()).digest, result.digest); } finally { await unlink(path); }
  assert.equal((await inspector.inspect()).digest, result.digest);
  const directory = await mkdtemp("/var/tmp/stackpilot-ssh-config-");
  try {
    const managed = `${directory}/sshd_config`; await writeFile(managed, managedSshConfiguration(result), { mode: 0o600 });
    await promisify(execFile)("/usr/sbin/sshd", ["-t", "-f", managed]);
    for (const user of ["root", "sp_probe", "nobody"]) verifyManagedSshConfiguration((await promisify(execFile)("/usr/sbin/sshd", ["-T", "-f", managed, "-C", `user=${user},host=localhost,addr=127.0.0.1,laddr=127.0.0.1,lport=22`])).stdout);
  } finally { await rm(directory, { recursive: true, force: true }); }
  const unknown = createServer(socket => socket.end("SSH-2.0-Dropbear_disposable_probe\r\n")); unknown.listen(0, "127.0.0.1"); await once(unknown, "listening");
  const port = unknown.address().port;
  try { await assert.rejects(inspector.inspect(), /outside the managed service/); } finally { unknown.close(); await once(unknown, "close"); }
  const alternative = spawn("/usr/sbin/sshd", ["-D", "-e", "-p", String(port), "-o", "ListenAddress=127.0.0.1", "-o", "PidFile=none"], { stdio: "ignore" });
  try {
    let ready = false;
    for (let attempt = 0; attempt < 50; attempt++) {
      ready = await new Promise(resolve => { const socket = createConnection({ host: "127.0.0.1", port }); socket.on("connect", () => { socket.destroy(); resolve(true); }); socket.on("error", () => resolve(false)); });
      if (ready) break; await delay(20);
    }
    assert(ready); await assert.rejects(inspector.inspect(), /outside the managed service/);
  } finally { const exited = once(alternative, "exit"); alternative.kill("SIGKILL"); await exited; }
  assert.equal(await readFile("/etc/ssh/sshd_config", "utf8"), config); assert.equal(await readFile("/etc/pam.d/sshd", "utf8"), pam);
  const output = await promisify(execFile)("/usr/sbin/sshd", ["-T"]); assert.match(output.stdout, /^pubkeyauthentication yes$/m);
});
