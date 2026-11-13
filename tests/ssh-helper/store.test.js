import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, chmod, writeFile, symlink, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createPublicKey, generateKeyPairSync, randomUUID } from "node:crypto";
import { RootStore } from "../../apps/ssh-helper/dist/store.js";

const rootOnly = process.platform !== "linux" || process.getuid() === 0;
test("explicit enrollment atomically binds a fresh private key and keeps identity metadata secret-free", { skip: !rootOnly }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "stackpilot-ssh-enrollment-"));
  try {
    await chmod(directory, 0o700); const store = new RootStore(directory); await store.prepare();
    const original = createPublicKey(await store.key()).export({ type: "spki", format: "pem" });
    const nodeId = randomUUID();
    for (let attempt = 0; attempt < 2; attempt++) {
      const pair = generateKeyPairSync("ed25519"), credentialId = randomUUID();
      await store.saveEnrollment({ nodeId, credentialId }, pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString());
      const reopened = new RootStore(directory); await reopened.prepare();
      assert.deepEqual(await reopened.identity(), { nodeId, credentialId });
      assert.equal(createPublicKey(await reopened.key()).export({ type: "spki", format: "pem" }), pair.publicKey.export({ type: "spki", format: "pem" }));
      assert.notEqual(createPublicKey(await reopened.key()).export({ type: "spki", format: "pem" }), original);
      const before = await readFile(join(directory, "identity.json"), "utf8");
      await assert.rejects(store.saveEnrollment({ nodeId, credentialId: randomUUID() }, generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString()));
      assert.equal(await readFile(join(directory, "identity.json"), "utf8"), before);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test("root store persists one private key and rejects unsafe file names", { skip: !rootOnly }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "stackpilot-ssh-store-"));
  try { await chmod(directory, 0o700); const store = new RootStore(directory); await store.prepare(); const first = await store.key(); const second = await store.key(); assert.equal(first.export({ type: "pkcs8", format: "pem" }), second.export({ type: "pkcs8", format: "pem" })); await assert.rejects(store.write("../identity.pem", "bad")); assert.match(await readFile(join(directory, "identity.pem"), "utf8"), /BEGIN PRIVATE KEY/); } finally { await rm(directory, { recursive: true, force: true }); }
});
test("Linux state requires root ownership and mode 0700", { skip: process.platform !== "linux" }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "stackpilot-ssh-permissions-"));
  try { await chmod(directory, 0o755); await assert.rejects(new RootStore(directory).prepare()); } finally { await rm(directory, { recursive: true, force: true }); }
});

test("Linux state refuses a root-owned leaf inside a writable ancestor", { skip: process.platform !== "linux" || !rootOnly }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "stackpilot-ssh-parent-")); const state = join(directory, "state");
  try { await chmod(directory, 0o777); await mkdir(state, { mode: 0o700 }); await assert.rejects(new RootStore(state).prepare()); } finally { await rm(directory, { recursive: true, force: true }); }
});
test("Linux root store refuses symlinks and group-readable credential files", { skip: process.platform !== "linux" || !rootOnly }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "stackpilot-ssh-links-"));
  try { await chmod(directory, 0o700); const store = new RootStore(directory); await store.prepare(); const outside = join(directory, "outside"); await writeFile(outside, "secret", { mode: 0o600 }); await symlink(outside, join(directory, "identity.json")); await assert.rejects(store.read("identity.json")); await rm(join(directory, "identity.json")); await writeFile(join(directory, "identity.json"), "{}", { mode: 0o640 }); await assert.rejects(store.read("identity.json")); } finally { await rm(directory, { recursive: true, force: true }); }
});
