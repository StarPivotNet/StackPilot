import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import test from "node:test";
import { AGENT_PROTOCOL_VERSION, agentSignaturePayload } from "@stackpilot/contracts";
import { EnrollmentService } from "../../apps/controller/dist/modules/enrollments/enrollmentService.js";
import { routeControlPlaneRequest } from "../../apps/controller/dist/http/controlPlaneRouter.js";
import { routeAgentRequest } from "../../apps/controller/dist/http/agentRouter.js";
import { NodeService } from "../../apps/controller/dist/modules/nodes/nodeService.js";
import { RemoteTaskService, transitionTask } from "../../apps/controller/dist/modules/remote-tasks/remoteTaskService.js";
import { MemoryAgentControlRepository } from "../../apps/controller/dist/repositories/agentControlRepository.js";

function keys() { const pair = generateKeyPairSync("ed25519"); return { privateKey: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(), publicKey: pair.publicKey.export({ type: "spki", format: "pem" }).toString() }; }
async function enrolledFixture() {
  const repository = new MemoryAgentControlRepository(); const enrollments = new EnrollmentService(repository); const pair = keys();
  const created = await enrollments.create({ nodeName: "node-a", expiresInSeconds: 300 }, "admin", crypto.randomUUID());
  const enrolled = await enrollments.enroll({ enrollmentToken: created.token, nodeName: "node-a", publicKey: pair.publicKey, agentVersion: "0.1.0", protocolVersion: AGENT_PROTOCOL_VERSION, platform: "linux", capabilities: ["system.summary.read", "service.status.read"] }, crypto.randomUUID());
  return { repository, enrollments, pair, created, enrolled, nodes: new NodeService(repository, 10), tasks: new RemoteTaskService(repository, 2) };
}

test("enrollment token is purpose-bound, single-use, expiring and revocable", async () => {
  const fixture = await enrolledFixture();
  await assert.rejects(() => fixture.enrollments.enroll({ enrollmentToken: fixture.created.token, nodeName: "node-a", publicKey: keys().publicKey, agentVersion: "0.1.0", protocolVersion: AGENT_PROTOCOL_VERSION, platform: "linux", capabilities: [] }, crypto.randomUUID()), (error) => error.status === 401);
  const other = await fixture.enrollments.create({ nodeName: "node-b", expiresInSeconds: 300 }, "admin", crypto.randomUUID()); await fixture.enrollments.revoke(other.enrollmentId, "admin", crypto.randomUUID());
  await assert.rejects(() => fixture.enrollments.enroll({ enrollmentToken: other.token, nodeName: "node-b", publicKey: keys().publicKey, agentVersion: "0.1.0", protocolVersion: AGENT_PROTOCOL_VERSION, platform: "linux", capabilities: [] }, crypto.randomUUID()), (error) => error.status === 401);
  const state = await fixture.repository.read(); assert.ok(state.enrollments.every((item) => !Object.hasOwn(item, "token")));
  const expired = await fixture.enrollments.create({ nodeName: "expired", expiresInSeconds: 60 }, "admin", crypto.randomUUID());
  await fixture.repository.update((next) => { next.enrollments.find((item) => item.enrollmentId === expired.enrollmentId).expiresAt = new Date(Date.now() - 1).toISOString(); });
  await assert.rejects(() => fixture.enrollments.enroll({ enrollmentToken: expired.token, nodeName: "expired", publicKey: keys().publicKey, agentVersion: "0.1.0", protocolVersion: AGENT_PROTOCOL_VERSION, platform: "linux", capabilities: [] }, crypto.randomUUID()), (error) => error.status === 401);
});

test("signed identity rejects forged, replayed, stale and incompatible requests", async () => {
  const fixture = await enrolledFixture(); const body = Buffer.from("{}");
  const input = { protocolVersion: AGENT_PROTOCOL_VERSION, nodeId: fixture.enrolled.nodeId, credentialId: fixture.enrolled.credentialId, method: "POST", path: "/api/agent/heartbeat", timestamp: new Date().toISOString(), nonce: randomBytes(18).toString("base64url"), bodySha256: createHash("sha256").update(body).digest("hex") };
  const signed = { ...input, signature: sign(null, Buffer.from(agentSignaturePayload(input)), fixture.pair.privateKey).toString("base64url") };
  assert.equal((await fixture.nodes.authenticate(signed)).nodeId, fixture.enrolled.nodeId);
  await assert.rejects(() => fixture.nodes.authenticate(signed), /重放/);
  await assert.rejects(() => fixture.nodes.authenticate({ ...signed, nonce: randomBytes(18).toString("base64url"), signature: sign(null, Buffer.from("forged"), fixture.pair.privateKey).toString("base64url") }), (error) => error.status === 401);
  await assert.rejects(() => fixture.nodes.authenticate({ ...signed, protocolVersion: "2.0", nonce: randomBytes(18).toString("base64url") }), /不兼容/);
  await assert.rejects(() => fixture.nodes.authenticate({ ...signed, timestamp: new Date(Date.now() - 600_000).toISOString(), nonce: randomBytes(18).toString("base64url") }), /时间/);
});

test("heartbeat controls online/offline lifecycle and node revocation rejects identity", async () => {
  const fixture = await enrolledFixture();
  await fixture.nodes.heartbeat(fixture.enrolled.nodeId, { nodeId: fixture.enrolled.nodeId, agentVersion: "0.1.0", protocolVersion: AGENT_PROTOCOL_VERSION, timestamp: new Date().toISOString(), platform: "linux", capabilities: ["system.summary.read"], health: { status: "healthy", uptimeSeconds: 10 } }, crypto.randomUUID());
  assert.equal((await fixture.nodes.list())[0].status, "online"); await new Promise((resolve) => setTimeout(resolve, 15)); assert.equal((await fixture.nodes.list())[0].status, "offline");
  await fixture.nodes.revoke(fixture.enrolled.nodeId, "admin", crypto.randomUUID()); assert.equal((await fixture.nodes.list())[0].status, "revoked");
});

test("heartbeat persists optional site snapshots and legacy heartbeats preserve the last snapshot", async () => {
  const fixture = await enrolledFixture();
  const heartbeat = { nodeId: fixture.enrolled.nodeId, agentVersion: "0.1.0", protocolVersion: AGENT_PROTOCOL_VERSION, timestamp: new Date().toISOString(), platform: "linux", capabilities: ["sites.inventory.read"], health: { status: "healthy", uptimeSeconds: 10 } };
  const siteSnapshot = { collectedAt: new Date().toISOString(), collectionStatus: "complete", warnings: [], sites: [] };
  await fixture.nodes.heartbeat(fixture.enrolled.nodeId, { ...heartbeat, siteSnapshot }, crypto.randomUUID());
  assert.deepEqual((await fixture.repository.read()).nodes[0].siteSnapshot, siteSnapshot);
  await fixture.nodes.heartbeat(fixture.enrolled.nodeId, { ...heartbeat, timestamp: new Date().toISOString() }, crypto.randomUUID());
  assert.deepEqual((await fixture.repository.read()).nodes[0].siteSnapshot, siteSnapshot);
});

test("legacy database heartbeat is ingested only with the declared inventory capability", async () => {
  const fixture = await enrolledFixture(); const ingested = [];
  const instance = { id: "postgresql.service", name: "postgresql", engine: "postgresql", version: null, host: "node-a", port: null, status: "running", source: "systemd:postgresql.service", latencyMs: null, storageBytes: null, activeConnections: null, maxConnections: null, slowQueryCount: null, backupStatus: "unavailable", lastBackupAt: null, accessMode: "unknown", owner: null, region: null, autoBackup: null, remoteAccess: null };
  const response = () => ({ statusCode: 0, headers: {}, body: "", setHeader(name, value) { this.headers[name] = value; }, end(body = "") { this.body = body; } });
  const heartbeat = (capabilities) => ({ nodeId: fixture.enrolled.nodeId, agentVersion: "0.2.0", protocolVersion: "1.0", timestamp: new Date().toISOString(), platform: "linux", capabilities, health: { status: "healthy", uptimeSeconds: 10 }, databaseSnapshot: { collectedAt: new Date().toISOString(), collectionStatus: "complete", warnings: [], instances: [instance] } });
  const context = (body) => ({ request: { method: "POST" }, response: response(), requestId: crypto.randomUUID(), url: new URL("https://controller.test/api/agent/heartbeat"), body, agentIdentity: { nodeId: fixture.enrolled.nodeId, credentialId: fixture.enrolled.credentialId, protocolVersion: "1.0" }, services: { nodes: fixture.nodes, mesh: { reconcileNode() {} }, databaseInventory: { ingestSnapshot(nodeId, snapshot) { ingested.push({ nodeId, snapshot }); } } } });
  await routeAgentRequest(context(heartbeat(["databases.inventory.read"]))); assert.equal(ingested.length, 1); assert.equal(ingested[0].snapshot.instances[0].managed, false);
  await routeAgentRequest(context(heartbeat(["system.summary.read"]))); assert.equal(ingested.length, 1);
});

test("node capability authorization accepts only declared Controller-supported capabilities", async () => {
  const fixture = await enrolledFixture();
  await fixture.nodes.heartbeat(fixture.enrolled.nodeId, { nodeId: fixture.enrolled.nodeId, agentVersion: "0.1.0", protocolVersion: AGENT_PROTOCOL_VERSION, timestamp: new Date().toISOString(), platform: "linux", capabilities: ["system.summary.read", "sites.certificates.renew", "network.mesh.read", "network.mesh.configure", "network.cache.read", "network.transfer"], health: { status: "healthy", uptimeSeconds: 10 } }, crypto.randomUUID());
  const updated = await fixture.nodes.updateCapabilities(fixture.enrolled.nodeId, ["sites.certificates.renew"], "admin", crypto.randomUUID());
  assert.deepEqual(updated.allowedCapabilities, ["sites.certificates.renew"]);
  const mesh = await fixture.nodes.updateCapabilities(fixture.enrolled.nodeId, ["network.mesh.read", "network.mesh.configure", "network.cache.read", "network.transfer"], "admin", crypto.randomUUID());
  assert.deepEqual(mesh.allowedCapabilities, ["network.mesh.read", "network.mesh.configure", "network.cache.read", "network.transfer"]);
  await assert.rejects(() => fixture.nodes.updateCapabilities(fixture.enrolled.nodeId, ["service.status.read"], "admin", crypto.randomUUID()), /已声明/);
});

test("terminal command requires explicit dual capability authorization and never retries", async () => {
  const fixture = await enrolledFixture();
  await fixture.nodes.heartbeat(fixture.enrolled.nodeId, { nodeId: fixture.enrolled.nodeId, agentVersion: "0.2.0", protocolVersion: AGENT_PROTOCOL_VERSION, timestamp: new Date().toISOString(), platform: "linux", capabilities: ["system.summary.read", "terminal.command.execute"], health: { status: "healthy", uptimeSeconds: 10 } }, crypto.randomUUID());
  const input = { type: "terminal.command.execute", parameters: { command: "uptime" }, expiresInSeconds: 30, idempotencyKey: "terminal-uptime-once" };
  await assert.rejects(() => fixture.tasks.create(fixture.enrolled.nodeId, input, "admin", crypto.randomUUID()), (error) => error.status === 403);
  await fixture.nodes.updateCapabilities(fixture.enrolled.nodeId, ["system.summary.read", "terminal.command.execute"], "admin", crypto.randomUUID());
  const created = await fixture.tasks.create(fixture.enrolled.nodeId, input, "admin", crypto.randomUUID());
  assert.equal(created.maxAttempts, 1); assert.equal(created.retryable, false); assert.equal(created.requiredCapability, "terminal.command.execute");
  await fixture.tasks.poll(fixture.enrolled.nodeId, crypto.randomUUID());
  const failed = await fixture.tasks.update(fixture.enrolled.nodeId, { taskId: created.taskId, attempt: 1, status: "failed", timestamp: new Date().toISOString(), errorCode: "COMMAND_FAILED", result: { message: "failed", truncated: false } }, crypto.randomUUID());
  assert.equal(failed.status, "failed"); assert.equal(failed.nextAttemptAt, null); assert.equal((await fixture.tasks.poll(fixture.enrolled.nodeId, crypto.randomUUID())).length, 0);
  const state = await fixture.repository.read(); assert.equal(state.audits.findLast((event) => event.taskId === created.taskId)?.resultSummary, "Terminal command result recorded");
});

test("mesh status tasks require a declared and authorized mesh capability", async () => {
  const fixture = await enrolledFixture();
  const input = { type: "network.mesh.status.read", parameters: {}, expiresInSeconds: 30, idempotencyKey: "mesh-status-once" };
  await assert.rejects(() => fixture.tasks.create(fixture.enrolled.nodeId, input, "admin", crypto.randomUUID()), (error) => error.status === 403);
  await fixture.nodes.heartbeat(fixture.enrolled.nodeId, { nodeId: fixture.enrolled.nodeId, agentVersion: "0.3.0", protocolVersion: AGENT_PROTOCOL_VERSION, timestamp: new Date().toISOString(), platform: "linux", capabilities: ["system.summary.read", "network.mesh.read"], health: { status: "healthy", uptimeSeconds: 10 } }, crypto.randomUUID());
  await fixture.nodes.updateCapabilities(fixture.enrolled.nodeId, ["network.mesh.read"], "admin", crypto.randomUUID());
  const created = await fixture.tasks.create(fixture.enrolled.nodeId, input, "admin", crypto.randomUUID());
  assert.equal(created.requiredCapability, "network.mesh.read");
  assert.equal(created.retryable, true);
  assert.equal(created.maxAttempts, 3);
});

test("task state machine enforces capability, idempotency, expiry, cancellation and queue limit", async () => {
  const fixture = await enrolledFixture(); await fixture.nodes.heartbeat(fixture.enrolled.nodeId, { nodeId: fixture.enrolled.nodeId, agentVersion: "0.1.0", protocolVersion: AGENT_PROTOCOL_VERSION, timestamp: new Date().toISOString(), platform: "linux", capabilities: ["system.summary.read", "service.status.read"], health: { status: "healthy", uptimeSeconds: 10 } }, crypto.randomUUID());
  const input = { type: "system.summary.read", parameters: { includeLoad: false }, expiresInSeconds: 60, idempotencyKey: "idempotent-summary-a" };
  let authorizationCount = 0;
  const authorize = () => { authorizationCount += 1; };
  const first = await fixture.tasks.create(fixture.enrolled.nodeId, input, "admin", crypto.randomUUID(), authorize); const duplicate = await fixture.tasks.create(fixture.enrolled.nodeId, input, "admin", crypto.randomUUID(), authorize); assert.equal(duplicate.taskId, first.taskId); assert.equal(authorizationCount, 2);
  await assert.rejects(() => fixture.tasks.create(fixture.enrolled.nodeId, { ...input, parameters: { includeLoad: true } }, "admin", crypto.randomUUID(), authorize), (error) => error.status === 409);
  await assert.rejects(() => fixture.tasks.create(fixture.enrolled.nodeId, { ...input, expiresInSeconds: 120 }, "admin", crypto.randomUUID(), authorize), (error) => error.status === 409);
  await assert.rejects(() => fixture.tasks.create(fixture.enrolled.nodeId, { type: "service.status.read", parameters: { serviceName: "nginx" }, expiresInSeconds: 60, idempotencyKey: input.idempotencyKey }, "admin", crypto.randomUUID(), authorize), (error) => error.status === 409);
  await assert.rejects(() => fixture.tasks.create(fixture.enrolled.nodeId, input, "other-user", crypto.randomUUID(), authorize), (error) => error.status === 409);
  const dispatched = await fixture.tasks.poll(fixture.enrolled.nodeId, crypto.randomUUID()); assert.equal(dispatched.length, 1);
  await fixture.tasks.update(fixture.enrolled.nodeId, { taskId: first.taskId, attempt: 1, status: "running", timestamp: new Date().toISOString() }, crypto.randomUUID());
  assert.equal((await fixture.tasks.update(fixture.enrolled.nodeId, { taskId: first.taskId, attempt: 1, status: "running", timestamp: new Date().toISOString() }, crypto.randomUUID())).status, "running");
  await fixture.tasks.update(fixture.enrolled.nodeId, { taskId: first.taskId, attempt: 1, status: "succeeded", timestamp: new Date().toISOString(), result: { message: "ok", truncated: false } }, crypto.randomUUID());
  assert.equal((await fixture.tasks.list())[0].status, "succeeded");
  const second = await fixture.tasks.create(fixture.enrolled.nodeId, { ...input, idempotencyKey: "idempotent-summary-b" }, "admin", crypto.randomUUID()); await fixture.tasks.cancel(second.taskId, "admin", "test", crypto.randomUUID()); assert.equal((await fixture.tasks.list()).find((item) => item.taskId === second.taskId).status, "cancelled");
  const fake = structuredClone(first); fake.status = "succeeded"; assert.throws(() => transitionTask(fake, "running"));
});

test("credential rotation revokes the old credential", async () => {
  const fixture = await enrolledFixture(); const replacement = keys(); const rotationId = crypto.randomUUID(); const rotated = await fixture.nodes.rotate(fixture.enrolled.nodeId, fixture.enrolled.credentialId, rotationId, replacement.publicKey, crypto.randomUUID());
  const repeated = await fixture.nodes.rotate(fixture.enrolled.nodeId, fixture.enrolled.credentialId, rotationId, replacement.publicKey, crypto.randomUUID()); assert.deepEqual(repeated, rotated);
  const state = await fixture.repository.read(); assert.ok(state.credentials.find((item) => item.credentialId === fixture.enrolled.credentialId).revokedAt); assert.equal(state.credentials.find((item) => item.credentialId === rotated.credentialId).publicKey, replacement.publicKey);
});

test("retry uses bounded attempts and rejects stale result delivery", async () => {
  const fixture = await enrolledFixture(); await fixture.nodes.heartbeat(fixture.enrolled.nodeId, { nodeId: fixture.enrolled.nodeId, agentVersion: "0.1.0", protocolVersion: AGENT_PROTOCOL_VERSION, timestamp: new Date().toISOString(), platform: "linux", capabilities: ["system.summary.read"], health: { status: "healthy", uptimeSeconds: 10 } }, crypto.randomUUID());
  const created = await fixture.tasks.create(fixture.enrolled.nodeId, { type: "system.summary.read", parameters: { includeLoad: false }, expiresInSeconds: 60, idempotencyKey: "retry-summary-once" }, "admin", crypto.randomUUID());
  await fixture.tasks.poll(fixture.enrolled.nodeId, crypto.randomUUID());
  await fixture.tasks.update(fixture.enrolled.nodeId, { taskId: created.taskId, attempt: 1, status: "running", timestamp: new Date().toISOString() }, crypto.randomUUID());
  const retry = await fixture.tasks.update(fixture.enrolled.nodeId, { taskId: created.taskId, attempt: 1, status: "failed", timestamp: new Date().toISOString(), errorCode: "TRANSIENT" }, crypto.randomUUID());
  assert.equal(retry.status, "queued"); assert.equal(retry.attempt, 1); assert.ok(retry.nextAttemptAt);
  await assert.rejects(() => fixture.tasks.update(fixture.enrolled.nodeId, { taskId: created.taskId, attempt: 2, status: "succeeded", timestamp: new Date().toISOString(), result: { message: "stale", truncated: false } }, crypto.randomUUID()), /attempt/);
});

test("task results reject sensitive fields and oversized output", async () => {
  const fixture = await enrolledFixture(); await fixture.nodes.heartbeat(fixture.enrolled.nodeId, { nodeId: fixture.enrolled.nodeId, agentVersion: "0.1.0", protocolVersion: AGENT_PROTOCOL_VERSION, timestamp: new Date().toISOString(), platform: "linux", capabilities: ["system.summary.read"], health: { status: "healthy", uptimeSeconds: 1 } }, crypto.randomUUID());
  const created = await fixture.tasks.create(fixture.enrolled.nodeId, { type: "system.summary.read", parameters: { includeLoad: false }, expiresInSeconds: 60, idempotencyKey: "result-boundaries-1" }, "admin", crypto.randomUUID()); await fixture.tasks.poll(fixture.enrolled.nodeId, crypto.randomUUID());
  await fixture.tasks.update(fixture.enrolled.nodeId, { taskId: created.taskId, attempt: 1, status: "running", timestamp: new Date().toISOString() }, crypto.randomUUID());
  await assert.rejects(() => fixture.tasks.update(fixture.enrolled.nodeId, { taskId: created.taskId, attempt: 1, status: "succeeded", timestamp: new Date().toISOString(), result: { message: "bad", truncated: false, data: { environment: "secret" } } }, crypto.randomUUID()), /禁止字段/);
  await assert.rejects(() => fixture.tasks.update(fixture.enrolled.nodeId, { taskId: created.taskId, attempt: 1, status: "succeeded", timestamp: new Date().toISOString(), result: { message: "x".repeat(17_000), truncated: false } }, crypto.randomUUID()), /大小限制/);
});

test("Controller policy and Agent declaration are both required for a task", async () => {
  const fixture = await enrolledFixture();
  await fixture.nodes.heartbeat(fixture.enrolled.nodeId, { nodeId: fixture.enrolled.nodeId, agentVersion: "0.1.0", protocolVersion: AGENT_PROTOCOL_VERSION, timestamp: new Date().toISOString(), platform: "linux", capabilities: ["system.summary.read"], health: { status: "healthy", uptimeSeconds: 1 } }, crypto.randomUUID());
  let authorizationCount = 0;
  await assert.rejects(() => fixture.tasks.create(fixture.enrolled.nodeId, { type: "service.status.read", parameters: { serviceName: "sshd" }, expiresInSeconds: 60, idempotencyKey: "missing-agent-capability" }, "admin", crypto.randomUUID(), () => { authorizationCount += 1; }), (error) => error.status === 403);
  await fixture.repository.update((state) => { state.nodes[0].allowedCapabilities = []; });
  await assert.rejects(() => fixture.tasks.create(fixture.enrolled.nodeId, { type: "system.summary.read", parameters: { includeLoad: false }, expiresInSeconds: 60, idempotencyKey: "missing-controller-policy" }, "admin", crypto.randomUUID(), () => { authorizationCount += 1; }), (error) => error.status === 403);
  assert.equal(authorizationCount, 0);
});

test("site prepare derives runtime installation authorization from current node policy", async () => {
  const fixture = await enrolledFixture();
  await fixture.nodes.heartbeat(fixture.enrolled.nodeId, { nodeId: fixture.enrolled.nodeId, agentVersion: "0.1.0", protocolVersion: AGENT_PROTOCOL_VERSION, timestamp: new Date().toISOString(), platform: "linux", capabilities: ["sites.deploy", "runtime.install"], health: { status: "healthy", uptimeSeconds: 1 } }, crypto.randomUUID());
  await fixture.nodes.updateCapabilities(fixture.enrolled.nodeId, ["sites.deploy"], "admin", crypto.randomUUID());
  const parameters = { operationId: crypto.randomUUID(), planId: crypto.randomUUID(), domains: ["app.example.com"], repositoryUrl: "https://github.com/example/site.git", repositoryRef: "main", certificateContact: "ops@example.com", certificateEnvironment: "staging", environmentVariables: [], expectedPlanDigest: "a".repeat(64), runtimeInstallAuthorized: true };
  const created = await fixture.tasks.create(fixture.enrolled.nodeId, { type: "sites.plan.prepare", parameters, expiresInSeconds: 1_800, idempotencyKey: "runtime-policy-prepare" }, "controller:site-management", crypto.randomUUID());
  assert.equal(created.parameters.runtimeInstallAuthorized, false);
  await fixture.nodes.updateCapabilities(fixture.enrolled.nodeId, ["sites.deploy", "runtime.install"], "admin", crypto.randomUUID());
  assert.equal((await fixture.tasks.create(fixture.enrolled.nodeId, { type: "sites.plan.prepare", parameters, expiresInSeconds: 1_800, idempotencyKey: "runtime-policy-prepare" }, "controller:site-management", crypto.randomUUID())).taskId, created.taskId);
  assert.equal((await fixture.tasks.poll(fixture.enrolled.nodeId, crypto.randomUUID()))[0].parameters.runtimeInstallAuthorized, true);
});

test("task expiry, queue limits and audit redaction are persisted", async () => {
  const fixture = await enrolledFixture(); await fixture.nodes.heartbeat(fixture.enrolled.nodeId, { nodeId: fixture.enrolled.nodeId, agentVersion: "0.1.0", protocolVersion: AGENT_PROTOCOL_VERSION, timestamp: new Date().toISOString(), platform: "linux", capabilities: ["system.summary.read"], health: { status: "healthy", uptimeSeconds: 1 } }, crypto.randomUUID());
  const first = await fixture.tasks.create(fixture.enrolled.nodeId, { type: "system.summary.read", parameters: { includeLoad: false }, expiresInSeconds: 60, idempotencyKey: "expire-task-one" }, "admin", crypto.randomUUID());
  await fixture.repository.update((state) => { state.tasks.find((item) => item.taskId === first.taskId).expiresAt = new Date(Date.now() - 1).toISOString(); state.audits.push({ eventId: crypto.randomUUID(), timestamp: new Date().toISOString(), requester: "test", nodeId: fixture.enrolled.nodeId, taskId: first.taskId, event: "redaction.test", taskType: "system.summary.read", parameters: { nested: { authorization: "Bearer secret", safe: "visible" } }, fromStatus: null, toStatus: null, resultSummary: "ok", traceId: crypto.randomUUID() }); });
  assert.equal((await fixture.tasks.list()).find((item) => item.taskId === first.taskId).status, "expired");
  const queued = await fixture.tasks.create(fixture.enrolled.nodeId, { type: "system.summary.read", parameters: { includeLoad: false }, expiresInSeconds: 60, idempotencyKey: "queue-task-one" }, "admin", crypto.randomUUID());
  await fixture.tasks.create(fixture.enrolled.nodeId, { type: "system.summary.read", parameters: { includeLoad: false }, expiresInSeconds: 60, idempotencyKey: "queue-task-two" }, "admin", crypto.randomUUID());
  assert.equal((await fixture.tasks.create(fixture.enrolled.nodeId, { type: "system.summary.read", parameters: { includeLoad: false }, expiresInSeconds: 60, idempotencyKey: "queue-task-one" }, "admin", crypto.randomUUID())).taskId, queued.taskId);
  await assert.rejects(() => fixture.tasks.create(fixture.enrolled.nodeId, { type: "system.summary.read", parameters: { includeLoad: false }, expiresInSeconds: 60, idempotencyKey: "queue-task-three" }, "admin", crypto.randomUUID()), /队列已满/);
  const state = await fixture.repository.read(); assert.ok(state.audits.some((event) => event.event === "task.expired" && event.taskId === first.taskId));
  const redacted = state.audits.find((event) => event.event === "redaction.test"); assert.equal(redacted.parameters.nested.authorization, "[REDACTED]"); assert.equal(redacted.parameters.nested.safe, "visible");
});

test("read-only task history derives expiry without updating stored state or audit", async () => {
  const fixture = await enrolledFixture();
  const created = await fixture.tasks.create(fixture.enrolled.nodeId, { type: "system.summary.read", parameters: { includeLoad: false }, expiresInSeconds: 60, idempotencyKey: "read-only-expired-task" }, "admin", crypto.randomUUID());
  await fixture.repository.update((state) => { state.tasks.find((item) => item.taskId === created.taskId).expiresAt = new Date(Date.now() - 1).toISOString(); });
  const originalUpdate = fixture.repository.update.bind(fixture.repository); let updateCalls = 0;
  fixture.repository.update = (...args) => { updateCalls += 1; return originalUpdate(...args); };

  const displayed = (await fixture.tasks.listReadOnly()).find((item) => item.taskId === created.taskId);
  assert.equal(displayed.status, "expired"); assert.equal(displayed.errorCode, "TASK_EXPIRED"); assert.equal(updateCalls, 0);
  const storedBeforeReconciliation = await fixture.repository.read();
  assert.equal(storedBeforeReconciliation.tasks.find((item) => item.taskId === created.taskId).status, "queued");
  assert.equal(storedBeforeReconciliation.audits.some((event) => event.event === "task.expired" && event.taskId === created.taskId), false);

  assert.equal((await fixture.tasks.list()).find((item) => item.taskId === created.taskId).status, "expired"); assert.equal(updateCalls, 1);
  const storedAfterReconciliation = await fixture.repository.read();
  assert.equal(storedAfterReconciliation.audits.some((event) => event.event === "task.expired" && event.taskId === created.taskId), true);
});

test("GET remote task history uses the read-only service path", async () => {
  const fixture = await enrolledFixture();
  const created = await fixture.tasks.create(fixture.enrolled.nodeId, { type: "system.summary.read", parameters: { includeLoad: false }, expiresInSeconds: 60, idempotencyKey: "http-read-only-expired-task" }, "admin", crypto.randomUUID());
  await fixture.repository.update((state) => { state.tasks.find((item) => item.taskId === created.taskId).expiresAt = new Date(Date.now() - 1).toISOString(); });
  const originalUpdate = fixture.repository.update.bind(fixture.repository); let updateCalls = 0;
  fixture.repository.update = (...args) => { updateCalls += 1; return originalUpdate(...args); };
  const response = { statusCode: 0, headers: {}, body: "", setHeader(name, value) { this.headers[name] = value; }, end(body = "") { this.body = body; } };

  await routeControlPlaneRequest({ request: { method: "GET", headers: {} }, response, parts: ["api", "remote-tasks"], services: { remoteTasks: fixture.tasks }, identity: null, principal: { nodeScope: "all" } });

  assert.equal(response.statusCode, 200); assert.equal(updateCalls, 0);
  const payload = JSON.parse(response.body); assert.equal(payload.tasks[0].status, "expired"); assert.equal(payload.tasks[0].errorCode, "TASK_EXPIRED");
  const stored = await fixture.repository.read(); assert.equal(stored.tasks[0].status, "queued"); assert.equal(stored.audits.some((event) => event.event === "task.expired"), false);
});
