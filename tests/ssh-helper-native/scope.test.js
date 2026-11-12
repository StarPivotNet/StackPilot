import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { SessionScopes } from "../../apps/ssh-helper/dist/systemd.js";
import { ProcessInspector } from "../../apps/ssh-helper/dist/processes.js";

const execute = promisify(execFile);
test("real systemd scope owns the whole connection group and expires without the helper", { timeout: 30_000 }, async () => {
  assert.equal(process.platform, "linux"); assert.equal(process.getuid(), 0);
  assert.equal(process.env.STACKPILOT_DISPOSABLE_SYSTEMD_TEST, "1");
  assert.equal((await readFile("/proc/1/comm", "utf8")).trim(), "systemd");
  await assert.rejects(execute("/usr/bin/systemd-detect-virt", ["--container", "--quiet"]), error => error.code === 1);
  const name = `stackpilot-ssh-${randomUUID()}.scope`;
  const processes = new ProcessInspector(), scopes = new SessionScopes();
  const children = [spawn("/usr/bin/sleep", ["300"], { stdio: "ignore" }), spawn("/usr/bin/sleep", ["300"], { stdio: "ignore" })];
  try {
    await scopes.create(name, children.map(child => child.pid), 3000);
    for (const child of children) {
      let attached = false;
      for (let attempt = 0; attempt < 50; attempt++) { if ((await processes.cgroup(child.pid)).endsWith(`/${name}`)) { attached = true; break; } await delay(20); }
      assert(attached, "Systemd must attach each connection process");
    }
    const properties = (await execute("/usr/bin/systemctl", ["show", name, "-p", "Delegate", "-p", "KillMode", "-p", "SendSIGKILL", "-p", "RuntimeMaxUSec"])).stdout;
    assert.match(properties, /^Delegate=no$/m); assert.match(properties, /^KillMode=control-group$/m); assert.match(properties, /^SendSIGKILL=yes$/m); assert.match(properties, /^RuntimeMaxUSec=3s$/m);
    await assert.rejects(new SessionScopes().create(name, children.map(child => child.pid), 28_800_000));
    const until = Date.now() + 12_000;
    while (Date.now() < until && children.some(child => child.exitCode === null && child.signalCode === null)) await delay(50);
    assert(children.every(child => child.exitCode !== null || child.signalCode !== null), "Local systemd deadline must terminate every connection process");
    assert.equal((await processes.members(`/system.slice/${name}`)).length, 0);
  } finally {
    await scopes.stop(name).catch(() => undefined); for (const child of children) child.kill("SIGKILL");
    await execute("/usr/bin/systemctl", ["reset-failed", name]).catch(() => undefined);
  }
});
