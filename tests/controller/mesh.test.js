import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { AGENT_PROTOCOL_VERSION, NetworkMeshPlanResponseSchema } from "@stackpilot/contracts";
import { routeControlPlaneRequest } from "../../apps/controller/dist/http/controlPlaneRouter.js";
import { routeRequest } from "../../apps/controller/dist/http/router.js";
import { MeshService } from "../../apps/controller/dist/modules/network/meshService.js";
import { NodeService } from "../../apps/controller/dist/modules/nodes/nodeService.js";
import { RemoteTaskService } from "../../apps/controller/dist/modules/remote-tasks/remoteTaskService.js";
import { MemoryAgentControlRepository } from "../../apps/controller/dist/repositories/agentControlRepository.js";

const publicKey = () => randomBytes(32).toString("base64");
const overlay = /^100\.(?:6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\./;

async function fixture() {
  const repository = new MemoryAgentControlRepository();
  const remoteTasks = new RemoteTaskService(repository);
  return { repository, remoteTasks, mesh: new MeshService(repository, remoteTasks) };
}

async function addNode(repository, { name, capabilities = ["network.mesh.configure"], publicKey: nodeKey = publicKey(), configuredRevision = 0, primaryIp = "203.0.113.7", status = "online" }) {
  const nodeId = randomUUID(); const timestamp = new Date().toISOString();
  await repository.update((state) => {
    state.nodes.push({
      nodeId, nodeName: name, status, agentVersion: "0.1.0", protocolVersion: AGENT_PROTOCOL_VERSION, platform: "linux",
      declaredCapabilities: [...capabilities], allowedCapabilities: [...capabilities], enrolledAt: timestamp, lastSeenAt: timestamp, revokedAt: null,
      ...(nodeKey ? { meshIdentity: { interfaceName: "wg0", publicKey: nodeKey, configuredRevision } } : {}),
      ...(primaryIp ? { telemetry: { collectedAt: timestamp, hostname: name, primaryIp, cpu: null, memory: null, loadAverage: null, disks: [], uptimeSeconds: 60 } } : {}),
    });
  });
  return nodeId;
}

test("the plan previews stable overlay addresses and never mutates state", async () => {
  const { repository, mesh } = await fixture();
  const alpha = await addNode(repository, { name: "alpha", primaryIp: "203.0.113.7" });
  const beta = await addNode(repository, { name: "beta", primaryIp: "198.51.100.9" });
  const gamma = await addNode(repository, { name: "gamma", capabilities: ["system.summary.read"] });
  const plan = await mesh.plan();
  assert.equal(NetworkMeshPlanResponseSchema.safeParse(plan).success, true);
  assert.equal(plan.revision, 0);
  assert.deepEqual(plan.nodes.map((node) => node.status), ["pending", "pending", "disabled"]);
  const addresses = plan.nodes.slice(0, 2).map((node) => node.overlayAddress);
  assert.ok(addresses.every((address) => overlay.test(address)));
  assert.notEqual(addresses[0], addresses[1]);
  assert.equal(plan.nodes[2].overlayAddress, null);
  assert.equal((await mesh.plan()).nodes[0].overlayAddress, addresses[0]);
  assert.deepEqual((await repository.read()).nodes.map((node) => node.meshAssignment ?? null), [null, null, null]);
  assert.notEqual(alpha, beta);
  assert.ok(gamma);
});

test("apply dispatches one single-attempt task per member with a peer list that excludes the sender", async () => {
  const { repository, remoteTasks, mesh } = await fixture();
  const alpha = await addNode(repository, { name: "alpha", primaryIp: "203.0.113.7" });
  const beta = await addNode(repository, { name: "beta", primaryIp: "198.51.100.9" });
  const plan = await mesh.apply("user:admin", randomUUID());
  assert.equal(plan.revision, 1);
  assert.deepEqual(plan.nodes.map((node) => node.status), ["stale", "stale"]);
  const tasks = await remoteTasks.list();
  assert.equal(tasks.length, 2);
  for (const task of tasks) {
    assert.equal(task.type, "network.mesh.configure");
    assert.equal(task.requiredCapability, "network.mesh.configure");
    assert.equal(task.maxAttempts, 1);
    assert.equal(task.retryable, false);
    const { revision, configuration } = task.parameters;
    assert.equal(revision, 1);
    assert.equal(configuration.sourceRevision, 1);
    assert.equal(configuration.listenPort, 51820);
    assert.equal(configuration.mtu, 1420);
    const self = plan.nodes.find((node) => node.nodeId === task.targetNodeId);
    const other = plan.nodes.find((node) => node.nodeId !== task.targetNodeId);
    assert.equal(configuration.address, self.overlayAddress);
    assert.deepEqual(configuration.peers, [{ publicKey: other.publicKey, overlayAddress: other.overlayAddress, endpoint: `${task.targetNodeId === alpha ? "198.51.100.9" : "203.0.113.7"}:51820` }]);
  }
  const state = await repository.read();
  assert.deepEqual(state.nodes.find((node) => node.nodeId === alpha).meshAssignment.revision, 1);
  assert.ok(state.audits.some((event) => event.event === "network.mesh.revision-created" && event.parameters.revision === 1));
  assert.notEqual(alpha, beta);
});

test("assigned addresses survive new members and the reported revision drives readiness", async () => {
  const { repository, mesh } = await fixture();
  const alpha = await addNode(repository, { name: "alpha", primaryIp: "203.0.113.7" });
  const beta = await addNode(repository, { name: "beta", primaryIp: "198.51.100.9" });
  const first = await mesh.apply("user:admin", randomUUID());
  await repository.update((state) => {
    for (const node of state.nodes) node.meshIdentity.configuredRevision = 1;
  });
  const ready = await mesh.plan();
  assert.deepEqual(ready.nodes.map((node) => node.status), ["ready", "ready"]);
  const gamma = await addNode(repository, { name: "gamma", primaryIp: "192.0.2.20" });
  const grown = await mesh.plan();
  for (const node of first.nodes) {
    assert.equal(grown.nodes.find((item) => item.nodeId === node.nodeId).overlayAddress, node.overlayAddress);
  }
  assert.ok(grown.nodes.find((node) => node.nodeId === gamma).overlayAddress);
  const second = await mesh.apply("user:admin", randomUUID());
  assert.equal(second.revision, 2);
  assert.deepEqual(second.nodes.map((node) => node.status), ["stale", "stale", "stale"]);
  assert.equal(second.nodes[0].overlayAddress, first.nodes[0].overlayAddress);
  assert.equal(second.nodes[1].overlayAddress, first.nodes[1].overlayAddress);
  assert.notEqual(alpha, beta);
});

test("nodes without a reported identity are held back instead of receiving a configuration", async () => {
  const { repository, mesh } = await fixture();
  await addNode(repository, { name: "alpha", publicKey: null });
  const plan = await mesh.plan();
  assert.equal(plan.nodes[0].status, "pending");
  assert.equal(plan.nodes[0].publicKey, null);
  assert.ok(plan.warnings.some((warning) => /尚未上报组网公钥/.test(warning)));
  await assert.rejects(() => mesh.apply("user:admin", randomUUID()), (error) => error.status === 409 && /组网公钥/.test(error.message));
});

test("a host address inside the shared range is excluded and reported", async () => {
  const { repository, mesh } = await fixture();
  await addNode(repository, { name: "conflicting", primaryIp: "100.64.0.9" });
  await addNode(repository, { name: "clean", primaryIp: "203.0.113.7" });
  const plan = await mesh.plan();
  assert.ok(plan.warnings.some((warning) => /需要人工确认是否冲突/.test(warning)));
  assert.notEqual(plan.nodes[0].overlayAddress, "100.64.0.9");
  assert.notEqual(plan.nodes[1].overlayAddress, "100.64.0.9");
});

test("unauthorized nodes never receive a configuration task", async () => {
  const { repository, mesh } = await fixture();
  await addNode(repository, { name: "alpha", capabilities: ["system.summary.read"] });
  await assert.rejects(() => mesh.apply("user:admin", randomUUID()), (error) => error.status === 409 && /授权/.test(error.message));
});

test("a heartbeat publishes the mesh identity that the plan then relies on", async () => {
  const { repository, mesh } = await fixture();
  const nodeId = await addNode(repository, { name: "alpha", publicKey: null });
  const nodes = new NodeService(repository, 10);
  const identity = { interfaceName: "wg0", publicKey: publicKey(), configuredRevision: 0 };
  const link = { collectedAt: new Date().toISOString(), peerCount: 1, activePeerCount: 1, latestHandshakeAt: new Date(Date.now() - 30_000).toISOString(), firewallEnforced: true, dataPlanePort: 18_080 };
  await nodes.heartbeat(nodeId, { nodeId, agentVersion: "0.2.0", protocolVersion: AGENT_PROTOCOL_VERSION, timestamp: new Date().toISOString(), platform: "linux", capabilities: ["network.mesh.configure"], health: { status: "healthy", uptimeSeconds: 5 }, mesh: { ...identity, link } }, randomUUID());
  const plan = await mesh.plan();
  assert.deepEqual(plan.nodes[0].publicKey, identity.publicKey);
  assert.ok(plan.warnings.some((warning) => /尚未收到配置 revision/.test(warning)));
  const applied = await mesh.apply("user:admin", randomUUID());
  assert.equal(applied.revision, 1);
  assert.equal(applied.nodes[0].status, "stale");
  assert.deepEqual(applied.nodes[0].handshake, { collectedAt: link.collectedAt, ageSeconds: 30, peerCount: 1, activePeerCount: 1 });
  assert.equal(applied.nodes[0].firewallEnforced, true);
  assert.equal(applied.nodes[0].dataPlanePort, 18_080);
  assert.deepEqual(applied.warnings, []);
});

test("a node without the overlay whitelist is flagged instead of assumed secure", async () => {
  const { repository, mesh } = await fixture();
  await addNode(repository, { name: "alpha" });
  await repository.update((state) => {
    state.nodes[0].meshAssignment = { overlayAddress: "100.64.1.4", revision: 1 };
    state.nodes[0].meshIdentity.configuredRevision = 1;
    state.nodes[0].meshLink = { collectedAt: new Date().toISOString(), peerCount: 1, activePeerCount: 1, latestHandshakeAt: new Date().toISOString(), firewallEnforced: false, dataPlanePort: 18_080 };
  });
  const unenforced = await mesh.plan();
  assert.equal(unenforced.nodes[0].status, "ready");
  assert.equal(unenforced.nodes[0].firewallEnforced, false);
  assert.equal(unenforced.nodes[0].dataPlanePort, 18_080);
  assert.ok(unenforced.warnings.some((warning) => /白名单未生效/.test(warning)));
  await repository.update((state) => { state.nodes[0].meshLink.firewallEnforced = true; });
  const enforced = await mesh.plan();
  assert.equal(enforced.nodes[0].firewallEnforced, true);
  assert.deepEqual(enforced.warnings, []);
  assert.equal(NetworkMeshPlanResponseSchema.safeParse(enforced).success, true);
});

test("revoking a member withdraws its peer routes from every remaining node", async () => {
  const { repository, remoteTasks, mesh } = await fixture();
  const alpha = await addNode(repository, { name: "alpha", primaryIp: "203.0.113.7" });
  const beta = await addNode(repository, { name: "beta", primaryIp: "198.51.100.9" });
  await mesh.apply("user:admin", randomUUID());
  assert.equal((await remoteTasks.list()).length, 2);
  const nodes = new NodeService(repository, 10);
  const traceId = randomUUID();
  await nodes.revoke(beta, "user:admin", traceId);
  await mesh.revokeMember(beta, "user:admin", traceId);
  const plan = await mesh.plan();
  assert.equal(plan.revision, 2);
  assert.equal(plan.nodes.find((node) => node.nodeId === beta).status, "disabled");
  const after = (await remoteTasks.list()).filter((task) => task.type === "network.mesh.configure" && task.parameters.revision === 2);
  assert.equal(after.length, 1);
  assert.equal(after[0].targetNodeId, alpha);
  assert.deepEqual(after[0].parameters.configuration.peers, []);
  const state = await repository.read();
  const withdrawal = state.audits.find((event) => event.event === "network.mesh.peer-withdrawn");
  assert.equal(withdrawal.parameters.revokedNodeId, beta);
  assert.equal(withdrawal.parameters.revision, 2);
  assert.deepEqual(withdrawal.parameters.members, [alpha]);
  assert.notEqual(state.nodes.find((node) => node.nodeId === beta).meshAssignment.overlayAddress, null);
});

test("a silent link is reported with its age instead of being hidden as healthy", async () => {
  const { repository, mesh } = await fixture();
  const nodeId = await addNode(repository, { name: "alpha" });
  await repository.update((state) => {
    state.nodes[0].meshAssignment = { overlayAddress: "100.64.1.4", revision: 1 };
    state.nodes[0].meshIdentity.configuredRevision = 1;
    state.nodes[0].meshLink = { collectedAt: new Date().toISOString(), peerCount: 2, activePeerCount: 0, latestHandshakeAt: new Date(Date.now() - 420_000).toISOString() };
  });
  const plan = await mesh.plan();
  assert.equal(plan.nodes[0].status, "ready");
  assert.equal(plan.nodes[0].handshake.ageSeconds, 420);
  assert.ok(plan.warnings.some((warning) => /最近一次握手在 7 分钟前/.test(warning)));
  await repository.update((state) => {
    state.nodes[0].meshLink = { collectedAt: new Date().toISOString(), peerCount: 2, activePeerCount: 0, latestHandshakeAt: null };
  });
  const never = await mesh.plan();
  assert.equal(never.nodes[0].handshake.ageSeconds, null);
  assert.ok(never.warnings.some((warning) => /从未完成握手/.test(warning)));
  assert.notEqual(nodeId, null);
});

test("the mesh routes read with GET and dispatch only through the apply endpoint", async () => {
  const { repository, mesh } = await fixture();
  await addNode(repository, { name: "alpha" });
  const request = (method, parts) => ({
    request: { method }, parts, requestId: randomUUID(), body: undefined,
    response: { statusCode: 0, headers: {}, body: "", setHeader(name, value) { this.headers[name] = value; }, end(body = "") { this.body = body; } },
    services: { mesh },
  });
  const read = request("GET", ["api", "network", "mesh"]);
  await routeControlPlaneRequest(read);
  assert.equal(read.response.statusCode, 200);
  assert.equal(NetworkMeshPlanResponseSchema.safeParse(JSON.parse(read.response.body)).success, true);
  const routed = request("GET", ["api", "network", "mesh"]);
  await routeRequest({
    ...routed,
    request: { method: "GET", headers: {} },
    url: new URL("http://127.0.0.1/api/network/mesh"), rawBody: Buffer.alloc(0),
    config: {}, platform: {}, logger: { log() {} },
    identity: { require() {} }, principal: { userId: "test", permissions: new Set(["nodes:read"]), nodeScope: "all" },
  });
  assert.equal(routed.response.statusCode, 200, "the API router must dispatch /api/network/mesh to the control plane");
  const apply = request("POST", ["api", "network", "mesh", "apply"]);
  await routeControlPlaneRequest(apply);
  assert.equal(apply.response.statusCode, 200);
  assert.equal(JSON.parse(apply.response.body).revision, 1);
});

test("a member that missed a broadcast is caught up on its next heartbeat", async () => {
  const { repository, remoteTasks, mesh } = await fixture();
  const alpha = await addNode(repository, { name: "alpha", primaryIp: "203.0.113.7" });
  const gamma = await addNode(repository, { name: "gamma", primaryIp: "198.51.100.9" });
  await mesh.apply("user:admin", randomUUID());
  // gamma was offline: its task ended without ever being delivered, and only alpha applied.
  await repository.update((state) => {
    for (const task of state.tasks) if (task.targetNodeId === gamma) task.status = "failed";
    state.nodes.find((node) => node.nodeId === alpha).meshIdentity.configuredRevision = 1;
  });
  await mesh.reconcileNode(gamma, randomUUID());
  const tasks = (await remoteTasks.list(gamma)).filter((task) => task.type === "network.mesh.configure");
  assert.equal(tasks.length, 2);
  assert.equal(tasks[1].idempotencyKey, `mesh-1-${gamma}-1`);
  const alphaAddress = (await repository.read()).nodes.find((node) => node.nodeId === alpha).meshAssignment.overlayAddress;
  assert.deepEqual(tasks[1].parameters.configuration.peers.map((peer) => peer.overlayAddress), [alphaAddress]);
  await repository.update((state) => { state.nodes.find((node) => node.nodeId === gamma).meshIdentity.configuredRevision = 1; });
  await mesh.reconcileNode(gamma, randomUUID());
  assert.equal((await remoteTasks.list(gamma)).filter((task) => task.type === "network.mesh.configure").length, 2, "a member that caught up is not dispatched again");
  assert.equal((await mesh.plan()).revision, 1, "catching up never bumps the revision");
});

test("one node that cannot take the task does not fail the whole broadcast", async () => {
  const repository = new MemoryAgentControlRepository();
  const remoteTasks = new RemoteTaskService(repository);
  const alpha = await addNode(repository, { name: "alpha", primaryIp: "203.0.113.7" });
  const beta = await addNode(repository, { name: "beta", primaryIp: "198.51.100.9" });
  const rejecting = { list: (...args) => remoteTasks.list(...args), create: (nodeId, input, requester, traceId) => nodeId === beta ? Promise.reject(new Error("queue is full")) : remoteTasks.create(nodeId, input, requester, traceId) };
  const mesh = new MeshService(repository, rejecting);
  const plan = await mesh.apply("user:admin", randomUUID());
  assert.equal(plan.revision, 1);
  const delivered = (await remoteTasks.list()).filter((task) => task.type === "network.mesh.configure");
  assert.deepEqual(delivered.map((task) => task.targetNodeId), [alpha]);
  const failure = (await repository.read()).audits.find((event) => event.event === "network.mesh.dispatch-failed");
  assert.deepEqual(failure.parameters.nodeIds, [beta]);
  assert.equal(failure.parameters.revision, 1);
});

test("apply and revoke land on the audit chain, not only on the node protocol log", async () => {
  const { repository, mesh } = await fixture();
  await addNode(repository, { name: "alpha", primaryIp: "203.0.113.7" });
  const beta = await addNode(repository, { name: "beta", primaryIp: "198.51.100.9" });
  const events = [];
  const context = (method, parts) => ({
    request: { method, headers: {}, socket: { remoteAddress: "198.51.100.20" } }, parts, requestId: randomUUID(), body: undefined, config: { trustedProxies: [] },
    response: { statusCode: 0, headers: {}, body: "", setHeader(name, value) { this.headers[name] = value; }, end(body = "") { this.body = body; } },
    services: { mesh, nodes: new NodeService(repository, 10) },
    identity: { require() {}, consumeReauth() {}, audit: { append(event) { events.push(event); } } },
    principal: { type: "session", userId: "admin", id: randomUUID(), permissions: new Set(["nodes:manage"]), nodeScope: "all" },
  });
  const apply = context("POST", ["api", "network", "mesh", "apply"]);
  await routeControlPlaneRequest(apply);
  assert.equal(apply.response.statusCode, 200);
  const revoke = context("DELETE", ["api", "nodes", beta]);
  await routeControlPlaneRequest(revoke);
  assert.equal(revoke.response.statusCode, 200);
  assert.deepEqual(events.map((event) => event.action), ["network.mesh.apply", "network.mesh.revoke"]);
  assert.equal(events[0].parameters.revision, 1);
  assert.deepEqual(events[1].parameters, { nodeId: beta, revision: 2 });
  assert.equal(events[0].targetType, "network-mesh");
});

test("a task still in flight is never duplicated by the heartbeat", async () => {
  const { repository, remoteTasks, mesh } = await fixture();
  const alpha = await addNode(repository, { name: "alpha", primaryIp: "203.0.113.7" });
  const beta = await addNode(repository, { name: "beta", primaryIp: "198.51.100.9" });
  await mesh.apply("user:admin", randomUUID());
  await repository.update((state) => { state.nodes.find((node) => node.nodeId === alpha).meshIdentity.configuredRevision = 1; });
  await mesh.reconcileNode(beta, randomUUID());
  assert.equal((await remoteTasks.list(beta)).filter((task) => task.type === "network.mesh.configure").length, 1, "the queued task is left alone");
  // An attempt that ended without applying is retried under a new key.
  await repository.update((state) => { for (const task of state.tasks) if (task.targetNodeId === beta) task.status = "failed"; });
  await mesh.reconcileNode(beta, randomUUID());
  const tasks = (await remoteTasks.list(beta)).filter((task) => task.type === "network.mesh.configure");
  assert.equal(tasks.length, 2);
  assert.equal(tasks[1].idempotencyKey, `mesh-1-${beta}-1`);
});

test("a catch-up that cannot read the task store never breaks the heartbeat", async () => {
  const repository = new MemoryAgentControlRepository();
  const remoteTasks = new RemoteTaskService(repository);
  const nodeId = await addNode(repository, { name: "alpha", primaryIp: "203.0.113.7" });
  const mesh = new MeshService(repository, { list: async () => { throw new Error("task store unavailable"); }, create: (...args) => remoteTasks.create(...args) });
  await repository.update((state) => {
    state.nodes[0].meshAssignment = { overlayAddress: "100.64.9.9", revision: 2 };
    state.nodes[0].meshIdentity.configuredRevision = 1;
  });
  await assert.doesNotReject(() => mesh.reconcileNode(nodeId, randomUUID()));
});

test("a link left down is reported with its own warning, not hidden behind 已生效", async () => {
  const { repository, mesh } = await fixture();
  await addNode(repository, { name: "alpha" });
  await repository.update((state) => {
    state.nodes[0].meshAssignment = { overlayAddress: "100.64.1.4", revision: 1 };
    state.nodes[0].meshIdentity.configuredRevision = 1;
    state.nodes[0].meshLink = {
      collectedAt: new Date().toISOString(), peerCount: 1, activePeerCount: 1,
      latestHandshakeAt: new Date().toISOString(), firewallEnforced: true, dataPlanePort: 18_080, interfaceUp: false,
    };
  });
  const plan = await mesh.plan();
  assert.equal(plan.nodes[0].interfaceUp, false);
  assert.equal(NetworkMeshPlanResponseSchema.safeParse(plan).success, true);
  assert.ok(plan.warnings.some((warning) => /接口处于 down/.test(warning)));
});
