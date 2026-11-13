import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rename } from "node:fs/promises";
import test from "node:test";
import { requireBootRecovery } from "../../apps/ssh-helper/dist/recoveryReadiness.js";

test("takeover requires persistent boot recovery on service and socket activation", { skip: process.env.STACKPILOT_INSTALLED_SSH_TEST !== "1" }, async () => {
  assert.equal(process.getuid(), 0);
  assert.equal(process.env.STACKPILOT_DISPOSABLE_SYSTEMD_TEST, "1");
  await requireBootRecovery();
  for (const name of ["ssh.service", "ssh.socket"]) {
    const link = `/etc/systemd/system/${name}.requires/stackpilot-ssh-boot-recovery.service`;
    const saved = `${link}.disposable-${randomUUID()}`;
    await rename(link, saved);
    try { await assert.rejects(requireBootRecovery()); }
    finally { await rename(saved, link); }
  }
  await requireBootRecovery();
});
