import assert from "node:assert/strict";
import { mkdtemp, chmod, stat, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { atomicRootFile } from "../../apps/ssh-helper/dist/files.js";

test("atomic root files preserve requested restore permissions under the strict service umask", { skip: process.platform !== "linux" || process.getuid() !== 0 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "stackpilot-ssh-file-mode-")); await chmod(directory, 0o700);
  const previous = process.umask(0o077);
  try {
    const path = join(directory, "config"); await atomicRootFile(path, "restored configuration\n", 0o644);
    assert.equal((await stat(path)).mode & 0o777, 0o644); assert.equal(await readFile(path, "utf8"), "restored configuration\n");
    await atomicRootFile(path, "sudo policy\n", 0o440); assert.equal((await stat(path)).mode & 0o777, 0o440);
  } finally { process.umask(previous); await rm(directory, { recursive: true, force: true }); }
});
