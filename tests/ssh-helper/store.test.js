import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, chmod, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RootStore } from "../../apps/ssh-helper/dist/store.js";

const rootOnly = process.platform !== "linux" || process.getuid() === 0;
test("root store persists one private key and rejects unsafe file names", { skip: !rootOnly }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "stackpilot-ssh-store-"));
  try { await chmod(directory, 0o700); const store = new RootStore(directory); await store.prepare(); const first = await store.key(); const second = await store.key(); assert.equal(first.export({ type: "pkcs8", format: "pem" }), second.export({ type: "pkcs8", format: "pem" })); await assert.rejects(store.write("../identity.pem", "bad")); assert.match(await readFile(join(directory, "identity.pem"), "utf8"), /BEGIN PRIVATE KEY/); } finally { await rm(directory, { recursive: true, force: true }); }
});
test("Linux state requires root ownership and mode 0700", { skip: process.platform !== "linux" }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "stackpilot-ssh-permissions-"));
  try { await chmod(directory, 0o755); await assert.rejects(new RootStore(directory).prepare()); } finally { await rm(directory, { recursive: true, force: true }); }
});
test("Linux root store refuses symlinks and group-readable credential files", { skip: process.platform !== "linux" || !rootOnly }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "stackpilot-ssh-links-"));
  try { await chmod(directory, 0o700); const store = new RootStore(directory); await store.prepare(); const outside = join(directory, "outside"); await writeFile(outside, "secret", { mode: 0o600 }); await symlink(outside, join(directory, "identity.json")); await assert.rejects(store.read("identity.json")); await rm(join(directory, "identity.json")); await writeFile(join(directory, "identity.json"), "{}", { mode: 0o640 }); await assert.rejects(store.read("identity.json")); } finally { await rm(directory, { recursive: true, force: true }); }
});
