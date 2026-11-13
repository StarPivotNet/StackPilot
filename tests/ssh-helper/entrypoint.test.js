import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

test("installed current symlink runs the real entrypoint while module imports stay passive", { skip: process.platform === "win32" }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "stackpilot-ssh-entry-"));
  try {
    const entry = join(directory, "entry.mjs"), current = join(directory, "current.mjs"), importer = join(directory, "import.mjs");
    const utility = new URL("../../apps/ssh-helper/dist/entrypoint.js", import.meta.url).href;
    await writeFile(entry, `import { isEntrypoint } from ${JSON.stringify(utility)}; console.log(await isEntrypoint(import.meta.url));\n`);
    await symlink(entry, current); await writeFile(importer, `import ${JSON.stringify(pathToFileURL(entry).href)};\n`);
    const run = promisify(execFile);
    assert.equal((await run(process.execPath, [entry])).stdout.trim(), "true");
    assert.equal((await run(process.execPath, [current])).stdout.trim(), "true");
    assert.equal((await run(process.execPath, ["--preserve-symlinks-main", current])).stdout.trim(), "true");
    assert.equal((await run(process.execPath, [importer])).stdout.trim(), "false");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
