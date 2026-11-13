import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, chown, lstat, mkdir, mkdtemp, readFile, rm, rename, symlink } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { sshAccountName } from "@stackpilot/contracts";
import { RootStore } from "../../apps/ssh-helper/dist/store.js";
import { ProbeKeys } from "../../apps/ssh-helper/dist/probeKeys.js";

test("public migration probes are plan-bound, idempotent and anchored against home symlink replacement", async () => {
  assert.equal(process.platform, "linux"); assert.equal(process.getuid(), 0); assert.equal(process.env.STACKPILOT_DISPOSABLE_SYSTEMD_TEST, "1");
  const state = await mkdtemp("/var/tmp/stackpilot-probe-key-"); await chmod(state, 0o700);
  const account = sshAccountName(randomUUID()), home = `/var/lib/stackpilot-ssh-users/${account}`;
  await mkdir("/var/lib/stackpilot-ssh-users", { recursive: true, mode: 0o755 }); await mkdir(home, { mode: 0o700 }); await chown(home, 123456, 123456);
  const store = new RootStore(state); await store.prepare(); const keys = new ProbeKeys(store);
  const input = { account, planId: randomUUID(), publicKey: `ssh-rsa ${'A'.repeat(200)}`, binding: { home, uid: 123456 } };
  try {
    await keys.prepare(input); await keys.prepare(input);
    const path = join(home, '.ssh', 'authorized_keys'); assert.match(await readFile(path, 'utf8'), /^restrict ssh-rsa /); assert.equal((await lstat(path)).uid, 0);
    await keys.remove(randomUUID(), account); assert((await readFile(path, 'utf8')).includes(input.planId));
    await keys.remove(input.planId, account); await keys.remove(input.planId, account);
    const next = { ...input, planId: randomUUID() }; await keys.prepare(next); assert((await readFile(path, 'utf8')).includes(next.planId));
    await rename(join(home, '.ssh'), join(home, 'saved-ssh')); await symlink('/etc', join(home, '.ssh'));
    await assert.rejects(keys.prepare(next)); await assert.rejects(keys.remove(next.planId, account));
  } finally { await rm(home, { recursive: true, force: true }); await rm(state, { recursive: true, force: true }); }
});
