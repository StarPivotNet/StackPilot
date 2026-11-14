import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { AGENT_PROTOCOL_VERSION, MeshPeerDirectoryResponseSchema, NetworkCacheDownloadJobListResponseSchema, NetworkCacheDownloadResponseSchema, NetworkEgressPlanResponseSchema } from "@stackpilot/contracts";
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
  // The table says which piece is missing, not just that selection skips the node.
  assert.deepEqual(plan.nodes.map((node) => node.disabledReason), ["no-overlay", null, null]);
  assert.equal(plan.nodes[1].overlayAddress, "100.64.0.11");
  assert.equal(plan.nodes[1].dataPlanePort, 18080);
  assert.equal(plan.nodes[1].samples[0].ttfbMs, 40);
  assert.ok(plan.warnings.some((warning) => /未配置探测源/.test(warning)));
});

test("a disabled node reports which piece is missing instead of one vague status", async () => {
  const repository = new MemoryAgentControlRepository();
  const egress = new EgressService(repository, new RemoteTaskService(repository));
  const joined = await addNode(repository, { name: "joined", overlayAddress: "100.64.0.40" });
  const unjoined = await addNode(repository, { name: "unjoined", capabilities: ["network.cache.read"] });
  const notAllowed = await addNode(repository, { name: "not-allowed", overlayAddress: "100.64.0.41" });
  const notDeclared = await addNode(repository, { name: "not-declared", overlayAddress: "100.64.0.42" });
  const gone = await addNode(repository, { name: "gone", overlayAddress: "100.64.0.43" });
  await repository.update((state) => {
    const find = (nodeId) => state.nodes.find((node) => node.nodeId === nodeId);
    // The capability is revoked on one side only: the operator's grant and the Agent's claim fail separately.
    find(notAllowed).allowedCapabilities = ["network.cache.read"];
    find(notDeclared).declaredCapabilities = ["network.cache.read"];
    find(gone).revokedAt = new Date().toISOString();
  });

  const plan = await egress.plan();
  assert.equal(NetworkEgressPlanResponseSchema.safeParse(plan).success, true);
  const node = (nodeId) => plan.nodes.find((entry) => entry.nodeId === nodeId);
  assert.equal(node(joined).disabledReason, null);
  assert.notEqual(node(joined).status, "disabled");
  assert.equal(node(unjoined).disabledReason, "no-overlay");
  assert.equal(node(notAllowed).disabledReason, "not-allowed");
  assert.equal(node(notDeclared).disabledReason, "not-declared");
  assert.equal(node(gone).disabledReason, "revoked");
  for (const nodeId of [unjoined, notAllowed, notDeclared, gone]) assert.equal(node(nodeId).status, "disabled");
  // The reason is a report, not a new gate: selection still drops exactly the same nodes.
  assert.equal((await egress.select("example.com", joined)).reason, "disabled");
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
  const quiet = await addNode(repository, { name: "offline-no-sample", overlayAddress: "100.64.0.112", status: "offline" });
  egress.record(offline, [sample("example.com", 10, 900_000)]);
  const picked = await egress.select("example.com", self);
  assert.equal(picked.reason, "offline");
  assert.equal(picked.nodeId, null);
  const plan = await egress.plan();
  // A dead process is not an egress: a fresh sample must not make the table call it ready.
  assert.equal(plan.nodes.find((node) => node.nodeId === offline).status, "offline");
  assert.equal(plan.nodes.find((node) => node.nodeId === quiet).status, "offline");
  // Only the node whose fresh sample could read as ready needs a warning; a second one would spend the cap.
  assert.equal(plan.warnings.filter((warning) => /已离线/.test(warning)).length, 1);
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

test("a segmented download names every eligible peer and audits the plan", async () => {
  const repository = new MemoryAgentControlRepository();
  const remoteTasks = new RemoteTaskService(repository);
  const egress = new EgressService(repository, remoteTasks);
  const receiver = await addNode(repository, { name: "receiver", overlayAddress: "100.64.0.140" });
  const first = await addNode(repository, { name: "first", overlayAddress: "100.64.0.141", port: 18081 });
  const second = await addNode(repository, { name: "second", overlayAddress: "100.64.0.142", port: 18082 });
  const offline = await addNode(repository, { name: "offline", overlayAddress: "100.64.0.143", status: "offline" });
  await addNode(repository, { name: "reader", capabilities: ["network.cache.read"] });
  egress.record(first, [sample("example.com", 20, 900_000)]);
  egress.record(second, [sample("example.com", 30, 800_000)]);

  const created = await egress.download({ nodeId: receiver, url: "https://example.com/layer.tgz", segments: { maxNodes: 4 } },
    "user:admin", randomUUID(), { permissions: new Set(["tasks:create"]), nodeScope: "all" }, () => undefined);
  assert.equal(NetworkCacheDownloadResponseSchema.safeParse(created).success, true);
  // No single node is the egress, and the receiver itself is never a source.
  assert.equal(created.selection, null);
  const expected = [first, second].sort((left, right) => left.localeCompare(right));
  assert.deepEqual(created.segments.sources.map((source) => source.nodeId), expected);
  assert.deepEqual(created.segments.sources.map((source) => source.port), created.segments.sources.map((source) => source.nodeId === first ? 18081 : 18082));
  assert.equal(created.segments.sources.some((source) => source.nodeId === offline || source.nodeId === receiver), false);

  const task = await remoteTasks.getReadOnly(created.taskId);
  assert.deepEqual(task.parameters, { url: "https://example.com/layer.tgz", segments: { sources: created.segments.sources } });
  const audits = (await repository.read({ sections: ["audits"] })).audits;
  const plan = audits.find((event) => event.event === "network.segments.plan");
  assert.equal(plan.parameters.sourceCount, 2);
  assert.deepEqual(plan.parameters.sources, expected);
  assert.equal(plan.parameters.reason, "selected");
});

test("a segmented download without an eligible peer falls back to the egress path", async () => {
  const repository = new MemoryAgentControlRepository();
  const remoteTasks = new RemoteTaskService(repository);
  const egress = new EgressService(repository, remoteTasks);
  const receiver = await addNode(repository, { name: "receiver", overlayAddress: "100.64.0.150" });
  const created = await egress.download({ nodeId: receiver, url: "https://example.com/layer.tgz", segments: { maxNodes: 2 } },
    "user:admin", randomUUID(), { permissions: new Set(["tasks:create"]), nodeScope: "all" }, () => undefined);
  assert.equal(created.selection.nodeId, null);
  assert.equal(created.selection.reason, "disabled");
  assert.equal(created.segments, null);
  const task = await remoteTasks.getReadOnly(created.taskId);
  assert.deepEqual(task.parameters, { url: "https://example.com/layer.tgz" });
  // Both decisions are audited: the plan was dropped, and the fill still went somewhere.
  const audits = (await repository.read({ sections: ["audits"] })).audits.map((event) => event.event);
  assert.deepEqual(audits.filter((event) => event !== "task.created"), ["network.segments.plan", "egress.local"]);
});

test("a user task cannot name its own segment sources", async () => {
  const repository = new MemoryAgentControlRepository();
  const remoteTasks = new RemoteTaskService(repository);
  const node = await addNode(repository, { name: "receiver", overlayAddress: "100.64.0.160" });
  const access = { permissions: new Set(["tasks:create"]), nodeScope: "all" };
  const parameters = { url: "https://example.com/layer.tgz", segments: { sources: [{ nodeId: randomUUID(), overlayAddress: "100.64.0.161", port: 18080 }] } };
  await assert.rejects(() => remoteTasks.createForUser(node, {
    type: "network.cache.fetch", parameters, expiresInSeconds: 900, idempotencyKey: "user-segment-attempt",
  }, "user:admin", randomUUID(), access, () => undefined), (error) => error.status === 403);
  const created = await remoteTasks.createWithEgress(node, {
    type: "network.cache.fetch", parameters, expiresInSeconds: 900, idempotencyKey: "controller-segment",
  }, "user:admin", randomUUID(), access, () => undefined);
  assert.equal(created.status, "queued");
});

test("a running job publishes counters and the Controller derives the rate from two samples", async () => {
  const repository = new MemoryAgentControlRepository();
  const remoteTasks = new RemoteTaskService(repository);
  const egress = new EgressService(repository, remoteTasks);
  const node = await addNode(repository, { name: "receiver", overlayAddress: "100.64.0.170" });
  const access = { permissions: new Set(["tasks:create"]), nodeScope: "all" };
  const created = await remoteTasks.createWithEgress(node, {
    type: "network.cache.fetch", parameters: { url: "https://example.com/layer.tgz" }, expiresInSeconds: 900, idempotencyKey: "progress-job",
  }, "user:admin", randomUUID(), access, () => undefined);
  await remoteTasks.poll(node, randomUUID());

  const started = Date.now();
  const first = await remoteTasks.update(node, {
    taskId: created.taskId, attempt: 1, status: "running", timestamp: new Date(started).toISOString(),
    progress: { bytesReceived: 1024 * 1024, totalBytes: 8 * 1024 * 1024, partsDone: 0, partsTotal: 2,
      parts: [{ index: 0, sourceNodeId: node, bytes: 512 * 1024, totalBytes: 4 * 1024 * 1024 },
        { index: 1, sourceNodeId: node, bytes: 0, totalBytes: 4 * 1024 * 1024 }] },
  }, randomUUID());
  assert.equal(first.status, "running");
  assert.equal(first.progress.bytesReceived, 1024 * 1024);
  // One sample is a position, not a speed.
  assert.equal(first.progress.bytesPerSecond, null);
  assert.deepEqual(first.progress.parts.map((part) => part.bytesPerSecond), [null, null]);

  const second = await remoteTasks.update(node, {
    taskId: created.taskId, attempt: 1, status: "running", timestamp: new Date(started + 10_000).toISOString(),
    progress: { bytesReceived: 3 * 1024 * 1024, totalBytes: 8 * 1024 * 1024, partsDone: 1, partsTotal: 2,
      parts: [{ index: 0, sourceNodeId: node, bytes: 4 * 1024 * 1024, totalBytes: 4 * 1024 * 1024 },
        { index: 1, sourceNodeId: node, bytes: 1024 * 1024, totalBytes: 4 * 1024 * 1024 }] },
  }, randomUUID());
  assert.equal(second.progress.bytesPerSecond, Math.round((2 * 1024 * 1024) / 10));
  // Each part is measured from its own two samples, with the same smoothing as the whole job.
  assert.equal(second.progress.parts[0].bytesPerSecond, Math.round((4 * 1024 * 1024 - 512 * 1024) / 10));
  assert.equal(second.progress.parts[1].bytesPerSecond, Math.round((1024 * 1024) / 10));
  assert.equal(second.progress.partsDone, 1);
  assert.equal(second.progress.partsTotal, 2);

  // A late, smaller sample must not rewind the bar.
  const stale = await remoteTasks.update(node, {
    taskId: created.taskId, attempt: 1, status: "running", timestamp: new Date(started).toISOString(),
    progress: { bytesReceived: 512 * 1024, totalBytes: 8 * 1024 * 1024, partsDone: 0, partsTotal: 2 },
  }, randomUUID());
  assert.equal(stale.progress.bytesReceived, 3 * 1024 * 1024);
  assert.equal(stale.progress.bytesPerSecond, second.progress.bytesPerSecond);
  assert.deepEqual(stale.progress.parts, second.progress.parts);

  // A part that restarts its own range loses its rate even while the job total keeps growing; a part
  // that finished keeps the rate it finished at instead of decaying toward zero.
  const rewind = await remoteTasks.update(node, {
    taskId: created.taskId, attempt: 1, status: "running", timestamp: new Date(started + 20_000).toISOString(),
    progress: { bytesReceived: 4 * 1024 * 1024, totalBytes: 8 * 1024 * 1024, partsDone: 1, partsTotal: 2,
      parts: [{ index: 0, sourceNodeId: node, bytes: 4 * 1024 * 1024, totalBytes: 4 * 1024 * 1024 },
        { index: 1, sourceNodeId: node, bytes: 512 * 1024, totalBytes: 4 * 1024 * 1024 }] },
  }, randomUUID());
  assert.ok(rewind.progress.bytesReceived > second.progress.bytesReceived);
  assert.equal(rewind.progress.parts[0].bytesPerSecond, second.progress.parts[0].bytesPerSecond);
  assert.equal(rewind.progress.parts[1].bytesPerSecond, null);

  // The panel reads the same counters: one line per part, each with its own rate.
  const listed = await egress.jobs({ permissions: new Set(["tasks:read"]), nodeScope: "all" });
  const running = listed.jobs.find((item) => item.taskId === created.taskId);
  assert.equal(running.status, "running");
  assert.deepEqual(running.parts.map((part) => part.index), [0, 1]);
  assert.equal(running.parts[0].bytes, 4 * 1024 * 1024);
  assert.equal(running.parts[0].bytesPerSecond, Math.round((4 * 1024 * 1024 - 512 * 1024) / 10));
  assert.equal(running.parts[1].bytes, 512 * 1024);
  assert.equal(running.parts[1].bytesPerSecond, null);

  // A job that stopped running carries no part rates: the map is telemetry, the row is the truth.
  await remoteTasks.update(node, {
    taskId: created.taskId, attempt: 1, status: "failed", timestamp: new Date(started + 30_000).toISOString(), errorCode: "CACHE_TRANSFER_STALLED",
  }, randomUUID());
  const finished = (await egress.jobs({ permissions: new Set(["tasks:read"]), nodeScope: "all" })).jobs.find((item) => item.taskId === created.taskId);
  assert.deepEqual(finished.parts, []);
  assert.equal(finished.failureReason, "CACHE_TRANSFER_STALLED");
});

test("a job that lapsed unnoticed stops publishing the part rates it had", async () => {
  const repository = new MemoryAgentControlRepository();
  const remoteTasks = new RemoteTaskService(repository);
  let nowMs = Date.now();
  const egress = new EgressService(repository, remoteTasks, { now: () => new Date(nowMs) });
  const node = await addNode(repository, { name: "receiver", overlayAddress: "100.64.0.190" });
  const created = await remoteTasks.createWithEgress(node, {
    type: "network.cache.fetch", parameters: { url: "https://example.com/lapsed.tgz" }, expiresInSeconds: 60, idempotencyKey: "lapsed-job",
  }, "user:admin", randomUUID(), { permissions: new Set(["tasks:create"]), nodeScope: "all" }, () => undefined);
  await remoteTasks.poll(node, randomUUID());
  await remoteTasks.update(node, {
    taskId: created.taskId, attempt: 1, status: "running", timestamp: new Date().toISOString(),
    progress: { bytesReceived: 1024 * 1024, totalBytes: 8 * 1024 * 1024, partsDone: 0, partsTotal: 2,
      parts: [{ index: 0, sourceNodeId: node, bytes: 1024 * 1024, totalBytes: 4 * 1024 * 1024 }] },
  }, randomUUID());
  const access = { permissions: new Set(["tasks:read"]), nodeScope: "all" };
  const live = (await egress.jobs(access)).jobs.find((item) => item.taskId === created.taskId);
  assert.equal(live.parts.length, 1);

  // The Agent died here: no further observation arrives, so the read path is what notices the lapse.
  nowMs += 3_600_000;
  const lapsed = (await egress.jobs(access)).jobs.find((item) => item.taskId === created.taskId);
  assert.equal(lapsed.status, "expired");
  assert.deepEqual(lapsed.parts, []);
  // Housekeeping drops the entry itself instead of holding it for the life of the process.
  await egress.tick();
  assert.equal(egress.liveParts.size, 0);
});

test("the download job list renders the fill result and offers a failed job for retry", async () => {
  const repository = new MemoryAgentControlRepository();
  const remoteTasks = new RemoteTaskService(repository);
  const egress = new EgressService(repository, remoteTasks);
  const receiver = await addNode(repository, { name: "receiver", overlayAddress: "100.64.0.180" });
  const first = await addNode(repository, { name: "first", overlayAddress: "100.64.0.181" });
  const second = await addNode(repository, { name: "second", overlayAddress: "100.64.0.182" });
  const access = { permissions: new Set(["tasks:create", "tasks:read"]), nodeScope: "all" };
  const done = await egress.download({ nodeId: receiver, url: "https://example.com/layer.tgz" }, "user:admin", randomUUID(), access, () => undefined);
  await remoteTasks.poll(receiver, randomUUID());
  const digest = "c".repeat(64);
  await remoteTasks.update(receiver, {
    taskId: done.taskId, attempt: 1, status: "succeeded", timestamp: new Date().toISOString(),
    result: { message: "filled", truncated: false, data: {
      url: "https://example.com/layer.tgz", digest, sizeBytes: 3 * 1024 * 1024, hit: false, originBytes: 0,
      storedAt: new Date().toISOString(), elapsedMs: 3_000, viaEgress: false, segmented: true,
      segmentCount: 2, segmentSources: [first, second], resumedBytes: 1024,
    } },
  }, randomUUID());

  const failed = await egress.download({ nodeId: receiver, url: "https://example.com/other.tgz" }, "user:admin", randomUUID(), access, () => undefined);
  await remoteTasks.poll(receiver, randomUUID());
  await remoteTasks.update(receiver, {
    taskId: failed.taskId, attempt: 1, status: "failed", timestamp: new Date().toISOString(), errorCode: "CACHE_ORIGIN_ERROR",
  }, randomUUID());

  const listed = await egress.jobs({ permissions: new Set(["tasks:read"]), nodeScope: "all" });
  assert.equal(NetworkCacheDownloadJobListResponseSchema.safeParse(listed).success, true);
  assert.equal(typeof listed.collectedAt, "string");
  const job = listed.jobs.find((item) => item.taskId === done.taskId);
  assert.equal(job.nodeName, "receiver");
  assert.equal(job.host, "example.com");
  assert.equal(job.status, "succeeded");
  assert.equal(job.segmented, true);
  assert.equal(job.segmentSources, 2);
  assert.equal(job.resumedBytes, 1024);
  assert.equal(job.digest, digest);
  assert.equal(job.bytesReceived, 3 * 1024 * 1024);
  // A finished job shows the average the Agent measured, not a stale live sample.
  assert.equal(job.bytesPerSecond, 1024 * 1024);
  assert.equal(job.retryable, false);

  const broken = listed.jobs.find((item) => item.taskId === failed.taskId);
  assert.equal(broken.status, "failed");
  assert.equal(broken.failureReason, "CACHE_ORIGIN_ERROR");
  assert.equal(broken.retryable, true);
  // No result means no hit state and no size, not a zero-byte miss.
  assert.equal(broken.hit, null);
  assert.equal(broken.sizeBytes, null);
  assert.equal(broken.segmentCount, 0);
  await assert.rejects(() => egress.jobs({ permissions: new Set(["nodes:read"]), nodeScope: "all" }), (error) => error.status === 403);
});

test("a retry replays the finished job's own parameters once, even when clicked twice", async () => {
  const repository = new MemoryAgentControlRepository();
  const remoteTasks = new RemoteTaskService(repository);
  const egress = new EgressService(repository, remoteTasks);
  const receiver = await addNode(repository, { name: "receiver", overlayAddress: "100.64.0.190" });
  const access = { permissions: new Set(["tasks:create"]), nodeScope: "all" };
  const digest = "d".repeat(64);
  const source = await egress.download({ nodeId: receiver, url: "https://example.com/layer.tgz", digest, maxBytes: 5 * 1024 * 1024 },
    "user:admin", randomUUID(), access, () => undefined);
  await remoteTasks.poll(receiver, randomUUID());
  await remoteTasks.update(receiver, {
    taskId: source.taskId, attempt: 1, status: "failed", timestamp: new Date().toISOString(), errorCode: "CACHE_ORIGIN_ERROR",
  }, randomUUID());

  const first = await egress.retry(source.taskId, "user:admin", randomUUID(), access);
  const second = await egress.retry(source.taskId, "user:admin", randomUUID(), access);
  assert.equal(first.taskId, second.taskId);
  assert.notEqual(first.taskId, source.taskId);
  const replacement = await remoteTasks.getReadOnly(first.taskId);
  assert.equal(replacement.idempotencyKey, `retry-${source.taskId}`);
  assert.deepEqual(replacement.parameters, { url: "https://example.com/layer.tgz", digest, maxBytes: 5 * 1024 * 1024 });
  const audits = (await repository.read({ sections: ["audits"] })).audits.filter((event) => event.event === "network.cache.retry");
  // Two clicks are two audited attempts against one replacement task.
  assert.equal(audits.length, 2);
  assert.deepEqual(new Set(audits.map((event) => event.taskId)), new Set([first.taskId]));
  assert.equal(audits[0].parameters.sourceTaskId, source.taskId);

  // A job that has not finished cannot be retried, and an unknown id is a 404.
  const running = await egress.download({ nodeId: receiver, url: "https://example.com/live.tgz" }, "user:admin", randomUUID(), access, () => undefined);
  await assert.rejects(() => egress.retry(running.taskId, "user:admin", randomUUID(), access), (error) => error.status === 409);
  await assert.rejects(() => egress.retry(randomUUID(), "user:admin", randomUUID(), access), (error) => error.status === 404);
});

test("the download job list and retry routes are gated and return the contract shapes", async () => {
  const repository = new MemoryAgentControlRepository();
  const remoteTasks = new RemoteTaskService(repository);
  const egress = new EgressService(repository, remoteTasks);
  const receiver = await addNode(repository, { name: "receiver", overlayAddress: "100.64.0.200" });
  const access = { permissions: new Set(["tasks:create", "tasks:read"]), nodeScope: "all" };
  const source = await egress.download({ nodeId: receiver, url: "https://example.com/layer.tgz" }, "user:admin", randomUUID(), access, () => undefined);
  await remoteTasks.poll(receiver, randomUUID());
  await remoteTasks.update(receiver, {
    taskId: source.taskId, attempt: 1, status: "failed", timestamp: new Date().toISOString(), errorCode: "CACHE_ORIGIN_ERROR",
  }, randomUUID());

  const required = [];
  const response = () => ({ statusCode: 0, headers: {}, body: "", setHeader(name, value) { this.headers[name] = value; }, end(body = "") { this.body = body; } });
  const principal = (permissions) => ({ type: "session", userId: "admin", id: randomUUID(), permissions: new Set(permissions), nodeScope: "all" });

  const listContext = {
    request: { method: "GET", headers: {}, socket: { remoteAddress: "198.51.100.60" } },
    parts: ["api", "network", "cache", "downloads"], requestId: randomUUID(), body: undefined, config: { trustedProxies: [] }, response: response(),
    services: { egress }, identity: { require(_principal, permission) { required.push(permission); } }, principal: principal(["tasks:read"]),
  };
  await routeControlPlaneRequest(listContext);
  assert.equal(listContext.response.statusCode, 200);
  assert.deepEqual(required, ["tasks:read"]);
  const listed = JSON.parse(listContext.response.body);
  assert.equal(NetworkCacheDownloadJobListResponseSchema.safeParse(listed).success, true);
  assert.equal(listed.jobs[0].taskId, source.taskId);
  assert.equal(listed.jobs[0].retryable, true);

  const retryContext = {
    request: { method: "POST", headers: {}, socket: { remoteAddress: "198.51.100.60" } },
    parts: ["api", "network", "cache", "downloads", source.taskId, "retry"], requestId: randomUUID(), body: {}, config: { trustedProxies: [] }, response: response(),
    services: { egress }, identity: { require(_principal, permission) { required.push(permission); }, consumeReauth() { required.push("reauth"); } }, principal: principal(["tasks:create"]),
  };
  await routeControlPlaneRequest(retryContext);
  assert.equal(retryContext.response.statusCode, 201);
  // A retry replays accepted parameters, so it must not consume a reauthentication proof.
  assert.deepEqual(required.slice(1), ["tasks:create"]);
  const created = JSON.parse(retryContext.response.body);
  assert.equal(NetworkCacheDownloadResponseSchema.safeParse(created).success, true);
  assert.notEqual(created.taskId, source.taskId);
});
