import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, lstat, writeFile, rm, unlink } from "node:fs/promises";
import { createServer } from "node:net";
import { once } from "node:events";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

const execute = promisify(execFile);
test("native PAM ABI sends bound process identities and fails closed on invalid users, passwords and helper responses", async () => {
  assert.equal(process.platform, "linux"); assert.equal(process.getuid(), 0);
  assert.equal(process.env.STACKPILOT_DISPOSABLE_SYSTEMD_TEST, "1"); assert.equal(process.env.GITHUB_ACTIONS, "true");
  const path = "/run/stackpilot-ssh-helper/pam.sock"; assert.equal(await lstat(path).catch(error => { if (error.code === "ENOENT") return null; throw error; }), null, "Refuse to replace an existing PAM helper socket");
  await mkdir("/run/stackpilot-ssh-helper", { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(tmpdir(), "stackpilot-native-pam-")); const binary = join(directory, "pam-harness");
  const module = resolve("apps/ssh-helper/build/pam_stackpilot.so"); assert((await lstat(module)).isFile());
  await execute("/usr/bin/cc", ["-std=c11", "-Wall", "-Wextra", "-Werror", "tests/ssh-helper-native/pam_harness.c", "-lpam", "-o", binary]);
  await writeFile(join(directory, "sshd"), `auth required ${module}\naccount required ${module}\nsession required ${module}\n`);
  const requests = []; let allow = true;
  const server = createServer(socket => { let raw = ""; socket.on("error", () => undefined); socket.on("data", chunk => { raw += chunk; if (raw.endsWith("\n")) { requests.push(JSON.parse(raw)); socket.end(allow ? "OK\n" : "NO\n"); } }); });
  server.listen(path); await once(server, "listening");
  const run = (account, token, action = "auth") => execute(binary, [directory, account, token, action], { timeout: 25_000 });
  try {
    await run("sp_test", "x".repeat(43), "session");
    assert.equal(requests[0].operation, "authenticate"); assert.equal(requests[0].monitorPid, process.pid); assert(requests[0].phasePid > 1); assert.equal(requests[0].account, "sp_test");
    assert.equal(requests.filter(value => value.operation === "check").length, 2);
    const count = requests.length;
    await assert.rejects(run("root", "x".repeat(43))); await assert.rejects(run("sp_injected;id", "x".repeat(43))); await assert.rejects(run("sp_test", "bad-token")); assert.equal(requests.length, count);
    allow = false; await assert.rejects(run("sp_test", "x".repeat(43)));
  } finally { server.close(); await once(server, "close"); await unlink(path).catch(error => { if (error.code !== "ENOENT") throw error; }); }
  try { await assert.rejects(run("sp_test", "x".repeat(43)), error => error.code === 1); } finally { await rm(directory, { recursive: true, force: true }); }
});
