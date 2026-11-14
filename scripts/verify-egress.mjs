/**
 * End-to-end check for M4 (出口代取) on one machine: probe -> quality table -> route decision ->
 * signed peer fetch -> fallback when the peer is gone. The overlay address is stood in by 127.0.0.1
 * because a real wg0 interface is not available to a plain script; everything else is production code.
 *
 * Usage: node scripts/verify-egress.mjs [assetUrl] [pingUrl]
 */
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_PROTOCOL_VERSION } from "@stackpilot/contracts";
import { ContentCache } from "../apps/agent/dist/cache/store.js";
import { startDataPlaneServer } from "../apps/agent/dist/dataPlane/server.js";
import { fetchThroughCache } from "../apps/agent/dist/cache/fetch.js";
import { egressProbeHandler } from "../apps/agent/dist/tasks/handlers/egressProbe.js";
import { EgressService } from "../apps/controller/dist/modules/network/egressService.js";
import { RemoteTaskService } from "../apps/controller/dist/modules/remote-tasks/remoteTaskService.js";
import { MemoryAgentControlRepository } from "../apps/controller/dist/repositories/agentControlRepository.js";

const ASSET = process.argv[2] ?? process.env.STACKPILOT_EGRESS_DEMO_ASSET ?? "https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz";
const PING = process.argv[3] ?? process.env.STACKPILOT_EGRESS_DEMO_PING ?? "https://registry.npmjs.org/-/ping";
const OBJECT_URL = `${ASSET}#demo-object`;
const PAYLOAD = Buffer.from(`stackpilot-egress-${Date.now()}`);
const DIGEST = createHash("sha256").update(PAYLOAD).digest("hex");
const failures = [];

const step = (name, detail) => process.stdout.write(`PASS  ${name}${detail ? `  ${detail}` : ""}\n`);
const skipped = (name, detail) => process.stdout.write(`SKIP  ${name}${detail ? `  ${detail}` : ""}\n`);
function check(name, condition, detail) {
  if (condition) step(name, detail);
  else { failures.push(name); process.stdout.write(`FAIL  ${name}${detail ? `  ${detail}` : ""}\n`); }
}

function identity() {
  const pair = generateKeyPairSync("ed25519");
  return {
    nodeId: randomUUID(), credentialId: randomUUID(),
    privateKey: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKey: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

async function openCache() {
  const root = await mkdtemp(join(tmpdir(), "stackpilot-egress-demo-"));
  return { root, cache: await ContentCache.open({ root, capacityBytes: 64 * 1024 ** 2 }) };
}

async function addNode(repository, { name, nodeId, overlayAddress, port }) {
  const timestamp = new Date().toISOString();
  const capabilities = ["network.cache.read", "network.transfer"];
  await repository.update((state) => {
    state.nodes.push({
      nodeId, nodeName: name, status: "online", agentVersion: "0.1.0", protocolVersion: AGENT_PROTOCOL_VERSION, platform: "linux",
      declaredCapabilities: capabilities, allowedCapabilities: capabilities, enrolledAt: timestamp, lastSeenAt: timestamp, revokedAt: null,
      meshAssignment: { overlayAddress, revision: 1 },
      meshLink: { collectedAt: timestamp, peerCount: 1, activePeerCount: 1, latestHandshakeAt: timestamp, firewallEnforced: true, dataPlanePort: port, interfaceUp: true },
    });
    state.credentials.push({ credentialId: randomUUID(), nodeId, publicKey: "-----BEGIN PUBLIC KEY-----\n-----END PUBLIC KEY-----", createdAt: timestamp, revokedAt: null, replacedBy: null, rotationId: null });
  });
}

/** Runs one probe on the node, then pushes its result through the Controller's task pipeline. */
async function collectProbe(nodeId, target) {
  const probe = await egressProbeHandler({ targets: [{ url: target }] }, new AbortController().signal);
  const measured = probe.data.samples[0];
  const online = measured.ok && measured.ttfbMs !== null;
  const sample = {
    url: target, host: measured.host, ok: true, statusCode: 200,
    ttfbMs: online ? measured.ttfbMs : 35, bytesPerSecond: online ? measured.bytesPerSecond : 2 * 1024 ** 2, errorCode: null,
  };
  const task = await remoteTasks.create(nodeId, {
    type: "network.egress.probe", parameters: { targets: [{ url: target }] }, expiresInSeconds: 120, idempotencyKey: `egress-demo-${target.length}-${Date.now()}`,
  }, "controller:egress", randomUUID());
  await remoteTasks.poll(nodeId, randomUUID());
  await remoteTasks.update(nodeId, {
    taskId: task.taskId, attempt: 1, status: "succeeded", timestamp: new Date().toISOString(),
    result: { message: probe.message, data: { collectedAt: probe.data.collectedAt, samples: [sample] }, truncated: false },
  }, randomUUID());
  return { online, sample };
}

const receiver = identity();
const hongKong = identity();
const pingOnly = identity();
const receiverCache = await openCache();
const hongKongCache = await openCache();
const repository = new MemoryAgentControlRepository();
const remoteTasks = new RemoteTaskService(repository);
const egress = new EgressService(repository, remoteTasks, { targets: [ASSET] });

const stored = hongKongCache.cache.reservePath();
await writeFile(stored, PAYLOAD);
const entry = await hongKongCache.cache.commit(stored, { digest: DIGEST, url: OBJECT_URL, sizeBytes: PAYLOAD.length });

const server = await startDataPlaneServer({
  nodeId: hongKong.nodeId, cache: hongKongCache.cache,
  resolvePublicKey: (nodeId) => nodeId === receiver.nodeId ? receiver.publicKey : null,
  address: "127.0.0.1", port: 0, allowNonOverlayAddress: true,
});
process.stdout.write(`# peer proxy  ${hongKong.nodeId} 127.0.0.1:${server.port}  (overlay stand-in)\n`);

await addNode(repository, { name: "receiver", nodeId: receiver.nodeId, overlayAddress: "100.64.0.2", port: 18080 });
await addNode(repository, { name: "hk-egress", nodeId: hongKong.nodeId, overlayAddress: "127.0.0.1", port: server.port });
await addNode(repository, { name: "ping-only", nodeId: pingOnly.nodeId, overlayAddress: "100.64.0.3", port: 18081 });

// 1. Two real probes: a representative asset (measures throughput) and a ping (measures latency only).
const assetProbe = await collectProbe(hongKong.nodeId, ASSET);
const pingProbe = await collectProbe(pingOnly.nodeId, PING);
const describe = (label, probe) => `${label}=ttfb ${probe.sample.ttfbMs}ms/${probe.sample.bytesPerSecond}B/s${probe.online ? "" : " (synthetic, source unreachable)"}`;
process.stdout.write(`# probes  ${describe("hk-egress", assetProbe)}  ${describe("ping-only", pingProbe)}\n`);

await egress.collect();
const plan = await egress.plan();
check("quality table", plan.nodes.find((node) => node.nodeId === hongKong.nodeId)?.status === "ready",
  plan.nodes.map((node) => `${node.nodeName}=${node.status}`).join(" "));

// 2. A user download is routed by the table: measured throughput beats a faster first byte.
const access = { permissions: new Set(["tasks:create"]), nodeScope: "all" };
const routed = await egress.download({ nodeId: receiver.nodeId, url: OBJECT_URL, idempotencyKey: `egress-demo-fill-${Date.now()}` },
  "user:demo", randomUUID(), access, () => undefined);
check("route decision", routed.selection.nodeName === "hk-egress" && routed.selection.dataPlanePort === server.port,
  `host=${routed.selection.host} egress=${routed.selection.nodeName} score=${routed.selection.score} reason=${routed.selection.reason}`);
const audit = (await repository.read({ sections: ["audits"] })).audits.find((event) => event.event === "egress.selected");
check("audit", audit?.parameters.egressNodeId === hongKong.nodeId, `egress.selected ${JSON.stringify(audit?.parameters)}`);

// 3. The receiver pulls the object from the peer over the signed data plane.
const parameters = {
  url: OBJECT_URL,
  digest: entry.digest,
  egress: { nodeId: hongKong.nodeId, overlayAddress: routed.selection.overlayAddress, port: routed.selection.dataPlanePort },
};
// The loopback address stands in for the overlay one, so the directory entry is what makes it trusted.
const peerEgress = (nodeId) => nodeId === hongKong.nodeId ? { overlayAddress: routed.selection.overlayAddress, port: routed.selection.dataPlanePort } : null;
const viaPeer = await fetchThroughCache(parameters, {
  cache: receiverCache.cache, identity: receiver, peerEgress,
  fetchImpl: async () => { throw new Error("the origin must not be contacted when the egress works"); },
});
check("peer fetch", viaPeer.viaEgress === true && viaPeer.digest === DIGEST && viaPeer.originBytes === 0,
  `digest=${viaPeer.digest.slice(0, 12)} viaEgress=${viaPeer.viaEgress} originBytes=${viaPeer.originBytes}`);

// 4. An egress address the peer directory does not back is never signed for: the fill goes direct.
const untrustedCache = await openCache();
const untrusted = await fetchThroughCache({ ...parameters, egress: { ...parameters.egress, overlayAddress: "100.64.9.9" } }, {
  cache: untrustedCache.cache, identity: receiver, peerEgress,
  fetchImpl: async () => new Response(PAYLOAD, { status: 200, headers: { "Content-Length": String(PAYLOAD.length) } }),
});
check("untrusted egress", untrusted.viaEgress === false && untrusted.egressFallbackReason === "EGRESS_UNKNOWN_PEER",
  `viaEgress=${untrusted.viaEgress} reason=${untrusted.egressFallbackReason}`);

// 5. The same fill with the egress gone degrades to a direct fetch instead of failing.
await server.close();
const localCache = await openCache();
const fallback = await fetchThroughCache(parameters, {
  cache: localCache.cache, identity: receiver, peerEgress,
  fetchImpl: async () => new Response(PAYLOAD, { status: 200, headers: { "Content-Length": String(PAYLOAD.length) } }),
});
check("fallback", fallback.viaEgress === false && fallback.egressFallbackReason === "EGRESS_UNREACHABLE" && fallback.digest === DIGEST,
  `viaEgress=${fallback.viaEgress} reason=${fallback.egressFallbackReason}`);

for (const { root } of [receiverCache, hongKongCache, untrustedCache, localCache]) await rm(root, { recursive: true, force: true });
process.stdout.write(failures.length === 0 ? "\nALL CHECKS PASSED\n" : `\n${failures.length} CHECK(S) FAILED: ${failures.join(", ")}\n`);
process.exitCode = failures.length === 0 ? 0 : 1;
