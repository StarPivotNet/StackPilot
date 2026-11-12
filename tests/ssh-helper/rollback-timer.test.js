import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { RollbackTimer } from "../../apps/ssh-helper/dist/rollbackTimer.js";

test("rollback timer cancellation tolerates reboot and transient unit collection", async () => {
  const id = randomUUID(), calls = [];
  await new RollbackTimer(async (_, args) => { calls.push(args); return 'not-found\n'; }).cancel(id);
  assert.equal(calls.length, 1); assert.equal(calls[0][0], 'show');
  let reads = 0;
  await new RollbackTimer(async (_, args) => { if (args[0] === 'show') return ++reads === 1 ? 'loaded\n' : 'not-found\n'; throw new Error('collected between read and stop'); }).cancel(id);
  await assert.rejects(new RollbackTimer(async () => 'loaded\n').cancel('not-a-plan'));
  await assert.rejects(new RollbackTimer(async (_, args) => { if (args[0] === 'show') return 'loaded\n'; throw new Error('stop failed'); }).cancel(id), /stop failed/);
});
test("rollback readiness binds the expected timer, service and suspend-aware clock", async () => {
  const id = randomUUID(), valid = `ActiveState=active\nSubState=waiting\nUnit=stackpilot-ssh-rollback@${id}.service\nWakeSystem=yes\n`;
  assert.equal(await new RollbackTimer(async () => valid).armed(id), true);
  for (const output of [valid.replace('waiting', 'elapsed'), valid.replace('WakeSystem=yes', 'WakeSystem=no'), valid.replace(id, randomUUID())]) assert.equal(await new RollbackTimer(async () => output).armed(id), false);
});
