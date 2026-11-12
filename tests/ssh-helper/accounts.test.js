import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, chmod, chown, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { sshAccountName } from "@stackpilot/contracts";
import { RootStore } from "../../apps/ssh-helper/dist/store.js";
import { AccountManager } from "../../apps/ssh-helper/dist/accounts.js";

const rootLinux = process.platform === "linux" && process.getuid() === 0;
async function fixture(action) {
  const directory = await mkdtemp(join(tmpdir(), "stackpilot-account-test-")); await chmod(directory, 0o700);
  const store = new RootStore(join(directory, "state")); await store.prepare(); const paths = { homes: join(directory, "homes"), sudoers: join(directory, "sudoers"), grants: join(directory, "grants") }; await mkdir(paths.sudoers, { mode: 0o755 });
  const userId = randomUUID(); const policy = { id: randomUUID(), userId, nodeId: randomUUID(), account: sshAccountName(userId), profile: "shell", services: [], enabled: true, sessionSeconds: 60, revision: 1, appliedRevision: 0, updatedAt: new Date().toISOString() };
  let user = null; let creates = 0; let closures = 0; let creationFails = false;
  const run = async (file, args) => {
    if (file === "/usr/bin/getent" && args[0] === "passwd") {
      if (!args[1]) return "root:x:0:0:root:/root:/bin/bash\n";
      if (!user) throw Object.assign(new Error("missing"), { code: 2 }); return `${policy.account}:x:${user.uid}:${user.gid}::${user.home}:/bin/bash\n`;
    }
    if (file === "/usr/bin/getent" && args[0] === "group") return `${policy.account}:x:${user.gid}:\n`;
    if (file === "/usr/bin/id") return `${user.gid}\n`;
    if (file === "/usr/sbin/visudo") return "";
    if (file === "/usr/bin/sudo") {
      let contents = ""; try { contents = await readFile(join(paths.sudoers, `stackpilot-ssh-${policy.account}`), "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
      if (!contents) throw Object.assign(new Error("denied"), { code: 1, stderr: `User ${policy.account} is not allowed to run sudo on test.` });
      return `User ${policy.account} may run the following commands on test:\n    (root) ${contents.split("NOPASSWD:")[1] ? `NOPASSWD:${contents.split("NOPASSWD:")[1]}` : "ALL"}`;
    }
    if (file === "/usr/sbin/useradd") {
      creates++; if (creationFails) throw Object.assign(new Error("unknown outcome"), { code: "ETIMEDOUT" });
      const uid = Number(args[args.indexOf("--uid") + 1]); const home = args[args.indexOf("--home-dir") + 1]; await mkdir(home, { mode: 0o700 }); await chown(home, uid, uid); user = { uid, gid: uid, home }; return "";
    }
    throw new Error(`Unexpected executable ${file}`);
  };
  const make = () => new AccountManager(store, policy.nodeId, async () => { closures++; }, async () => undefined, run, paths);
  try { await action({ policy, paths, store, make, counts: () => ({ creates, closures }), failCreation: () => { creationFails = true; }, unmanaged: () => { user = { uid: 1000, gid: 1000, home: "/unmanaged" }; } }); } finally { await rm(directory, { recursive: true, force: true }); }
}
test("managed accounts are created once and unchanged reconciliation keeps live connections", { skip: !rootLinux }, async () => fixture(async ({ make, policy, counts }) => {
  const manager = make(); await manager.initialize(); const receipt = await manager.apply(policy); assert.equal(receipt.uid, 10_000); await manager.verify(policy.account);
  await manager.apply(policy); assert.deepEqual(counts(), { creates: 1, closures: 1 });
  const restarted = make(); await restarted.initialize(); await restarted.apply(policy); assert.deepEqual(counts(), { creates: 1, closures: 1 });
}));
test("explicit admin grants and disabling policy stop connections before changing sudo", { skip: !rootLinux }, async () => fixture(async ({ make, policy, paths, counts }) => {
  const manager = make(); await manager.initialize(); await manager.apply(policy);
  await manager.apply({ ...policy, revision: 2, profile: "host-admin" }); assert.match(await readFile(join(paths.sudoers, `stackpilot-ssh-${policy.account}`), "utf8"), /NOPASSWD: ALL/);
  await manager.apply({ ...policy, revision: 3, enabled: false }); await assert.rejects(manager.verify(policy.account));
  assert.deepEqual(counts(), { creates: 1, closures: 3 });
}));
test("unknown useradd outcomes are journaled and never blindly replayed", { skip: !rootLinux }, async () => fixture(async ({ make, policy, failCreation, counts, store }) => {
  const manager = make(); await manager.initialize(); failCreation(); await assert.rejects(manager.apply(policy));
  assert.equal(JSON.parse(await store.read("accounts.json"))[0].status, "create-dispatched");
  const restarted = make(); await restarted.initialize(); await assert.rejects(restarted.apply(policy), /manual recovery/); assert.equal(counts().creates, 1);
}));
test("existing accounts and pre-existing sudo grants are not adopted", { skip: !rootLinux }, async () => {
  await fixture(async ({ make, policy, unmanaged, counts }) => { unmanaged(); const manager = make(); await manager.initialize(); await assert.rejects(manager.apply(policy), /unmanaged account/); assert.equal(counts().creates, 0); });
  await fixture(async ({ make, policy, paths, counts }) => { await writeFile(join(paths.sudoers, `stackpilot-ssh-${policy.account}`), "unmanaged", { mode: 0o440 }); const manager = make(); await manager.initialize(); await assert.rejects(manager.apply(policy), /unmanaged sudo/); assert.equal(counts().creates, 0); });
});
