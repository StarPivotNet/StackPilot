import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AGENT_PROTOCOL_VERSION } from "@stackpilot/contracts";
import { TaskExecutor } from "../../apps/agent/dist/tasks/executor.js";
import { taskRegistry } from "../../apps/agent/dist/tasks/registry.js";
import { flushTaskUpdates } from "../../apps/agent/dist/tasks/delivery.js";

const nodeId = randomUUID();
const task = () => ({ protocolVersion: AGENT_PROTOCOL_VERSION, taskId: randomUUID(), type: "system.summary.read", targetNodeId: nodeId, parameters: { includeLoad: false }, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), idempotencyKey: randomUUID(), requester: "test", traceId: randomUUID(), requiredCapability: "system.summary.read", attempt: 1, maxAttempts: 3 });

test("a rejected persisted result does not block other receipts and survives restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stackpilot-result-delivery-"));
  try {
    const registry = { ...taskRegistry, "system.summary.read": { ...taskRegistry["system.summary.read"], run: async () => ({ message: "ok", truncated: false }) } };
    const path = join(directory, "receipts.json");
    const executor = new TaskExecutor(path, nodeId, "linux", ["system.summary.read"], registry);
    await executor.load();
    const first = await executor.execute(task()), second = await executor.execute(task());
    const delivered = [], failed = [];
    await flushTaskUpdates(executor, async (update) => { if (update.taskId === first.taskId) throw new Error("REJECTED_RESULT"); delivered.push(update.taskId); }, (taskId) => failed.push(taskId));
    assert.deepEqual(delivered, [second.taskId]);
    assert.deepEqual(failed, [first.taskId]);
    assert.deepEqual(executor.pendingUpdates(), [first]);
    const restarted = new TaskExecutor(path, nodeId, "linux", ["system.summary.read"], registry);
    await restarted.load();
    assert.deepEqual(restarted.pendingUpdates(), [first]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("acknowledging a running receipt cannot discard a result completed during delivery", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stackpilot-result-race-"));
  let release;
  let execution;
  try {
    let started;
    const handlerStarted = new Promise((resolve) => { started = resolve; });
    const finish = new Promise((resolve) => { release = resolve; });
    const registry = { ...taskRegistry, "system.summary.read": { ...taskRegistry["system.summary.read"], run: async () => { started(); await finish; return { message: "completed while running receipt was in transit", truncated: false }; } } };
    const executor = new TaskExecutor(join(directory, "receipts.json"), nodeId, "linux", ["system.summary.read"], registry);
    await executor.load();
    execution = executor.execute(task());
    await handlerStarted;
    assert.equal(executor.pendingUpdates()[0].status, "running");
    await flushTaskUpdates(executor, async () => { release(); await execution; }, () => assert.fail("delivery should succeed"));
    const [terminal] = executor.pendingUpdates();
    assert.equal(terminal.status, "succeeded");
    const delivered = [];
    await flushTaskUpdates(executor, async (update) => { delivered.push(update); }, () => assert.fail("delivery should succeed"));
    assert.deepEqual(delivered, [terminal]);
    assert.deepEqual(executor.pendingUpdates(), []);
  } finally { release?.(); await execution; await rm(directory, { recursive: true, force: true }); }
});
