/**
 * M7 item 2 drills on one machine: a node that stops heartbeating, a link that kills 30% of
 * its connections, and a cache volume that cannot hold the object.
 *
 * A real drill runs these on two Linux nodes with a wg0 overlay, `tc netem loss 30%` and a
 * filled volume. This script reproduces the same three failure modes against the production
 * code paths with 127.0.0.1 standing in for the overlay, so the runbook is repeatable before
 * that hardware exists; every check names the part it stands in for.
 *
 * Usage: node scripts/verify-mesh-drills.mjs
 */
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { AGENT_PROTOCOL_VERSION } from "@stackpilot/contracts";
import { fetchThroughCache } from "../apps/agent/dist/cache/fetch.js";
import { ProgressDeadline } from "../apps/agent/dist/cache/progressDeadline.js";
import { ContentCache } from "../apps/agent/dist/cache/store.js";
import { startDataPlaneServer } from "../apps/agent/dist/dataPlane/server.js";
import { EgressService } from "../apps/controller/dist/modules/network/egressService.js";
import { MeshService } from "../apps/controller/dist/modules/network/meshService.js";
import { NodeService } from "../apps/controller/dist/modules/nodes/nodeService.js";
import { RemoteTaskService } from "../apps/controller/dist/modules/remote-tasks/remoteTaskService.js";
import { MemoryAgentControlRepository } from "../apps/controller/dist/repositories/agentControlRepository.js";

const MiB = 1024 ** 2;
const HOST = "origin.example.test";
const OBJECT_URL = `https://${HOST}/asset.bin`;
const CAPABILITIES = ["network.cache.read", "network.transfer"];
const failures = [];
const teardown = [];

const section = (title) => process.stdout.write(`\n== ${title} ==\n`);

function check(name, condition, detail) {
  if (condition) { process.stdout.write(`PASS  ${name}${detail ? `  ${detail}` : ""}\n`); return; }
  failures.push(name);
  process.stdout.write(`FAIL  ${name}${detail ? `  ${detail}` : ""}\n`);
}

/** The other shape of a half-broken link: it answers, then crawls a few KiB at a time. */
async function startCrawlProxy({ host, port, chunkBytes = 8 * 1024, intervalMs = 250 }) {
  const state = { served: 0 };
  const server = createServer((socket) => {
    const upstream = connect({ host, port });
    // The request has to reach the peer; only the response is throttled.
    socket.pipe(upstream);
    const timer = setInterval(() => {
      const chunk = upstream.read(chunkBytes);
      if (chunk === null) return;
      state.served += chunk.length;
      socket.write(chunk);
    }, intervalMs);
    const close = () => { clearInterval(timer); socket.destroy(); upstream.destroy(); };
    socket.on("error", close); upstream.on("error", close); socket.on("close", close); upstream.on("close", close);
  });
  await new Promise((resolve) => { server.listen(0, "127.0.0.1", resolve); });
  teardown.push(() => new Promise((resolve) => { server.close(() => resolve()); }));
  return { port: server.address().port, state };
}

async function drill(title, run) {
  section(title);
  try { await run(); }
  catch (error) {
    failures.push(title);
    process.stdout.write(`FAIL  ${title} threw  ${error?.stack ?? error}\n`);
  }
}

function identity() {
  const pair = generateKeyPairSync("ed25519");
  return {
    nodeId: randomUUID(), credentialId: randomUUID(),
    privateKey: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKey: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

async function openCache(capacityBytes = 64 * MiB, reserveBytes = 1 * MiB) {
  const root = await mkdtemp(join(tmpdir(), "stackpilot-drill-"));
  teardown.push(() => rm(root, { recursive: true, force: true }));
  return { root, cache: await ContentCache.open({ root, capacityBytes, reserveBytes }) };
}

/** `lastSeenMs` is how long ago the node last spoke; its persisted status stays "online". */
async function addNode(repository, { nodeId, nodeName, overlayAddress, port, lastSeenMs }) {
  const seen = new Date(Date.now() - lastSeenMs).toISOString();
  await repository.update((state) => {
    state.nodes.push({
      nodeId, nodeName, status: "online", agentVersion: "0.1.0", protocolVersion: AGENT_PROTOCOL_VERSION,
      platform: "linux", declaredCapabilities: CAPABILITIES, allowedCapabilities: CAPABILITIES,
      enrolledAt: seen, lastSeenAt: seen, revokedAt: null,
      meshAssignment: { overlayAddress, revision: 1 },
      meshIdentity: { interfaceName: "wg0", publicKey: `public-key-${nodeName}`, configuredRevision: 1 },
      meshLink: {
        collectedAt: seen, peerCount: 1, activePeerCount: 1, latestHandshakeAt: seen,
        firewallEnforced: true, dataPlanePort: port, interfaceUp: true,
      },
    });
    state.credentials.push({
      credentialId: randomUUID(), nodeId, publicKey: "-----BEGIN PUBLIC KEY-----\n-----END PUBLIC KEY-----",
      createdAt: seen, revokedAt: null, replacedBy: null, rotationId: null,
    });
  });
}

/** Runs one probe on a node and pushes its result through the Controller's task pipeline. */
async function ingestProbe(remoteTasks, nodeId, sample) {
  const task = await remoteTasks.create(nodeId, {
    type: "network.egress.probe", parameters: { targets: [{ url: OBJECT_URL }] }, expiresInSeconds: 120,
    idempotencyKey: `drill-probe-${nodeId}-${randomUUID()}`,
  }, "controller:drill", randomUUID());
  await remoteTasks.poll(nodeId, randomUUID());
  await remoteTasks.update(nodeId, {
    taskId: task.taskId, attempt: 1, status: "succeeded", timestamp: new Date().toISOString(),
    result: {
      message: "probe",
      data: {
        collectedAt: new Date().toISOString(),
        samples: [{ url: OBJECT_URL, host: HOST, ok: true, statusCode: 200, ttfbMs: sample.ttfbMs, bytesPerSecond: sample.bytesPerSecond, errorCode: null }],
      },
      truncated: false,
    },
  }, randomUUID());
}

/** A fake origin that honours Range, which is what the segmented path needs from the source. */
function rangeOrigin(payload) {
  const state = { requests: 0 };
  const impl = async (_url, init) => {
    state.requests += 1;
    const header = init?.headers?.Range ?? init?.headers?.range ?? null;
    if (header === null) return new Response(payload, { status: 200, headers: { "content-length": String(payload.length) } });
    const match = /^bytes=(\d+)-(\d+)$/.exec(header);
    const start = Number(match[1]); const end = Number(match[2]);
    const slice = Buffer.from(payload.subarray(start, end + 1));
    return new Response(slice, {
      status: 206,
      headers: { "content-range": `bytes ${start}-${end}/${payload.length}`, "content-length": String(slice.length) },
    });
  };
  return { impl, state };
}

/** An origin whose body counts the bytes actually pulled, so a pre-flight refusal is visible. */
function meteredOrigin(payload) {
  const state = { bytes: 0 };
  const impl = async () => {
    let offset = 0;
    const stream = new Readable({
      read() {
        if (offset >= payload.length) { this.push(null); return; }
        const chunk = payload.subarray(offset, offset + 64 * 1024);
        offset += chunk.length;
        state.bytes += chunk.length;
        this.push(chunk);
      },
    });
    return new Response(Readable.toWeb(stream), { status: 200, headers: { "content-length": String(payload.length) } });
  };
  return { impl, state };
}

/**
 * Stands in for `tc netem loss 30%`: TCP hides packet loss behind retransmits, so the shape a
 * caller sees is a connection that never establishes or dies mid-flight. Three connections in
 * ten are destroyed, in a fixed order, so the drill is repeatable.
 */
async function startLossyProxy({ host, port }) {
  const state = { connections: 0, dropped: 0 };
  const server = createServer((socket) => {
    const index = state.connections++;
    if (index % 10 < 3) { state.dropped += 1; socket.destroy(); return; }
    const upstream = connect({ host, port });
    socket.pipe(upstream); upstream.pipe(socket);
    const close = () => { socket.destroy(); upstream.destroy(); };
    socket.on("error", close); upstream.on("error", close);
  });
  await new Promise((resolve) => { server.listen(0, "127.0.0.1", resolve); });
  teardown.push(() => new Promise((resolve) => { server.close(() => resolve()); }));
  return {
    port: server.address().port, state,
    reset() { state.connections = 0; state.dropped = 0; },
  };
}

await drill("Drill 1  a node stops heartbeating but its stored status still says online", async () => {
  const repository = new MemoryAgentControlRepository();
  const remoteTasks = new RemoteTaskService(repository);
  const receiver = identity();
  const silent = identity();
  await addNode(repository, { nodeId: receiver.nodeId, nodeName: "receiver", overlayAddress: "100.64.0.2", port: 18080, lastSeenMs: 0 });
  await addNode(repository, { nodeId: silent.nodeId, nodeName: "silent", overlayAddress: "100.64.0.3", port: 18081, lastSeenMs: 90_000 });
  // The silent node measured the best link before it died, so a selector that trusts the
  // stored status alone would still prefer a peer that cannot answer.
  await ingestProbe(remoteTasks, receiver.nodeId, { ttfbMs: 400, bytesPerSecond: 2 * MiB });
  await ingestProbe(remoteTasks, silent.nodeId, { ttfbMs: 20, bytesPerSecond: 20 * MiB });

  const listed = await new NodeService(repository).list();
  check("the node list reports the silent node offline",
    listed.find((node) => node.nodeId === silent.nodeId)?.status === "offline");

  const egress = new EgressService(repository, remoteTasks, { targets: [OBJECT_URL] });
  await egress.collect();
  const plan = await egress.plan();
  check("the egress plan warns the silent node is offline",
    plan.warnings.some((warning) => warning.includes("silent") && warning.includes("离线")),
    plan.warnings.join(" | ") || "(no warnings)");

  const selection = await egress.select(HOST, receiver.nodeId);
  check("routing never picks the silent node", selection.nodeId !== silent.nodeId,
    `reason=${selection.reason} node=${selection.nodeName ?? "-"}`);

  const access = { permissions: new Set(["tasks:create"]), nodeScope: "all" };
  const segmented = await egress.download(
    { nodeId: receiver.nodeId, url: OBJECT_URL, segments: { maxNodes: 2 } },
    "user:drill", randomUUID(), access, () => undefined,
  );
  const sources = segmented.segments?.sources ?? [];
  check("a segment plan never names the silent node",
    sources.every((source) => source.nodeId !== silent.nodeId), `sources=${sources.length}`);

  const before = (await repository.read({ sections: ["tasks"] })).tasks.length;
  await new EgressService(repository, remoteTasks, { targets: [OBJECT_URL] }).probe();
  const queued = (await repository.read({ sections: ["tasks"] })).tasks
    .slice(before).filter((task) => task.type === "network.egress.probe");
  check("no probe is queued for the silent node",
    queued.every((task) => task.targetNodeId !== silent.nodeId),
    `targets=${queued.map((task) => task.targetNodeId === silent.nodeId ? "silent" : "receiver").join(",") || "none"}`);

  const meshPlan = await new MeshService(repository, remoteTasks).plan();
  check("the mesh plan warns the silent node is offline",
    meshPlan.warnings.some((warning) => warning.includes("silent") && warning.includes("当前离线")),
    meshPlan.warnings.join(" | ") || "(no warnings)");
});

await drill("Drill 2  the link kills 30% of connections", async () => {
  const payload = randomBytes(8 * MiB);
  const digest = createHash("sha256").update(payload).digest("hex");
  const receiver = identity();
  const healthy = identity();
  const lossy = identity();
  const origin = rangeOrigin(payload);
  const seed = async (cache) => {
    const path = cache.reservePath();
    await writeFile(path, payload);
    await cache.commit(path, { digest, url: OBJECT_URL, sizeBytes: payload.length });
  };
  const healthyCache = await openCache();
  const lossyCache = await openCache();
  await seed(healthyCache.cache);
  await seed(lossyCache.cache);

  const resolvePublicKey = (nodeId) => (nodeId === receiver.nodeId ? receiver.publicKey : null);
  const startPeer = (nodeId, cache) => startDataPlaneServer({
    nodeId, cache, resolvePublicKey, address: "127.0.0.1", port: 0, allowNonOverlayAddress: true, fetchImpl: origin.impl,
  });
  const healthyServer = await startPeer(healthy.nodeId, healthyCache.cache);
  const lossyServer = await startPeer(lossy.nodeId, lossyCache.cache);
  teardown.push(() => healthyServer.close());
  teardown.push(() => lossyServer.close());
  const proxy = await startLossyProxy({ host: "127.0.0.1", port: lossyServer.port });
  const peerEgress = (nodeId) => nodeId === lossy.nodeId ? { overlayAddress: "127.0.0.1", port: proxy.port }
    : nodeId === healthy.nodeId ? { overlayAddress: "127.0.0.1", port: healthyServer.port }
      : null;

  proxy.reset();
  const wholeCache = await openCache();
  const startedAt = Date.now();
  const filled = await fetchThroughCache(
    { url: OBJECT_URL, digest, egress: { nodeId: lossy.nodeId, overlayAddress: "127.0.0.1", port: proxy.port } },
    { cache: wholeCache.cache, identity: receiver, peerEgress, fetchImpl: origin.impl },
  );
  check("a dropped peer connection degrades to the origin",
    filled.viaEgress === false && filled.digest === digest,
    `reason=${filled.egressFallbackReason ?? "-"} dropped=${proxy.state.dropped} elapsed=${Date.now() - startedAt}ms`);
  check("the degraded fill still lands in the cache",
    filled.sizeBytes === payload.length && (await wholeCache.cache.lookup(digest)) !== null);

  proxy.reset();
  const segmentedCache = await openCache();
  const segmented = await fetchThroughCache(
    { url: OBJECT_URL, digest, segments: { sources: [{ nodeId: lossy.nodeId, overlayAddress: "127.0.0.1", port: proxy.port }] } },
    { cache: segmentedCache.cache, identity: receiver, peerEgress, fetchImpl: origin.impl },
  );
  check("a segmented pull over a dying link falls back to the origin",
    segmented.viaEgress === false && segmented.digest === digest
      && segmented.segmentsFallbackReason === "CACHE_SEGMENT_PART_FAILED",
    `reason=${segmented.segmentsFallbackReason ?? "-"} dropped=${proxy.state.dropped}`);

  // A crawl keeps bytes trickling, so the 30 s socket-idle timeout never fires and the fill
  // stays open with no deadline of its own: cancelling is the operator's only exit.
  const crawlProxy = await startCrawlProxy({ host: "127.0.0.1", port: lossyServer.port });
  const crawlCache = await openCache();
  const controller = new AbortController();
  const crawlTarget = { nodeId: lossy.nodeId, overlayAddress: "127.0.0.1", port: crawlProxy.port };
  const pending = fetchThroughCache(
    { url: OBJECT_URL, digest, egress: crawlTarget },
    { cache: crawlCache.cache, identity: receiver, peerEgress: () => crawlTarget, fetchImpl: origin.impl, signal: controller.signal },
  ).then(() => ({ settled: "fulfilled" }), (error) => ({ settled: "rejected", error }));
  await new Promise((resolve) => { setTimeout(resolve, 3_000); });
  const during = await Promise.race([pending, new Promise((resolve) => { setTimeout(() => resolve({ settled: "pending" }), 20); })]);
  check("a crawling peer keeps the fill open rather than failing it", during.settled === "pending",
    `served=${crawlProxy.state.served}B in 3s`);
  controller.abort();
  const after = await Promise.race([pending, new Promise((resolve) => { setTimeout(() => resolve({ settled: "hung" }), 5_000); })]);
  const staged = await readdir(join(crawlCache.root, "tmp"));
  check("cancelling a crawling fill stops it and stages nothing",
    after.settled === "rejected" && ["CACHE_FETCH_CANCELLED", "EGRESS_ABORTED"].includes(after.error.code) && staged.length === 0,
    `settled=${after.settled} code=${after.error?.code ?? "-"} tmp=${staged.join(",") || "empty"}`);

  // The same crawl under a progress deadline: the floor is a rate, so a peer that only trickles is
  // judged dead on its own instead of pinning the fill until an operator notices and cancels.
  const deadlineCache = await openCache();
  const deadline = new ProgressDeadline({ windowMs: 1_000, minBytesPerSecond: 100 * 1024 });
  const deadlineStarted = Date.now();
  let deadlineError = null;
  try {
    await fetchThroughCache(
      { url: OBJECT_URL, digest, egress: crawlTarget },
      { cache: deadlineCache.cache, identity: receiver, peerEgress: () => crawlTarget, fetchImpl: origin.impl, deadline },
    );
  } catch (error) { deadlineError = error; } finally { deadline.stop(); }
  const deadlineStaged = await readdir(join(deadlineCache.root, "tmp"));
  check("a crawling fill is ended by the progress deadline instead of waiting for a cancel",
    deadlineError?.code === "CACHE_TRANSFER_STALLED" && deadlineStaged.length === 0,
    `code=${deadlineError?.code ?? "-"} elapsed=${Date.now() - deadlineStarted}ms tmp=${deadlineStaged.join(",") || "empty"}`);

  // The same loss shows up in the quality table, which is what keeps it out of the next plan.
  const repository = new MemoryAgentControlRepository();
  const remoteTasks = new RemoteTaskService(repository);
  await addNode(repository, { nodeId: receiver.nodeId, nodeName: "receiver", overlayAddress: "100.64.0.2", port: 18080, lastSeenMs: 0 });
  await addNode(repository, { nodeId: healthy.nodeId, nodeName: "healthy", overlayAddress: "100.64.0.4", port: healthyServer.port, lastSeenMs: 0 });
  await addNode(repository, { nodeId: lossy.nodeId, nodeName: "lossy", overlayAddress: "100.64.0.5", port: proxy.port, lastSeenMs: 0 });
  await ingestProbe(remoteTasks, healthy.nodeId, { ttfbMs: 30, bytesPerSecond: 10 * MiB });
  await ingestProbe(remoteTasks, lossy.nodeId, { ttfbMs: 1_200, bytesPerSecond: 200 * 1024 });
  const egress = new EgressService(repository, remoteTasks, { targets: [OBJECT_URL] });
  await egress.collect();
  const selection = await egress.select(HOST, receiver.nodeId);
  check("routing prefers the measured link over the lossy one",
    selection.nodeName === "healthy", `chosen=${selection.nodeName ?? "-"} score=${selection.score ?? "-"}`);
});

await drill("Drill 3  the cache volume cannot hold the object", async () => {
  const payload = randomBytes(8 * MiB);
  const digest = createHash("sha256").update(payload).digest("hex");
  const metered = meteredOrigin(payload);
  const { root, cache } = await openCache(4 * MiB, 1 * MiB);
  const startedAt = Date.now();
  let failure = null;
  try {
    await fetchThroughCache({ url: OBJECT_URL, digest }, { cache, identity: identity(), fetchImpl: metered.impl });
  } catch (error) { failure = error; }
  check("a full cache fails the fill with a coded error", failure?.code === "CACHE_DISK_LOW",
    `code=${failure?.code ?? "none"} elapsed=${Date.now() - startedAt}ms`);
  check("the refusal happens before the transfer starts", metered.state.bytes === 0,
    `originBytesRead=${metered.state.bytes}`);
  const leftovers = await readdir(join(root, "tmp"));
  check("no part file is left behind", leftovers.length === 0, `tmp=${leftovers.join(",") || "empty"}`);

  const small = randomBytes(MiB);
  const smallOrigin = meteredOrigin(small);
  const after = await fetchThroughCache(
    { url: `https://${HOST}/small.bin` },
    { cache, identity: identity(), fetchImpl: smallOrigin.impl },
  );
  check("the cache still accepts a smaller object afterwards", after.sizeBytes === small.length);

  // The other way a volume runs out: the free space is below the reserve, not the budget.
  const reserved = await openCache(64 * MiB, 1024 ** 4);
  const reservedOrigin = meteredOrigin(small);
  let reservedFailure = null;
  try {
    await fetchThroughCache({ url: `https://${HOST}/small.bin` }, { cache: reserved.cache, identity: identity(), fetchImpl: reservedOrigin.impl });
  } catch (error) { reservedFailure = error; }
  check("a volume below its reserve refuses the same way", reservedFailure?.code === "CACHE_DISK_LOW"
    && reservedOrigin.state.bytes < small.length,
    `code=${reservedFailure?.code ?? "none"} originBytesRead=${reservedOrigin.state.bytes}/${small.length}`);
});

for (const cleanup of teardown.reverse()) {
  try { await cleanup(); } catch { /* drill teardown is best effort */ }
}
process.stdout.write(failures.length === 0
  ? "\nALL DRILL CHECKS PASSED\n"
  : `\n${failures.length} DRILL CHECK(S) FAILED: ${failures.join(", ")}\n`);
process.exitCode = failures.length === 0 ? 0 : 1;
