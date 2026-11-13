import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { AGENT_PROTOCOL_VERSION, MeshPeerDirectoryResponseSchema, NetworkCacheDownloadResponseSchema, NetworkEgressPlanResponseSchema } from "@stackpilot/contracts";
import { routeControlPlaneRequest } from "../../apps/controller/dist/http/controlPlaneRouter.js";
import { routeAgentRequest } from "../../apps/controller/dist/http/agentRouter.js";
import { EgressService } from "../../apps/controller/dist/modules/network/egressService.js";
import { RemoteTaskService } from "../../apps/controller/dist/modules/remote-tasks/remoteTaskService.js";
import { MemoryAgentControlRepository } from "../../apps/controller/dist/repositories/agentControlRepository.js";

const ago = (seconds, now = Date.now()) => new Date(now - seconds * 1_000).toISOString();
const TRANSFER = ["network.cache.read", "network.transfer"];

async function addNode(repository, { name, capabilities = TRANSFER, overlayAddress = "100.64.0.10", status = "online", port = 18080 } = {}) {
  const nodeId = randomUUID();
  const timestamp = new Date().toISOString();
  await repository.update((state) => {
    state.nodes.push({
      nodeId, nodeName: name, status, agentVersion: "0.1.0", protocolVersion: AGENT_PROTOCOL_VERSION, platform: "linux",
      declaredCapabilities: [...capabilities], allowedCapabilities: [...capabilities], enrolledAt: timestamp, lastSeenAt: timestamp, revokedAt: null,
      ...(capabilities.includes("network.transfer") ? {
        meshAssignment: { overlayAddress, revision: 1 },
        meshLink: { collectedAt: timestamp, peerCount: 1, activePeerCount: 1, latestHandshakeAt: timestamp, firewallEnforced: true, dataPlanePort: port, interfaceUp: true },
      } : {}),
    });
  });
  return nodeId;
}

async function addCredential(repository, nodeId, publicKey = `-----BEGIN PUBLIC KEY----- ${randomUUID()} -----END PUBLIC KEY-----`) {
  await repository.update((state) => {
    state.credentials.push({ credentialId: randomUUID(), nodeId, publicKey, createdAt: new Date().toISOString(), revokedAt: null, replacedBy: null, rotationId: null });
  });
  return publicKey;
}

const sample = (host, ttfbMs, bytesPerSecond, collectedAt = ago(30)) => ({ host, ttfbMs, bytesPerSecond, collectedAt });

test("the egress table separates disabled, pending and ready nodes and warns when nothing is probed", async () => {
  const repository = new MemoryAgentControlRepository();
  const egress = new EgressService(repository, new RemoteTaskService(repository));
  await addNode(repository, { name: "reader", capabilities: ["network.cache.read"] });
  const probe = await addNode(repository, { name: "probe", overlayAddress: "100.64.0.11" });
  await addNode(repository, { name: "warm", overlayAddress: "100.64.0.12" });
  egress.record(probe, [sample("example.com", 40, 200_000)]);
  const plan = await egress.plan();
  assert.equal(NetworkEgressPlanResponseSchema.safeParse(plan).success, true);
  assert.deepEqual(plan.nodes.map((node) => node.status), ["disabled", "ready", "pending"]);
  assert.equal(plan.nodes[1].overlayAddress, "100.64.0.11");
  assert.equal(plan.nodes[1].dataPlanePort, 18080);
  assert.equal(plan.nodes[1].samples[0].ttfbMs, 40);
  assert.ok(plan.warnings.some((warning) => /未配置探测源/.test(warning)));
});

test("selection picks the node with the best latency-to-throughput ratio and never itself", async () => {
  const repository = new MemoryAgentControlRepository();
  const egress = new EgressService(repository, new RemoteTaskService(repository));
  const slow = await addNode(repository, { name: "slow", overlayAddress: "100.64.0.20" });
  const fast = await addNode(repository, { name: "fast", overlayAddress: "100.64.0.21" });
  egress.record(slow, [sample("example.com", 100, 1024 ** 2)]);
  egress.record(fast, [sample("example.com", 10, 512 * 1024)]);
  const picked = await egress.select("example.com", slow);
  assert.equal(picked.reason, "selected");
  assert.equal(picked.nodeId, fast);
  assert.equal(picked.overlayAddress, "100.64.0.21");
  assert.equal(picked.dataPlanePort, 18080);
  assert.ok(picked.score > 0);
});

test("a latency-only sample ranks below a node that measured throughput", async () => {
  const repository = new MemoryAgentControlRepository();
  const egress = new EgressService(repository, new RemoteTaskService(repository));
  const measured = await addNode(repository, { name: "measured", overlayAddress: "100.64.0.25" });
  const tiny = await addNode(repository, { name: "tiny", overlayAddress: "100.64.0.26" });
  // A ping-sized source gives a fast first byte and almost no bytes: that is not a throughput win.
  egress.record(tiny, [sample("example.com", 1, 0)]);
  egress.record(measured, [sample("example.com", 40, 2 * 1024 ** 2)]);
  const picked = await egress.select("example.com", randomUUID());
  assert.equal(picked.nodeId, measured);
  assert.ok(picked.score > 0);
  const plan = await egress.plan();
  assert.ok(plan.warnings.some((warning) => /tiny 的探测样本只测出延迟/.test(warning)));
});

test("a stale or missing sample is reported with its reason instead of an unsafe pick", async () => {
  const repository = new MemoryAgentControlRepository();
  const nowMs = Date.now();
  const egress = new EgressService(repository, new RemoteTaskService(repository), { now: () => new Date(nowMs) });
  const only = await addNode(repository, { name: "only", overlayAddress: "100.64.0.30" });
  egress.record(only, [sample("example.com", 50, 100_000, ago(1_000, nowMs))]);
  const stale = await egress.select("example.com", randomUUID());
  assert.equal(stale.reason, "stale");
  assert.equal(stale.nodeId, null);
  assert.equal((await egress.plan()).nodes[0].status, "stale");

  egress.record(only, [sample("example.com", 50, 100_000, ago(5, nowMs))]);
  const selfOnly = await egress.select("example.com", only);
  assert.equal(selfOnly.reason, "self");
  // With no other eligible node in the mesh there is no egress at all; a second node without a
  // sample for this host is reported as a missing sample instead.
  assert.equal((await egress.select("other.example.com", only)).reason, "disabled");
  await addNode(repository, { name: "second", overlayAddress: "100.64.0.31" });
  assert.equal((await egress.select("other.example.com", only)).reason, "no-sample");
});

test("a completed probe task fills the table from the Agent's own measurement", async () => {
  const repository = new MemoryAgentControlRepository();
  const remoteTasks = new RemoteTaskService(repository);
  const egress = new EgressService(repository, remoteTasks, { targets: ["https://example.com/release.tgz"] });
  const nodeId = await addNode(repository, { name: "alpha", overlayAddress: "100.64.0.40" });
  const task = await remoteTasks.create(nodeId, {
    type: "network.egress.probe", parameters: { targets: [{ url: "https://example.com/release.tgz" }] }, expiresInSeconds: 120, idempotencyKey: "probe-run-1",
  }, "controller:egress", randomUUID());
  const [dispatched] = await remoteTasks.poll(nodeId, randomUUID());
  assert.equal(dispatched.taskId, task.taskId);
  const collectedAt = new Date().toISOString();
  await remoteTasks.update(nodeId, {
    taskId: task.taskId, attempt: 1, status: "succeeded", timestamp: collectedAt,
    result: { message: "probed", data: { collectedAt, samples: [{ url: "https://example.com/release.tgz", host: "example.com", ok: true, statusCode: 200, ttfbMs: 33, bytesPerSecond: 900_000, errorCode: null }] }, truncated: false },
  }, randomUUID());
  await egress.collect();
  const plan = await egress.plan();
  assert.equal(plan.nodes[0].status, "ready");
  assert.equal(plan.nodes[0].samples[0].bytesPerSecond, 900_000);
  await egress.collect();
  assert.equal((await egress.plan()).nodes[0].samples.length, 1);
});

test("probing enqueues one task per eligible node and skips nodes without the transfer capability", async () => {
  const repository = new MemoryAgentControlRepository();
  const remoteTasks = new RemoteTaskService(repository);
  const now = new Date();
  const egress = new EgressService(repository, remoteTasks, { targets: ["https://example.com/release.tgz"], now: () => now });
  const eligible = await addNode(repository, { name: "eligible", overlayAddress: "100.64.0.50" });
  const reader = await addNode(repository, { name: "reader", capabilities: ["network.cache.read"] });
  await egress.probe();
  const tasks = await remoteTasks.listReadOnly();
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].targetNodeId, eligible);
  assert.equal(tasks[0].type, "network.egress.probe");
  assert.equal(tasks[0].requiredCapability, "network.transfer");
  assert.equal(tasks.filter((task) => task.targetNodeId === reader).length, 0);
});

test("a download carries the chosen egress and records the decision in the audit log", async () => {
  const repository = new MemoryAgentControlRepository();
  const remoteTasks = new RemoteTaskService(repository);
  const egress = new EgressService(repository, remoteTasks);
  const receiver = await addNode(repository, { name: "receiver", overlayAddress: "100.64.0.60" });
  const helper = await addNode(repository, { name: "helper", overlayAddress: "100.64.0.61" });
  egress.record(helper, [sample("example.com", 20, 400_000)]);
  const access = { permissions: new Set(["tasks:create"]), nodeScope: "all" };
  const created = await egress.download({
    nodeId: receiver, url: "https://example.com/layer.tgz", digest: "a".repeat(64), idempotencyKey: "download-1",
  }, "user:admin", randomUUID(), access, () => undefined);
  assert.equal(NetworkCacheDownloadResponseSchema.safeParse(created).success, true);
  assert.equal(created.selection.nodeId, helper);
  const task = await remoteTasks.getReadOnly(created.taskId);
  assert.deepEqual(task.parameters, { url: "https://example.com/layer.tgz", digest: "a".repeat(64), egress: { nodeId: helper, overlayAddress: "100.64.0.61", port: 18080 } });
  const audits = (await repository.read({ sections: ["audits"] })).audits.filter((event) => event.event === "egress.selected");
  assert.equal(audits.length, 1);
  assert.equal(audits[0].parameters.egressNodeId, helper);
});

test("a download without a fresh sample stays local and audits the reason", async () => {
  const repository = new MemoryAgentControlRepository();
  const remoteTasks = new RemoteTaskService(repository);
  const egress = new EgressService(repository, remoteTasks);
  const receiver = await addNode(repository, { name: "receiver", overlayAddress: "100.64.0.70" });
  await addNode(repository, { name: "helper", overlayAddress: "100.64.0.71" });
  const created = await egress.download({ nodeId: receiver, url: "https://example.com/layer.tgz" }, "user:admin", randomUUID(),
    { permissions: new Set(["tasks:create"]), nodeScope: "all" }, () => undefined);
  assert.equal(created.selection.reason, "no-sample");
  assert.equal(created.selection.nodeId, null);
  const task = await remoteTasks.getReadOnly(created.taskId);
  assert.deepEqual(task.parameters, { url: "https://example.com/layer.tgz" });
  const audits = (await repository.read({ sections: ["audits"] })).audits.filter((event) => event.event === "egress.local");
  assert.equal(audits.length, 1);
});

test("the peer directory exposes overlay addresses and enrolled keys, never revoked ones", async () => {
  const repository = new MemoryAgentControlRepository();
  const egress = new EgressService(repository, new RemoteTaskService(repository));
  const self = await addNode(repository, { name: "self", overlayAddress: "100.64.0.80" });
  const peer = await addNode(repository, { name: "peer", overlayAddress: "100.64.0.81" });
  const gone = await addNode(repository, { name: "gone", overlayAddress: "100.64.0.82" });
  const reader = await addNode(repository, { name: "reader", capabilities: ["network.cache.read"] });
  await addCredential(repository, self);
  const peerKey = await addCredential(repository, peer);
  await addCredential(repository, gone);
  await addCredential(repository, reader);
  await repository.update((state) => { state.nodes.find((node) => node.nodeId === gone).revokedAt = new Date().toISOString(); });

  const directory = await egress.peerDirectory(self);
  assert.equal(MeshPeerDirectoryResponseSchema.safeParse(directory).success, true);
  assert.deepEqual(directory.self, { overlayAddress: "100.64.0.80", revision: 1, dataPlanePort: 18080 });
  assert.deepEqual(directory.peers.map((entry) => entry.nodeId).sort(), [peer]);
  assert.equal(directory.peers[0].publicKey, peerKey);
  assert.equal(directory.peers[0].overlayAddress, "100.64.0.81");
  // A node without an assignment asks too early; it gets no proxy configuration instead of an empty bind.
  assert.equal((await egress.peerDirectory(reader)).self, null);
});

test("GET /api/network/egress and POST /api/network/cache/downloads require their permissions", async () => {
  const repository = new MemoryAgentControlRepository();
  const remoteTasks = new RemoteTaskService(repository);
  const egress = new EgressService(repository, remoteTasks);
  const receiver = await addNode(repository, { name: "receiver", overlayAddress: "100.64.0.90" });
  const helper = await addNode(repository, { name: "helper", overlayAddress: "100.64.0.91" });
  egress.record(helper, [sample("example.com", 25, 700_000)]);
  const required = [];
  const response = () => ({ statusCode: 0, headers: {}, body: "", setHeader(name, value) { this.headers[name] = value; }, end(body = "") { this.body = body; } });

  const listContext = {
    request: { method: "GET", headers: {}, socket: { remoteAddress: "198.51.100.30" } },
    parts: ["api", "network", "egress"], requestId: randomUUID(), body: undefined, config: { trustedProxies: [] }, response: response(),
    services: { egress }, identity: { require(_principal, permission) { required.push(permission); } },
    principal: { type: "session", userId: "admin", id: randomUUID(), permissions: new Set(["nodes:read"]), nodeScope: "all" },
  };
  await routeControlPlaneRequest(listContext);
  assert.equal(listContext.response.statusCode, 200);
  assert.deepEqual(required, ["nodes:read"]);
  assert.equal(NetworkEgressPlanResponseSchema.safeParse(JSON.parse(listContext.response.body)).success, true);

  const downloadContext = {
    request: { method: "POST", headers: {}, socket: { remoteAddress: "198.51.100.30" } },
    parts: ["api", "network", "cache", "downloads"], requestId: randomUUID(),
    body: { nodeId: receiver, url: "https://example.com/layer.tgz" }, config: { trustedProxies: [] }, response: response(),
    services: { egress }, identity: { require(_principal, permission, nodeId) { required.push(nodeId ? `${permission}:${nodeId}` : permission); }, consumeReauth() {} },
    principal: { type: "session", userId: "admin", id: randomUUID(), permissions: new Set(["tasks:create"]), nodeScope: "all" },
  };
  await routeControlPlaneRequest(downloadContext);
  assert.equal(downloadContext.response.statusCode, 201);
  const payload = JSON.parse(downloadContext.response.body);
  assert.equal(NetworkCacheDownloadResponseSchema.safeParse(payload).success, true);
  assert.equal(payload.selection.nodeId, helper);
  assert.ok(required.includes(`tasks:create:${receiver}`));
});

test("the Agent directory route answers only an authenticated peer", async () => {
  const repository = new MemoryAgentControlRepository();
  const egress = new EgressService(repository, new RemoteTaskService(repository));
  const nodeId = await addNode(repository, { name: "self", overlayAddress: "100.64.0.100" });
  await addCredential(repository, nodeId);
  const context = {
    request: { method: "GET", headers: {}, socket: { remoteAddress: "198.51.100.40" } }, url: new URL("https://controller/api/agent/mesh/peers"),
    requestId: randomUUID(), body: undefined, config: {}, response: { statusCode: 0, headers: {}, body: "", setHeader() {}, end(body = "") { this.body = body; } },
    services: { egress }, agentIdentity: { nodeId, credentialId: randomUUID(), protocolVersion: AGENT_PROTOCOL_VERSION },
  };
  await routeAgentRequest(context);
  assert.equal(context.response.statusCode, 200);
  const payload = JSON.parse(context.response.body);
  assert.equal(MeshPeerDirectoryResponseSchema.safeParse(payload).success, true);
  assert.equal(payload.self.overlayAddress, "100.64.0.100");
});

test("an offline node is never selected even with a fresh sample", async () => {
  const repository = new MemoryAgentControlRepository();
  const egress = new EgressService(repository, new RemoteTaskService(repository));
  const self = await addNode(repository, { name: "self", overlayAddress: "100.64.0.110" });
  const offline = await addNode(repository, { name: "offline", overlayAddress: "100.64.0.111", status: "offline" });
  egress.record(offline, [sample("example.com", 10, 900_000)]);
  const picked = await egress.select("example.com", self);
  assert.equal(picked.reason, "offline");
  assert.equal(picked.nodeId, null);
  const plan = await egress.plan();
  assert.equal(plan.nodes.find((node) => node.nodeId === offline).status, "ready");
  assert.ok(plan.warnings.some((warning) => /已离线/.test(warning)));
});

test("a sample dated in the future is not treated as fresh", async () => {
  const repository = new MemoryAgentControlRepository();
  const nowMs = Date.now();
  const egress = new EgressService(repository, new RemoteTaskService(repository), { now: () => new Date(nowMs) });
  const node = await addNode(repository, { name: "skewed", overlayAddress: "100.64.0.120" });
  // A node whose clock runs ten minutes fast would otherwise stay "fresh" forever.
  egress.record(node, [sample("example.com", 20, 500_000, new Date(nowMs + 600_000).toISOString())]);
  assert.equal((await egress.select("example.com", randomUUID())).reason, "stale");
  // The quality table must not advertise a node that selection skips.
  assert.equal((await egress.plan()).nodes[0].status, "stale");
});

test("a user task cannot name its own egress target", async () => {
  const repository = new MemoryAgentControlRepository();
  const remoteTasks = new RemoteTaskService(repository);
  const node = await addNode(repository, { name: "receiver", overlayAddress: "100.64.0.130" });
  const access = { permissions: new Set(["tasks:create"]), nodeScope: "all" };
  const parameters = { url: "https://example.com/layer.tgz", egress: { nodeId: randomUUID(), overlayAddress: "100.64.0.131", port: 18080 } };
  await assert.rejects(() => remoteTasks.createForUser(node, {
    type: "network.cache.fetch", parameters, expiresInSeconds: 900, idempotencyKey: "user-egress-attempt",
  }, "user:admin", randomUUID(), access, () => undefined), (error) => error.status === 403);
  // The Controller-owned path accepts the same parameters; only it decides which peer is called.
  const created = await remoteTasks.createWithEgress(node, {
    type: "network.cache.fetch", parameters, expiresInSeconds: 900, idempotencyKey: "controller-egress",
  }, "user:admin", randomUUID(), access, () => undefined);
  assert.equal(created.status, "queued");
});
