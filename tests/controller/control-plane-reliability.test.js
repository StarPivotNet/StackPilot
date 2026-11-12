import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { AGENT_PROTOCOL_VERSION, CreateRemoteTaskRequestSchema, RemoteTaskEnvelopeSchema } from "@stackpilot/contracts";
import { openDatabase } from "../../apps/controller/dist/database/database.js";
import { AuditRepository } from "../../apps/controller/dist/audit/auditRepository.js";
import { SecretStore } from "../../apps/controller/dist/security/secretStore.js";
import { SqliteAgentControlRepository } from "../../apps/controller/dist/repositories/sqliteAgentControlRepository.js";
import { MemoryAgentControlRepository } from "../../apps/controller/dist/repositories/agentControlRepository.js";
import { RemoteTaskService } from "../../apps/controller/dist/modules/remote-tasks/remoteTaskService.js";
import { NodeService } from "../../apps/controller/dist/modules/nodes/nodeService.js";
import { IdentityService } from "../../apps/controller/dist/identity/identityService.js";
import { routeControlPlaneRequest } from "../../apps/controller/dist/http/controlPlaneRouter.js";

import { routeTerminalRequest } from "../../apps/controller/dist/http/terminalRouter.js";

const capabilities = ["system.summary.read", "terminal.command.execute", "sites.lifecycle.manage"];
const terminalInput = (index) => ({ type: "terminal.command.execute", parameters: { command: "uptime" }, expiresInSeconds: 120, idempotencyKey: `reliability-terminal-${index}` });
const lifecycleInput = (index) => ({ type: "sites.lifecycle.update", parameters: { operationId: randomUUID(), siteId: "site-" + "a".repeat(32), action: "stopped", expectedVersion: 1 }, expiresInSeconds: 120, idempotencyKey: `reliability-site-${index}` });

async function fixture(kind, run) {
  const database = kind === "sqlite" ? openDatabase(":memory:") : null;
  const audit = database ? new AuditRepository(database, Buffer.alloc(32, 7)) : null;
  const secrets = database ? new SecretStore(database, Buffer.alloc(32, 8)) : null;
  const repository = database ? new SqliteAgentControlRepository(database, audit, secrets) : new MemoryAgentControlRepository();
  const nodeId = randomUUID();
  const now = new Date().toISOString();
  await repository.update((state) => state.nodes.push({ nodeId, nodeName: "reliability-node", status: "online", agentVersion: "0.3.0", protocolVersion: AGENT_PROTOCOL_VERSION, platform: "linux", declaredCapabilities: capabilities, allowedCapabilities: capabilities, enrolledAt: now, lastSeenAt: now, revokedAt: null }));
  try { await run({ database, audit, secrets, repository, nodeId, tasks: new RemoteTaskService(repository) }); }
  finally { database?.close(); }
}

for (const kind of ["memory", "sqlite"]) {
  test(`${kind}: ten single-attempt tasks drain within capacity and lost polls redeliver the same attempt`, () => fixture(kind, async ({ repository, nodeId, tasks }) => {
    for (let index = 0; index < 10; index++) await tasks.create(nodeId, terminalInput(index), "operator", randomUUID());
    const first = await tasks.poll(nodeId, randomUUID());
    assert.equal(first.length, 4);
    assert.deepEqual(await tasks.poll(nodeId, randomUUID()), first);
    await repository.update((state) => { for (const task of state.tasks) if (task.status === "dispatched") task.updatedAt = new Date(Date.now() - 60_000).toISOString(); });
    const recovered = await tasks.poll(nodeId, randomUUID());
    assert.deepEqual(recovered.map((task) => [task.taskId, task.attempt]), first.map((task) => [task.taskId, 1]));
    const executed = new Set();
    for (let round = 0; round < 3; round++) {
      const batch = await tasks.poll(nodeId, randomUUID());
      assert.equal(batch.length, round === 2 ? 2 : 4);
      for (const task of batch) {
        assert.equal(executed.has(task.taskId), false);
        await tasks.update(nodeId, { taskId: task.taskId, attempt: 1, status: "running", timestamp: new Date().toISOString() }, randomUUID());
      }
      if (batch.length === 4) assert.equal((await tasks.poll(nodeId, randomUUID())).length, 0);
      for (const task of batch) {
        await tasks.update(nodeId, { taskId: task.taskId, attempt: 1, status: "succeeded", timestamp: new Date().toISOString(), result: { message: "ok", truncated: false } }, randomUUID());
        executed.add(task.taskId);
      }
    }
    assert.equal(executed.size, 10);
    assert.equal((await tasks.poll(nodeId, randomUUID())).length, 0);
    assert.ok((await repository.read()).tasks.every((task) => task.attempt === 1 && task.status === "succeeded"));
  }));

  test(`${kind}: site tasks serialize without blocking independent work`, () => fixture(kind, async ({ nodeId, tasks }) => {
    const site = await tasks.create(nodeId, lifecycleInput(1), "site-service", randomUUID());
    await tasks.create(nodeId, lifecycleInput(2), "site-service", randomUUID());
    for (let index = 0; index < 3; index++) await tasks.create(nodeId, terminalInput(index), "operator", randomUUID());
    const batch = await tasks.poll(nodeId, randomUUID());
    assert.equal(batch.length, 4);
    assert.equal(batch.filter((task) => task.type.startsWith("sites.")).length, 1);
    for (const task of batch) await tasks.update(nodeId, { taskId: task.taskId, attempt: 1, status: "running", timestamp: new Date().toISOString() }, randomUUID());
    assert.equal((await tasks.poll(nodeId, randomUUID())).length, 0);
    await tasks.update(nodeId, { taskId: site.taskId, attempt: 1, status: "succeeded", timestamp: new Date().toISOString() }, randomUUID());
    const next = await tasks.poll(nodeId, randomUUID());
    assert.equal(next.length, 1);
    assert.equal(next[0].type, "sites.lifecycle.update");
    assert.equal(next[0].attempt, 1);
  }));

  test(`${kind}: persisted historical results are accepted idempotently but future and pre-creation events are rejected`, () => fixture(kind, async ({ repository, nodeId, tasks }) => {
    const task = await tasks.create(nodeId, terminalInput(0), "operator", randomUUID());
    await tasks.poll(nodeId, randomUUID());
    await repository.update((state) => { state.tasks[0].createdAt = new Date(Date.now() - 15 * 60_000).toISOString(); });
    const result = { taskId: task.taskId, attempt: 1, status: "succeeded", timestamp: new Date(Date.now() - 6 * 60_000).toISOString(), result: { message: "persisted success", truncated: false } };
    assert.equal((await tasks.update(nodeId, result, randomUUID())).status, "succeeded");
    const before = (await repository.read()).audits.length;
    assert.equal((await tasks.update(nodeId, result, randomUUID())).status, "succeeded");
    assert.equal((await repository.read()).audits.length, before);
    await assert.rejects(tasks.update(nodeId, { ...result, timestamp: new Date(Date.now() + 6 * 60_000).toISOString() }, randomUUID()), /未来/);
    await assert.rejects(tasks.update(nodeId, { ...result, timestamp: new Date(Date.now() - 30 * 60_000).toISOString() }, randomUUID()), /创建时间/);
  }));

  test(`${kind}: the third read-only execution attempt remains valid and retries stop there`, () => fixture(kind, async ({ repository, nodeId, tasks }) => {
    const created = await tasks.create(nodeId, { type: "system.summary.read", parameters: { includeLoad: false }, expiresInSeconds: 900, idempotencyKey: "three-attempt-summary" }, "operator", randomUUID());
    for (let attempt = 1; attempt <= 3; attempt++) {
      const [task] = await tasks.poll(nodeId, randomUUID());
      assert.equal(RemoteTaskEnvelopeSchema.parse(task).attempt, attempt);
      const failed = await tasks.update(nodeId, { taskId: created.taskId, attempt, status: "failed", timestamp: new Date().toISOString(), errorCode: "TRANSIENT" }, randomUUID());
      assert.equal(failed.status, attempt < 3 ? "queued" : "failed");
      assert.equal((await tasks.update(nodeId, { taskId: created.taskId, attempt, status: "failed", timestamp: new Date().toISOString(), errorCode: "TRANSIENT" }, randomUUID())).status, failed.status);
      await repository.update((state) => { state.tasks[0].nextAttemptAt = null; });
    }
    assert.equal((await tasks.poll(nodeId, randomUUID())).length, 0);
  }));
}

test("generic user tasks cannot bypass site workflows or terminal permissions", () => fixture("sqlite", async ({ database, nodeId, tasks }) => {
  const identity = new IdentityService(database, Buffer.alloc(32, 4));
  const principal = { userId: randomUUID(), permissions: new Set(["tasks:create"]), nodeScope: [nodeId] };
  let confirmations = 0;
  identity.consumeReauth = () => { confirmations++; };
  const response = { setHeader() {}, end() {} };
  const context = (body) => ({ request: { method: "POST", headers: {} }, response, parts: ["api", "nodes", nodeId, "tasks"], principal, identity, body, requestId: randomUUID(), services: { remoteTasks: tasks } });
  await assert.rejects(routeControlPlaneRequest(context(CreateRemoteTaskRequestSchema.parse(lifecycleInput(0)))), (error) => error.status === 403);
  await assert.rejects(routeControlPlaneRequest(context(terminalInput(0))), (error) => error.status === 403);
  principal.permissions.add("sites:operate"); principal.permissions.add("sites:deploy");
  await assert.rejects(routeControlPlaneRequest(context(lifecycleInput(1))), (error) => error.status === 403);
  assert.equal(confirmations, 0);
  assert.equal((await tasks.listReadOnly()).length, 0);
  await assert.rejects(tasks.createForUser(randomUUID(), terminalInput(1), "operator", randomUUID(), principal, () => {}), (error) => error.status === 403);
  await routeControlPlaneRequest(context({ type: "system.summary.read", parameters: { includeLoad: false }, expiresInSeconds: 60, idempotencyKey: "authorized-user-summary" }));
  assert.equal(response.statusCode, 201);
  assert.equal(confirmations, 1);
  principal.permissions.add("terminal:execute");
  await routeControlPlaneRequest(context(terminalInput(1)));
  assert.equal(response.statusCode, 201);
  assert.equal(confirmations, 2);
}));

test("SQLite: audit failure rolls back state, encrypted payload and both audit records", () => fixture("sqlite", async ({ database, repository, audit, secrets, nodeId }) => {
  let fail = false;
  const guardedAudit = { append(event) { audit.append(event); if (fail) throw new Error("INJECTED_AUDIT_FAILURE"); } };
  const guarded = new SqliteAgentControlRepository(database, guardedAudit, secrets);
  const tasks = new RemoteTaskService(guarded);
  const task = await tasks.create(nodeId, terminalInput(0), "operator", randomUUID());
  const originalPayload = database.prepare("SELECT * FROM encrypted_secrets WHERE key=?").get(`remote-task:${task.taskId}`);
  const originalAudits = audit.verify();
  const originalState = await repository.read();
  fail = true;
  await assert.rejects(tasks.poll(nodeId, randomUUID()), /INJECTED_AUDIT_FAILURE/);
  assert.deepEqual(await repository.read(), originalState);
  assert.deepEqual(database.prepare("SELECT * FROM encrypted_secrets WHERE key=?").get(`remote-task:${task.taskId}`), originalPayload);
  assert.deepEqual(audit.verify(), originalAudits);
  await assert.rejects(guarded.updateNodeWithAudit(nodeId, (node) => { node.nodeName = "must-rollback"; return { eventId: randomUUID(), timestamp: new Date().toISOString(), requester: "operator", nodeId, taskId: null, event: "node.changed", taskType: null, parameters: null, fromStatus: null, toStatus: null, resultSummary: null, traceId: randomUUID() }; }), /INJECTED_AUDIT_FAILURE/);
  assert.deepEqual(await repository.read(), originalState);
  assert.deepEqual(audit.verify(), originalAudits);
  fail = false;
  assert.equal((await tasks.poll(nodeId, randomUUID()))[0].attempt, 1);
  assert.equal(audit.verify().valid, true);
}));

test("SQLite: scoped reads and node updates do not decrypt or rewrite historical tasks", () => fixture("sqlite", async ({ database, repository, nodeId, tasks }) => {
  const old = await tasks.create(nodeId, terminalInput(0), "operator", randomUUID());
  await database.prepare("UPDATE remote_tasks SET status='succeeded',payload=? WHERE task_id=?").run(JSON.stringify({ encryptedTaskKey: "unavailable-history-key" }), old.taskId);
  database.exec("CREATE TRIGGER forbid_history_rewrite BEFORE UPDATE ON remote_tasks BEGIN SELECT RAISE(ABORT,'historical tasks must not be rewritten'); END");
  const nodes = new NodeService(repository);
  assert.equal((await nodes.list()).length, 1);
  assert.equal((await tasks.poll(nodeId, randomUUID())).length, 0);
  await repository.update((state) => { state.nodes[0].nodeName = "updated-node"; }, { sections: ["nodes"], nodeId });
  assert.equal((await repository.read({ sections: ["nodes"] })).nodes[0].nodeName, "updated-node");
  assert.equal(database.prepare("SELECT payload FROM remote_tasks WHERE task_id=?").get(old.taskId).payload, JSON.stringify({ encryptedTaskKey: "unavailable-history-key" }));
}));

test("SQLite: unrelated task history keeps its ciphertext and version during new work", () => fixture("sqlite", async ({ database, nodeId, tasks }) => {
  const old = await tasks.create(nodeId, terminalInput(0), "operator", randomUUID());
  await tasks.poll(nodeId, randomUUID());
  await tasks.update(nodeId, { taskId: old.taskId, attempt: 1, status: "succeeded", timestamp: new Date().toISOString() }, randomUUID());
  const cipher = database.prepare("SELECT * FROM encrypted_secrets WHERE key=?").get(`remote-task:${old.taskId}`);
  const version = database.prepare("SELECT version FROM remote_tasks WHERE task_id=?").get(old.taskId).version;
  database.exec(`CREATE TRIGGER forbid_completed_task_rewrite BEFORE UPDATE ON remote_tasks WHEN OLD.task_id='${old.taskId}' BEGIN SELECT RAISE(ABORT,'completed task was rewritten'); END`);
  await tasks.create(nodeId, terminalInput(1), "operator", randomUUID());
  assert.equal((await tasks.poll(nodeId, randomUUID())).length, 1);
  assert.deepEqual(database.prepare("SELECT * FROM encrypted_secrets WHERE key=?").get(`remote-task:${old.taskId}`), cipher);
  assert.equal(database.prepare("SELECT version FROM remote_tasks WHERE task_id=?").get(old.taskId).version, version);
}));

for (const kind of ["memory", "sqlite"]) {
  test(`${kind}: task history filters node scope before applying its page limit`, () => fixture(kind, async ({ repository, nodeId, tasks }) => {
    const first = await tasks.create(nodeId, terminalInput(0), "operator", randomUUID());
    const otherNodeId = randomUUID();
    await repository.update((state) => {
      state.tasks.push(...Array.from({ length: 205 }, (_, index) => ({ ...first, taskId: randomUUID(), targetNodeId: otherNodeId, status: "succeeded", idempotencyKey: `other-node-history-${index}`, updatedAt: new Date(Date.now() + index + 1).toISOString() })));
    });
    assert.equal((await tasks.listReadOnly(undefined, "all", 1))[0].targetNodeId, otherNodeId);
    assert.equal((await tasks.listReadOnly(undefined, [nodeId], 1))[0].taskId, first.taskId);
    assert.deepEqual(await tasks.listReadOnly(undefined, [], 1), []);
    assert.equal((await repository.read({ sections: ["tasks"], nodeId: otherNodeId })).tasks.length, 205);
  }));
}

for (const kind of ["memory", "sqlite"]) {
  test(`${kind}: terminal history filters node scope, requester and terminal key before pagination`, () => fixture(kind, async ({ repository, nodeId, tasks }) => {
    const userId = randomUUID();
    const own = await tasks.create(nodeId, { ...terminalInput(0), idempotencyKey: "terminal:current-user-history" }, `user:${userId}`, randomUUID());
    await repository.update((state) => {
      for (let index = 0; index < 205; index++) {
        const newer = { ...own, taskId: randomUUID(), status: "succeeded", updatedAt: new Date(Date.now() + index + 1000).toISOString() };
        state.tasks.push({ ...newer, requester: `user:${randomUUID()}`, idempotencyKey: `terminal:other-user-${index}` });
        state.tasks.push({ ...newer, taskId: randomUUID(), idempotencyKey: `non-terminal-current-user-${index}` });
        state.tasks.push({ ...newer, taskId: randomUUID(), targetNodeId: randomUUID(), idempotencyKey: `terminal:other-node-${index}` });
      }
    });
    let payload;
    const response = { setHeader() {}, end(body) { payload = JSON.parse(body); } };
    const context = { request: { method: "GET" }, response, parts: ["api", "terminal", "tasks"], identity: { require() {} }, principal: { userId, nodeScope: [nodeId] }, services: { remoteTasks: tasks } };
    await routeTerminalRequest(context);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(payload.tasks.map((task) => task.taskId), [own.taskId]);
    context.principal.nodeScope = "all";
    await routeTerminalRequest(context);
    assert.equal(payload.tasks.length, 200);
    assert.ok(payload.tasks.every((task) => task.requester === `user:${userId}` && task.idempotencyKey.startsWith("terminal:")));
  }));
}
