import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { AGENT_PROTOCOL_VERSION, NetworkCachePlanResponseSchema } from "@stackpilot/contracts";
import { routeControlPlaneRequest } from "../../apps/controller/dist/http/controlPlaneRouter.js";
import { CacheService } from "../../apps/controller/dist/modules/network/cacheService.js";
import { NodeService } from "../../apps/controller/dist/modules/nodes/nodeService.js";
import { RemoteTaskService } from "../../apps/controller/dist/modules/remote-tasks/remoteTaskService.js";
import { MemoryAgentControlRepository } from "../../apps/controller/dist/repositories/agentControlRepository.js";

const GIB = 1024 ** 3;
const ago = (seconds) => new Date(Date.now() - seconds * 1_000).toISOString();

const stats = (overrides = {}) => ({
  collectedAt: ago(5), capacityBytes: 5 * GIB, usedBytes: GIB, entryCount: 12,
  hits: 30, misses: 10, evictions: 2, diskFreeBytes: 8 * GIB, ...overrides,
});

async function addNode(repository, { name = "alpha", capabilities = ["network.cache.read"], platform = "linux", cacheStats } = {}) {
  const nodeId = randomUUID();
  const timestamp = new Date().toISOString();
  await repository.update((state) => {
    state.nodes.push({
      nodeId, nodeName: name, status: "online", agentVersion: "0.1.0", protocolVersion: AGENT_PROTOCOL_VERSION, platform,
      declaredCapabilities: [...capabilities], allowedCapabilities: [...capabilities], enrolledAt: timestamp, lastSeenAt: timestamp, revokedAt: null,
      ...(cacheStats ? { cacheStats } : {}),
    });
  });
  return nodeId;
}

test("a node without the read capability is disabled and reports no metrics", async () => {
  const repository = new MemoryAgentControlRepository();
  const cache = new CacheService(repository);
  await addNode(repository, { name: "alpha" });
  await addNode(repository, { name: "beta", capabilities: ["system.summary.read"] });
  const plan = await cache.plan();
  assert.equal(NetworkCachePlanResponseSchema.safeParse(plan).success, true);
  assert.deepEqual(plan.nodes.map((node) => node.status), ["pending", "disabled"]);
  assert.equal(plan.nodes[1].stats, null);
  assert.ok(plan.warnings.some((warning) => /beta 未授权 network\.cache\.read/.test(warning)));
  assert.ok(plan.warnings.some((warning) => /alpha 尚未上报缓存指标/.test(warning)));
});

test("a metric older than five minutes reads as stale instead of ready", async () => {
  const repository = new MemoryAgentControlRepository();
  const cache = new CacheService(repository);
  await addNode(repository, { name: "alpha", cacheStats: stats({ collectedAt: ago(600) }) });
  const plan = await cache.plan();
  assert.equal(plan.nodes[0].status, "stale");
  assert.ok(plan.warnings.some((warning) => /alpha 的缓存指标已过期（10 分钟前采集）/.test(warning)));
});

test("warnings flag a full cache and a disk below the reserve", async () => {
  const repository = new MemoryAgentControlRepository();
  const cache = new CacheService(repository);
  await addNode(repository, { name: "alpha", cacheStats: stats({ usedBytes: 5 * GIB, capacityBytes: 5 * GIB, diskFreeBytes: 200 * 1024 ** 2 }) });
  const plan = await cache.plan();
  assert.equal(plan.nodes[0].status, "ready");
  assert.ok(plan.warnings.some((warning) => /已用满 5\.0 GB/.test(warning)));
  assert.ok(plan.warnings.some((warning) => /磁盘剩余 200\.0 MB/.test(warning)));
});

test("a heartbeat stores the cache metrics on the node record", async () => {
  const repository = new MemoryAgentControlRepository();
  const nodes = new NodeService(repository, 10);
  const nodeId = await addNode(repository);
  const reported = stats();
  await nodes.heartbeat(nodeId, {
    nodeId, agentVersion: "0.2.0", protocolVersion: AGENT_PROTOCOL_VERSION, timestamp: new Date().toISOString(),
    platform: "linux", capabilities: ["network.cache.read"], health: { status: "healthy", uptimeSeconds: 5 }, cache: reported,
  }, randomUUID());
  const plan = await new CacheService(repository).plan();
  assert.equal(plan.nodes[0].status, "ready");
  assert.deepEqual(plan.nodes[0].stats, reported);
});

test("GET /api/network/cache requires nodes:read and answers with the plan schema", async () => {
  const repository = new MemoryAgentControlRepository();
  const cache = new CacheService(repository);
  await addNode(repository, { name: "alpha", cacheStats: stats() });
  const required = [];
  const context = {
    request: { method: "GET", headers: {}, socket: { remoteAddress: "198.51.100.20" } },
    parts: ["api", "network", "cache"], requestId: randomUUID(), body: undefined, config: { trustedProxies: [] },
    response: { statusCode: 0, headers: {}, body: "", setHeader(name, value) { this.headers[name] = value; }, end(body = "") { this.body = body; } },
    services: { cache, nodes: new NodeService(repository, 10) },
    identity: { require(_principal, permission) { required.push(permission); } },
    principal: { type: "session", userId: "admin", id: randomUUID(), permissions: new Set(["nodes:read"]), nodeScope: "all" },
  };
  await routeControlPlaneRequest(context);
  assert.equal(context.response.statusCode, 200);
  assert.deepEqual(required, ["nodes:read"]);
  const payload = JSON.parse(context.response.body);
  assert.equal(NetworkCachePlanResponseSchema.safeParse(payload).success, true);
  assert.equal(payload.nodes[0].nodeName, "alpha");
  assert.equal(payload.nodes[0].status, "ready");
});

test("a cache fill needs the transfer capability, is single attempt and keeps the object out of the task", async () => {
  const repository = new MemoryAgentControlRepository();
  const remoteTasks = new RemoteTaskService(repository);
  const reader = await addNode(repository, { name: "reader" });
  const transfer = await addNode(repository, { name: "transfer", capabilities: ["network.cache.read", "network.transfer"] });
  const input = { type: "network.cache.fetch", parameters: { url: "https://example.com/layer.tgz" }, expiresInSeconds: 900, idempotencyKey: "cache-fill-1" };
  await assert.rejects(() => remoteTasks.create(reader, input, "user:admin", randomUUID()), (error) => error.status === 403 && /能力/.test(error.message));
  const task = await remoteTasks.create(transfer, input, "user:admin", randomUUID());
  assert.equal(task.requiredCapability, "network.transfer");
  assert.equal(task.maxAttempts, 1);
  assert.equal(task.retryable, false);
  assert.deepEqual(task.parameters, { url: "https://example.com/layer.tgz" });
});
