import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { AGENT_PROTOCOL_VERSION } from "@stackpilot/contracts";
import { EgressService } from "../../apps/controller/dist/modules/network/egressService.js";
import { MeshService } from "../../apps/controller/dist/modules/network/meshService.js";
import { isNodeLive } from "../../apps/controller/dist/modules/nodes/nodeLiveness.js";
import { RemoteTaskService } from "../../apps/controller/dist/modules/remote-tasks/remoteTaskService.js";
import { MemoryAgentControlRepository } from "../../apps/controller/dist/repositories/agentControlRepository.js";

const HOST = "origin.example.com";
const OBJECT_URL = `https://${HOST}/a.bin`;
const TRANSFER = ["network.cache.read", "network.transfer"];

test("isNodeLive reads the heartbeat, not the stored status", () => {
  const now = Date.parse("2026-01-01T00:00:00.000Z");
  const at = (seconds) => new Date(now - seconds * 1_000).toISOString();
  const base = { status: "online", revokedAt: null, lastSeenAt: at(5) };

  assert.equal(isNodeLive(base, now), true);
  assert.equal(isNodeLive({ ...base, lastSeenAt: at(46) }, now), false);
  assert.equal(isNodeLive({ ...base, status: "pending" }, now), false);
  assert.equal(isNodeLive({ ...base, revokedAt: at(1) }, now), false);
  // A node that never reported a heartbeat is not evidence of silence.
  assert.equal(isNodeLive({ ...base, lastSeenAt: null }, now), true);
});

async function addNode(repository, { name, lastSeenMs = 0, port = 18080, capabilities = TRANSFER }) {
  const nodeId = randomUUID();
  const seen = new Date(Date.now() - lastSeenMs).toISOString();
  await repository.update((state) => {
    state.nodes.push({
      nodeId, nodeName: name, status: "online", agentVersion: "0.1.0", protocolVersion: AGENT_PROTOCOL_VERSION, platform: "linux",
      declaredCapabilities: [...capabilities], allowedCapabilities: [...capabilities], enrolledAt: seen, lastSeenAt: seen, revokedAt: null,
      meshAssignment: { overlayAddress: "100.64.0.10", revision: 1 },
      meshIdentity: { interfaceName: "wg0", publicKey: `public-key-${name}`, configuredRevision: 1 },
      meshLink: {
        collectedAt: seen, peerCount: 1, activePeerCount: 1, latestHandshakeAt: seen,
        firewallEnforced: true, dataPlanePort: port, interfaceUp: true,
      },
    });
  });
  return nodeId;
}

async function ingestSample(remoteTasks, nodeId, { ttfbMs, bytesPerSecond }) {
  const task = await remoteTasks.create(nodeId, {
    type: "network.egress.probe", parameters: { targets: [{ url: OBJECT_URL }] }, expiresInSeconds: 60,
    idempotencyKey: `probe-${nodeId}-${randomUUID()}`,
  }, "controller:test", randomUUID());
  await remoteTasks.poll(nodeId, randomUUID());
  await remoteTasks.update(nodeId, {
    taskId: task.taskId, attempt: 1, status: "succeeded", timestamp: new Date().toISOString(),
    result: {
      message: "probe",
      data: {
        collectedAt: new Date().toISOString(),
        samples: [{ url: OBJECT_URL, host: HOST, ok: true, statusCode: 200, ttfbMs, bytesPerSecond, errorCode: null }],
      },
      truncated: false,
    },
  }, randomUUID());
}

test("a silent node is skipped by the plan, the routing, the segmentation and the probe loop", async () => {
  const repository = new MemoryAgentControlRepository();
  const remoteTasks = new RemoteTaskService(repository);
  const receiver = await addNode(repository, { name: "receiver" });
  const silent = await addNode(repository, { name: "silent", lastSeenMs: 90_000 });
  // The silent node measured the best link before it stopped heartbeating.
  await ingestSample(remoteTasks, receiver, { ttfbMs: 400, bytesPerSecond: 2 * 1024 * 1024 });
  await ingestSample(remoteTasks, silent, { ttfbMs: 20, bytesPerSecond: 20 * 1024 * 1024 });

  const egress = new EgressService(repository, remoteTasks, { targets: [OBJECT_URL] });
  await egress.collect();

  const plan = await egress.plan();
  assert.ok(plan.warnings.some((warning) => warning.includes("silent") && warning.includes("已离线")), plan.warnings.join(" | "));

  const selection = await egress.select(HOST, receiver);
  assert.notEqual(selection.nodeId, silent);
  assert.equal(selection.reason, "self");

  const access = { permissions: new Set(["tasks:create"]), nodeScope: "all" };
  const download = await egress.download(
    { nodeId: receiver, url: OBJECT_URL, segments: { maxNodes: 2 } },
    "user:test", randomUUID(), access, () => undefined,
  );
  assert.deepEqual(download.segments?.sources ?? [], []);

  const before = (await repository.read({ sections: ["tasks"] })).tasks.length;
  await egress.probe();
  const queued = (await repository.read({ sections: ["tasks"] })).tasks.slice(before);
  assert.deepEqual(queued.map((task) => task.targetNodeId), [receiver]);
});

test("the mesh plan reports a silent node offline", async () => {
  const repository = new MemoryAgentControlRepository();
  const remoteTasks = new RemoteTaskService(repository);
  const silent = await addNode(repository, { name: "silent", lastSeenMs: 90_000, capabilities: ["network.mesh.configure"] });

  const plan = await new MeshService(repository, remoteTasks).plan();
  assert.ok(plan.nodes.some((state) => state.nodeId === silent));
  assert.ok(plan.warnings.some((warning) => warning.includes("silent") && warning.includes("当前离线")), plan.warnings.join(" | "));
});
