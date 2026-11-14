import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AGENT_PROTOCOL_VERSION, NetworkCacheDownloadJobListResponseSchema, NetworkMeshPlanResponseSchema } from "@stackpilot/contracts";
import { openDatabase } from "../../apps/controller/dist/database/database.js";
import { EgressService } from "../../apps/controller/dist/modules/network/egressService.js";
import { MeshService } from "../../apps/controller/dist/modules/network/meshService.js";
import { RemoteTaskService } from "../../apps/controller/dist/modules/remote-tasks/remoteTaskService.js";
import { MemoryAgentControlRepository } from "../../apps/controller/dist/repositories/agentControlRepository.js";
import {
  MemoryNetworkObservabilityRepository, SqliteNetworkObservabilityRepository, downloadTrafficTotal,
} from "../../apps/controller/dist/repositories/networkObservabilityRepository.js";

const TRANSFER = ["network.cache.read", "network.transfer"];
const READ = { permissions: new Set(["tasks:read"]), nodeScope: "all" };
const WRITE = { permissions: new Set(["tasks:create", "tasks:read"]), nodeScope: "all" };
const MIB = 1024 * 1024;

async function addNode(repository, { name, capabilities = TRANSFER, overlayAddress = "100.64.0.10", configuredRevision = 0, peerCount = null } = {}) {
  const nodeId = randomUUID();
  const timestamp = new Date().toISOString();
  await repository.update((state) => {
    state.nodes.push({
      nodeId, nodeName: name, status: "online", agentVersion: "0.1.0", protocolVersion: AGENT_PROTOCOL_VERSION, platform: "linux",
      declaredCapabilities: [...capabilities], allowedCapabilities: [...capabilities], enrolledAt: timestamp, lastSeenAt: timestamp, revokedAt: null,
      ...(capabilities.includes("network.mesh.configure") ? {
        meshIdentity: { interfaceName: "wg0", publicKey: randomBytes(32).toString("base64"), configuredRevision },
        telemetry: { collectedAt: timestamp, hostname: name, primaryIp: "203.0.113.7", cpu: null, memory: null, loadAverage: null, disks: [], uptimeSeconds: 60 },
      } : {}),
      ...(capabilities.includes("network.transfer") ? {
        meshAssignment: { overlayAddress, revision: 1 },
        meshLink: { collectedAt: timestamp, peerCount: 1, activePeerCount: 1, latestHandshakeAt: timestamp, firewallEnforced: true, dataPlanePort: 18080, interfaceUp: true },
      } : {}),
      ...(peerCount === null ? {} : { meshLink: { collectedAt: timestamp, peerCount, activePeerCount: peerCount, latestHandshakeAt: timestamp, firewallEnforced: true, dataPlanePort: 18080, interfaceUp: true } }),
    });
  });
  return nodeId;
}

const jobRow = (overrides = {}) => ({
  taskId: randomUUID(), nodeId: randomUUID(), url: "https://example.com/layer.tgz", host: "example.com", digest: null,
  status: "running", bytesReceived: 0, totalBytes: null, partsDone: 0, partsTotal: 0, segmented: false, segmentCount: 0,
  segmentSources: 0, bytesPerSecond: null, resumedBytes: 0, hit: null, viaEgress: null, originBytes: null, sizeBytes: null,
  failureReason: null, attempt: 1, createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:01.000Z",
  expiresAt: "2026-08-01T00:15:00.000Z", ...overrides,
});

const fill = ({ sizeBytes, parts, viaEgress = true, digest = "a".repeat(64) }) => ({
  taskId: null, attempt: 1, status: "succeeded", timestamp: new Date().toISOString(),
  result: { message: "filled", truncated: false, data: {
    url: "https://example.com/layer.tgz", digest, sizeBytes, hit: false, originBytes: 0, storedAt: new Date().toISOString(),
    elapsedMs: 3_000, viaEgress, segmented: parts.length > 0, segmentCount: parts.length,
    segmentSources: [...new Set(parts.map((part) => part.sourceNodeId))],
    ...(parts.length > 0 ? { parts } : {}), resumedBytes: 0,
  } },
});

test("job rows are durable, so a restarted Controller lists a job without re-reading tasks", async () => {
  const repository = new MemoryAgentControlRepository();
  const remoteTasks = new RemoteTaskService(repository);
  const store = new MemoryNetworkObservabilityRepository();
  const egress = new EgressService(repository, remoteTasks, { store });
  const receiver = await addNode(repository, { name: "receiver", overlayAddress: "100.64.0.10" });
  const peer = await addNode(repository, { name: "peer", overlayAddress: "100.64.0.11" });

  const job = await egress.download({ nodeId: receiver, url: "https://example.com/layer.tgz", segments: { maxNodes: 2 } }, "user:admin", randomUUID(), WRITE, () => undefined);
  await remoteTasks.poll(receiver, randomUUID());
  await remoteTasks.update(receiver, { ...fill({ sizeBytes: 3 * MIB, parts: [{ index: 0, sourceNodeId: peer, bytes: 3 * MIB, resumed: false }] }), taskId: job.taskId }, randomUUID());

  const restarted = new EgressService(repository, remoteTasks, { store });
  const listed = await restarted.jobs(READ);
  assert.equal(NetworkCacheDownloadJobListResponseSchema.safeParse(listed).success, true);
  assert.equal(listed.jobs.length, 1);
  assert.equal(listed.jobs[0].taskId, job.taskId);
  assert.equal(listed.jobs[0].status, "succeeded");
  assert.equal(listed.jobs[0].sizeBytes, 3 * MIB);
  assert.equal(listed.jobs[0].bytesPerSecond, MIB);
});

test("a job that predates the rows is backfilled by hydrate instead of leaving the panel blank", async () => {
  const repository = new MemoryAgentControlRepository();
  const remoteTasks = new RemoteTaskService(repository);
  const receiver = await addNode(repository, { name: "receiver", overlayAddress: "100.64.0.20" });
  // A task an older Controller created: no observer ever wrote a row for it.
  const legacy = await remoteTasks.create(receiver, {
    type: "network.cache.fetch", parameters: { url: "https://example.com/old.tgz" }, expiresInSeconds: 900, idempotencyKey: "legacy-task-key",
  }, "user:admin", randomUUID());

  const egress = new EgressService(repository, remoteTasks, { store: new MemoryNetworkObservabilityRepository() });
  assert.equal((await egress.jobs(READ)).jobs.length, 0);
  await egress.hydrate();
  const listed = await egress.jobs(READ);
  assert.equal(listed.jobs.length, 1);
  assert.equal(listed.jobs[0].taskId, legacy.taskId);
});

test("an unfinished job past its lifetime is reported expired, and the read does not rewrite it", async () => {
  const repository = new MemoryAgentControlRepository();
  const remoteTasks = new RemoteTaskService(repository);
  let clock = Date.now();
  const egress = new EgressService(repository, remoteTasks, { now: () => new Date(clock) });
  const receiver = await addNode(repository, { name: "receiver", overlayAddress: "100.64.0.30" });
  const job = await egress.download({ nodeId: receiver, url: "https://example.com/slow.tgz", expiresInSeconds: 30 }, "user:admin", randomUUID(), WRITE, () => undefined);

  // The Agent never polls again, so no task write ever records the expiry.
  clock += 31_000;
  const listed = await egress.jobs(READ);
  assert.equal(listed.jobs[0].taskId, job.taskId);
  assert.equal(listed.jobs[0].status, "expired");
  assert.equal(listed.jobs[0].failureReason, "TASK_EXPIRED");
  assert.equal(listed.jobs[0].retryable, true);
  assert.equal((await remoteTasks.getReadOnly(job.taskId)).status, "queued");
});

test("the month meter counts received and served bytes and a node over quota loses both acceleration paths", async () => {
  const repository = new MemoryAgentControlRepository();
  const remoteTasks = new RemoteTaskService(repository);
  const store = new MemoryNetworkObservabilityRepository();
  const quotaBytes = 2 * MIB;
  const egress = new EgressService(repository, remoteTasks, { store, trafficQuotaBytes: quotaBytes });
  const receiver = await addNode(repository, { name: "receiver", overlayAddress: "100.64.0.40" });
  const peer = await addNode(repository, { name: "peer", overlayAddress: "100.64.0.41" });

  const job = await egress.download({ nodeId: receiver, url: "https://example.com/layer.tgz", segments: { maxNodes: 2 } }, "user:admin", randomUUID(), WRITE, () => undefined);
  await remoteTasks.poll(receiver, randomUUID());
  await remoteTasks.update(receiver, { ...fill({ sizeBytes: 3 * MIB, parts: [{ index: 0, sourceNodeId: peer, bytes: 3 * MIB, resumed: false }] }), taskId: job.taskId }, randomUUID());

  const listed = await egress.jobs(READ);
  const peerTraffic = listed.traffic.nodes.find((node) => node.nodeId === peer);
  const receiverTraffic = listed.traffic.nodes.find((node) => node.nodeId === receiver);
  assert.equal(listed.traffic.quotaBytes, quotaBytes);
  assert.match(listed.traffic.monthStart, /^\d{4}-\d{2}-01T00:00:00\.000Z$/);
  // The peer carried the whole object, so it served it and received none of it.
  assert.equal(peerTraffic.servedBytes, 3 * MIB);
  assert.equal(peerTraffic.receivedBytes, 0);
  assert.equal(receiverTraffic.receivedBytes, 3 * MIB);
  assert.equal(peerTraffic.degraded, true);
  assert.equal(receiverTraffic.degraded, true);
  assert.equal(downloadTrafficTotal({ nodeId: peer, receivedBytes: 0, originBytes: 0, servedBytes: 3 * MIB }), 3 * MIB);

  // Over quota: the download still runs, but the Controller stops sharding and stops delegating.
  const blocked = await egress.download({ nodeId: peer, url: "https://example.com/next.tgz", segments: { maxNodes: 2 } }, "user:admin", randomUUID(), WRITE, () => undefined);
  assert.equal(blocked.segments, null);
  assert.equal(blocked.selection, null);
  const parameters = (await remoteTasks.getReadOnly(blocked.taskId)).parameters;
  assert.equal(parameters.segments, undefined);
  assert.equal(parameters.egress, undefined);
  const audits = (await repository.read({ sections: ["audits"] })).audits;
  const quotaAudit = audits.filter((event) => event.event === "network.traffic.quota").at(-1);
  assert.equal(quotaAudit.taskId, blocked.taskId);
  assert.equal(quotaAudit.parameters.monthStart, listed.traffic.monthStart);
  assert.deepEqual(quotaAudit.parameters.dropped, ["segments"]);

  // A node under its quota keeps sharding, which is the whole point of the meter.
  const spare = await addNode(repository, { name: "spare", overlayAddress: "100.64.0.42" });
  const allowed = await egress.download({ nodeId: spare, url: "https://example.com/more.tgz", segments: { maxNodes: 2 } }, "user:admin", randomUUID(), WRITE, () => undefined);
  assert.equal(allowed.segments.sources.length, 2);
});

test("a zero quota records traffic without ever degrading a node", async () => {
  const repository = new MemoryAgentControlRepository();
  const remoteTasks = new RemoteTaskService(repository);
  const egress = new EgressService(repository, remoteTasks, { trafficQuotaBytes: 0 });
  const receiver = await addNode(repository, { name: "receiver", overlayAddress: "100.64.0.50" });
  const job = await egress.download({ nodeId: receiver, url: "https://example.com/layer.tgz" }, "user:admin", randomUUID(), WRITE, () => undefined);
  await remoteTasks.poll(receiver, randomUUID());
  await remoteTasks.update(receiver, { ...fill({ sizeBytes: 4 * MIB, parts: [] }), taskId: job.taskId }, randomUUID());
  const listed = await egress.jobs(READ);
  assert.equal(listed.traffic.quotaBytes, 0);
  assert.equal(listed.traffic.nodes[0].receivedBytes, 4 * MIB);
  assert.equal(listed.traffic.nodes[0].degraded, false);
});

test("a cache hit is metered as zero, because it never crossed the network", async () => {
  const dir = await mkdtemp(join(tmpdir(), "stackpilot-hit-meter-"));
  const path = join(dir, "stackpilot.db");
  let database = null;
  try {
    database = openDatabase(path);
    const stores = [new MemoryNetworkObservabilityRepository(), new SqliteNetworkObservabilityRepository(database)];
    const nodeId = randomUUID();
    for (const store of stores) {
      store.saveJob(jobRow({ nodeId, status: "succeeded", hit: true, sizeBytes: 4 * MIB, bytesReceived: 4 * MIB, originBytes: 0 }));
      store.saveJob(jobRow({ nodeId, status: "succeeded", hit: false, sizeBytes: 2 * MIB, bytesReceived: 2 * MIB, originBytes: 2 * MIB }));
      // A job still running has no verdict yet, so what it has received so far is real traffic.
      store.saveJob(jobRow({ nodeId, status: "running", hit: null, bytesReceived: MIB, sizeBytes: null }));
    }
    const [memory, sqlite] = stores.map((store) => store.trafficSince("2026-08-01T00:00:00.000Z")[0]);
    assert.equal(memory.receivedBytes, 3 * MIB);
    assert.deepEqual(sqlite, memory, "the two stores must meter identically");
  } finally {
    database?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("reading the panel writes no row, not even the expiry it derives", async () => {
  const repository = new MemoryAgentControlRepository();
  const remoteTasks = new RemoteTaskService(repository);
  const store = new MemoryNetworkObservabilityRepository();
  const writes = [];
  for (const method of ["saveJob", "saveSegments", "saveMeshPeers", "pruneJobs"]) {
    const original = store[method].bind(store);
    store[method] = (...args) => { writes.push(method); return original(...args); };
  }
  let clock = Date.now();
  const egress = new EgressService(repository, remoteTasks, { store, now: () => new Date(clock) });
  const receiver = await addNode(repository, { name: "receiver", overlayAddress: "100.64.0.60" });
  const job = await egress.download({ nodeId: receiver, url: "https://example.com/slow.tgz", expiresInSeconds: 30 }, "user:admin", randomUUID(), WRITE, () => undefined);
  assert.deepEqual(writes, ["saveJob"], "creating a job writes its row once");
  writes.length = 0;

  clock += 31_000;
  const listed = await egress.jobs(READ);
  assert.equal(listed.jobs[0].taskId, job.taskId);
  assert.equal(listed.jobs[0].status, "expired");
  assert.deepEqual(writes, [], "a read must never persist the expiry it computed");
});

test("a node whose peer count differs from what it was handed is reported, not assumed healthy", async () => {
  const repository = new MemoryAgentControlRepository();
  const remoteTasks = new RemoteTaskService(repository);
  const store = new MemoryNetworkObservabilityRepository();
  const mesh = new MeshService(repository, remoteTasks, store);
  const alpha = await addNode(repository, { name: "alpha", capabilities: ["network.mesh.configure"], configuredRevision: 5, peerCount: 1 });
  const beta = await addNode(repository, { name: "beta", capabilities: ["network.mesh.configure"], configuredRevision: 5, peerCount: 3 });
  const gamma = await addNode(repository, { name: "gamma", capabilities: ["network.mesh.configure"], configuredRevision: 5, peerCount: 2 });
  const stamp = new Date().toISOString();
  // What the Controller handed alpha and beta at revision 5: the other two members.
  store.saveMeshPeers(alpha, 5, [beta, gamma], stamp);
  store.saveMeshPeers(beta, 5, [alpha, gamma], stamp);
  store.saveMeshPeers(gamma, 5, [alpha, beta], stamp);

  const plan = await mesh.plan();
  assert.equal(NetworkMeshPlanResponseSchema.safeParse(plan).success, true);
  assert.ok(plan.warnings.some((warning) => /alpha 报告 1 个 peer，少于下发的 2 个/.test(warning)));
  assert.ok(plan.warnings.some((warning) => /beta 报告 3 个 peer，多于下发的 2 个/.test(warning)));
  // A node that matches its record is not warned about.
  assert.equal(plan.warnings.some((warning) => /gamma 报告/.test(warning)), false);

  // A record from an older revision is not evidence about the configuration in flight.
  store.saveMeshPeers(gamma, 4, [alpha], stamp);
  assert.equal((await mesh.plan()).warnings.some((warning) => /gamma 报告/.test(warning)), false);
});

test("apply records the adjacency it dispatched, so a later membership change cannot rewrite history", async () => {
  const repository = new MemoryAgentControlRepository();
  const remoteTasks = new RemoteTaskService(repository);
  const store = new MemoryNetworkObservabilityRepository();
  const mesh = new MeshService(repository, remoteTasks, store);
  const alpha = await addNode(repository, { name: "alpha", capabilities: ["network.mesh.configure"] });
  const beta = await addNode(repository, { name: "beta", capabilities: ["network.mesh.configure"] });
  await mesh.apply("user:admin", randomUUID(), () => undefined);
  assert.deepEqual(store.meshPeerCounts(), [
    { nodeId: [...store.meshPeerCounts()].map((record) => record.nodeId).sort()[0], revision: 1, peerCount: 1 },
    { nodeId: [...store.meshPeerCounts()].map((record) => record.nodeId).sort()[1], revision: 1, peerCount: 1 },
  ]);
  assert.deepEqual(new Set(store.meshPeerCounts().map((record) => record.nodeId)), new Set([alpha, beta]));
});

test("the sqlite store round-trips jobs, parts, traffic and peer counts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "stackpilot-observability-"));
  const path = join(dir, "stackpilot.db");
  let database = null;
  try {
    database = openDatabase(path);
    const store = new SqliteNetworkObservabilityRepository(database);
    const nodeId = randomUUID();
    const servedBy = randomUUID();
    const job = jobRow({ nodeId, status: "succeeded", sizeBytes: 5 * MIB, bytesReceived: 5 * MIB, originBytes: MIB, segmented: true, segmentCount: 2, segmentSources: 1, bytesPerSecond: MIB, hit: false, viaEgress: true, digest: "b".repeat(64), partsDone: 2, partsTotal: 2 });
    store.saveJob(job);
    // A second save is the same row, not a second job.
    store.saveJob({ ...job, status: "succeeded", bytesPerSecond: 2 * MIB });
    store.saveSegments(job.taskId, [
      { jobId: job.taskId, partIndex: 0, sourceNodeId: servedBy, bytes: 3 * MIB, resumed: false },
      { jobId: job.taskId, partIndex: 1, sourceNodeId: servedBy, bytes: 2 * MIB, resumed: true },
    ]);
    // Re-reporting the parts replaces them instead of doubling the served bytes.
    store.saveSegments(job.taskId, [{ jobId: job.taskId, partIndex: 0, sourceNodeId: servedBy, bytes: 3 * MIB, resumed: false }]);

    const [listed] = store.listJobs(10);
    assert.equal(listed.taskId, job.taskId);
    assert.equal(listed.segmented, true);
    assert.equal(listed.segmentSources, 1);
    assert.equal(listed.bytesPerSecond, 2 * MIB);
    assert.equal(listed.hit, false);
    assert.equal(listed.digest, "b".repeat(64));

    const traffic = store.trafficSince("2026-08-01T00:00:00.000Z");
    assert.deepEqual(traffic.find((record) => record.nodeId === nodeId), { nodeId, receivedBytes: 5 * MIB, originBytes: MIB, servedBytes: 0 });
    assert.deepEqual(traffic.find((record) => record.nodeId === servedBy), { nodeId: servedBy, receivedBytes: 0, originBytes: 0, servedBytes: 3 * MIB });
    // A month that starts after the job's creation does not count it.
    assert.deepEqual(store.trafficSince("2026-09-01T00:00:00.000Z"), []);
    // Node scoping is a filter, not a different total.
    assert.deepEqual(store.trafficSince("2026-08-01T00:00:00.000Z", [servedBy]).map((record) => record.nodeId), [servedBy]);
    assert.equal(store.listJobs(10, [randomUUID()]).length, 0);

    store.saveMeshPeers(nodeId, 7, [servedBy, randomUUID()], "2026-08-01T00:00:00.000Z");
    store.saveMeshPeers(nodeId, 8, [servedBy], "2026-08-01T00:05:00.000Z");
    assert.deepEqual(store.meshPeerCounts(), [{ nodeId, revision: 8, peerCount: 1 }]);

    store.pruneJobs("2026-09-01T00:00:00.000Z");
    assert.deepEqual(store.listJobs(10), []);
    assert.deepEqual(store.trafficSince("2026-08-01T00:00:00.000Z"), []);
  } finally {
    database?.close();
    await rm(dir, { recursive: true, force: true });
  }
});
