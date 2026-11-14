import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, open as openFile, readdir, rm, utimes } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { NETWORK_SEGMENT_BLIND_TTL_MS, NETWORK_SEGMENT_STAGING_TTL_MS, NetworkCacheFetchResultSchema } from "@stackpilot/contracts";
import { fetchThroughCache } from "../../apps/agent/dist/cache/fetch.js";
import { probeRangeSupport } from "../../apps/agent/dist/cache/origin.js";
import { fetchSegmented, planSegments } from "../../apps/agent/dist/cache/segmented.js";
import { SegmentStaging, lockStagingFill, stagingKey } from "../../apps/agent/dist/cache/staging.js";
import { ContentCache } from "../../apps/agent/dist/cache/store.js";
import { signDataPlaneRequest } from "../../apps/agent/dist/dataPlane/auth.js";
import { openPeerRange } from "../../apps/agent/dist/dataPlane/client.js";
import { startDataPlaneServer } from "../../apps/agent/dist/dataPlane/server.js";
import { cacheFetchHandler, describeFill } from "../../apps/agent/dist/tasks/handlers/cacheFetch.js";
import { taskRegistry } from "../../apps/agent/dist/tasks/registry.js";

const MiB = 1024 ** 2;
const digestOf = (payload) => createHash("sha256").update(payload).digest("hex");

function identity() {
  const pair = generateKeyPairSync("ed25519");
  return {
    nodeId: randomUUID(), credentialId: randomUUID(),
    privateKey: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKey: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

async function withCache(run) {
  const root = await mkdtemp(join(tmpdir(), "stackpilot-segments-"));
  try {
    return await run(root, await ContentCache.open({ root, capacityBytes: 64 * MiB, reserveBytes: MiB }));
  } finally { await rm(root, { recursive: true, force: true }); }
}

const rangeHeader = (init) => init?.headers?.Range ?? init?.headers?.range ?? null;

/** A fake origin that honours Range and counts what it was asked for. */
function origin(payload, options = {}) {
  const state = { requests: 0, ranges: [], failTimes: options.failTimes ?? 0 };
  const impl = async (_url, init) => {
    state.requests += 1;
    if (state.requests <= state.failTimes) return new Response("upstream refused", { status: 500 });
    const header = rangeHeader(init);
    if (header === null) return new Response(payload, { status: 200, headers: { "content-length": String(payload.length) } });
    const match = /^bytes=(\d+)-(\d+)$/.exec(header);
    const start = Number(match[1]); const end = Number(match[2]);
    state.ranges.push([start, end]);
    const slice = Buffer.from(payload.subarray(start, end + 1));
    if (options.corrupt) slice[0] = slice[0] ^ 0xff;
    return new Response(slice, {
      status: 206,
      headers: { "content-range": `bytes ${start}-${end}/${payload.length}`, "content-length": String(slice.length) },
    });
  };
  return { impl, state };
}

/** An origin that ignores Range, which is what makes a segmented pull impossible. */
const wholeOrigin = (payload) => async () => new Response(payload, { status: 200, headers: { "content-length": String(payload.length) } });

async function peer(caller, nodeId, fetchImpl) {
  return startDataPlaneServer({
    nodeId, cache: await ContentCache.open({ root: await mkdtemp(join(tmpdir(), "stackpilot-peer-")), capacityBytes: 8 * MiB, reserveBytes: MiB }),
    resolvePublicKey: (id) => id === caller.nodeId ? caller.publicKey : null,
    address: "127.0.0.1", port: 0, allowNonOverlayAddress: true, fetchImpl,
  });
}

function post(port, path, body, headers = {}) {
  const raw = Buffer.from(JSON.stringify(body), "utf8");
  return new Promise((resolve, reject) => {
    const req = request({
      host: "127.0.0.1", port, path, method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": String(raw.length), ...headers },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end(raw);
  });
}

test("a segment plan covers the object exactly and never cuts a part below the floor", () => {
  const sources = Array.from({ length: 3 }, () => ({ nodeId: randomUUID(), overlayAddress: "100.64.0.10", port: 18080 }));
  const plan = planSegments(30 * MiB, sources);
  assert.equal(plan.length, 3);
  assert.deepEqual(plan.map((part) => [part.start, part.end]), [[0, 10 * MiB - 1], [10 * MiB, 20 * MiB - 1], [20 * MiB, 30 * MiB - 1]]);
  assert.deepEqual(plan.map((part) => part.source.nodeId), sources.map((source) => source.nodeId));

  // A remainder lands on the last part, so nothing is dropped and nothing overlaps.
  const ragged = planSegments(10 * MiB + 7, sources);
  assert.equal(ragged.at(-1).end, 10 * MiB + 6);
  assert.equal(ragged.reduce((sum, part) => sum + (part.end - part.start + 1), 0), 10 * MiB + 7);

  // Below the object floor, below the part floor, or without peers there is nothing to split.
  assert.deepEqual(planSegments(4 * MiB, sources), []);
  assert.deepEqual(planSegments(30 * MiB, []), []);
  const many = Array.from({ length: 8 }, () => ({ nodeId: randomUUID(), overlayAddress: "100.64.0.10", port: 18080 }));
  assert.equal(planSegments(10 * MiB, many).length, 5);
});

test("the fill task accepts a segment plan only with overlay addresses", () => {
  const definition = taskRegistry["network.cache.fetch"];
  const source = { nodeId: randomUUID(), overlayAddress: "100.64.0.10", port: 18080 };
  assert.doesNotThrow(() => definition.validate({ url: "https://example.com/a.bin", segments: { sources: [source] } }));
  for (const parameters of [
    { url: "https://example.com/a.bin", segments: { sources: [] } },
    { url: "https://example.com/a.bin", segments: { sources: [{ ...source, overlayAddress: "127.0.0.1" }] } },
    { url: "https://example.com/a.bin", segments: { sources: [{ ...source, port: 0 }] } },
    { url: "https://example.com/a.bin", segments: { sources: [source], parts: 4 } },
  ]) assert.throws(() => definition.validate(parameters), JSON.stringify(parameters));
});

test("a range probe distinguishes a 206 with a total from an origin that ignores the header", async () => {
  const payload = Buffer.alloc(64 * 1024, 7);
  const ranged = await probeRangeSupport("https://example.com/a.bin", { fetchImpl: origin(payload).impl });
  assert.deepEqual(ranged, { supported: true, totalBytes: payload.length, etag: null });
  const whole = await probeRangeSupport("https://example.com/a.bin", { fetchImpl: wholeOrigin(payload) });
  assert.equal(whole.supported, false);
  assert.equal(whole.totalBytes, payload.length);
});

test("the data plane serves one signed range and refuses an unsigned caller", async () => {
  const caller = identity(); const payload = Buffer.from(Array.from({ length: 4096 }, (_, index) => index % 251));
  const { impl, state } = origin(payload);
  const server = await peer(caller, randomUUID(), impl);
  try {
    const response = await openPeerRange({
      source: { nodeId: caller.nodeId, overlayAddress: "127.0.0.1", port: server.port },
      parameters: { url: "https://example.com/a.bin", start: 100, end: 1123 }, identity: caller,
    });
    const chunks = []; for await (const chunk of response.stream) chunks.push(chunk);
    assert.equal(Buffer.concat(chunks).equals(payload.subarray(100, 1124)), true);
    assert.equal(response.bytes, 1024);
    assert.equal(response.totalBytes, payload.length);
    assert.deepEqual(state.ranges.at(-1), [100, 1123]);

    const unsigned = await post(server.port, "/v1/range", { url: "https://example.com/a.bin", start: 0, end: 9 });
    assert.equal(unsigned.status, 401);
    assert.equal(JSON.parse(unsigned.body.toString("utf8")).code, "DATA_PLANE_AUTH_MISSING");

    const invalidBody = { url: "https://example.com/a.bin", start: 10, end: 1 };
    const signed = signDataPlaneRequest(caller, "POST", "/v1/range", Buffer.from(JSON.stringify(invalidBody), "utf8"));
    const invalid = await post(server.port, "/v1/range", invalidBody, signed.headers);
    assert.equal(invalid.status, 400);
  } finally { await server.close(); }
});

test("a peer refuses a range the origin will not serve", async () => {
  const caller = identity();
  const server = await peer(caller, randomUUID(), wholeOrigin(Buffer.alloc(2048)));
  try {
    await assert.rejects(() => openPeerRange({
      source: { nodeId: caller.nodeId, overlayAddress: "127.0.0.1", port: server.port },
      parameters: { url: "https://example.com/a.bin", start: 0, end: 1023 }, identity: caller,
    }), (error) => error.code === "CACHE_RANGE_UNSUPPORTED");
  } finally { await server.close(); }
});

test("a segmented fill pulls one part per peer and commits the assembled object", async () => {
  const payload = Buffer.alloc(8 * MiB + 4096, 3);
  const expected = digestOf(payload);
  const caller = identity();
  const local = origin(payload);
  const first = origin(payload); const second = origin(payload);
  const a = await peer(caller, randomUUID(), first.impl);
  const b = await peer(caller, randomUUID(), second.impl);
  const nodeA = randomUUID(); const nodeB = randomUUID();
  try {
    await withCache(async (_root, cache) => {
      const result = await fetchThroughCache({
        url: "https://example.com/a.bin",
        segments: { sources: [
          { nodeId: nodeA, overlayAddress: "127.0.0.1", port: a.port },
          { nodeId: nodeB, overlayAddress: "127.0.0.1", port: b.port },
        ] },
      }, {
        cache, identity: caller, fetchImpl: local.impl,
        peerEgress: (nodeId) => nodeId === nodeA ? { overlayAddress: "127.0.0.1", port: a.port } : nodeId === nodeB ? { overlayAddress: "127.0.0.1", port: b.port } : null,
      });
      assert.equal(NetworkCacheFetchResultSchema.safeParse(result).success, true);
      assert.equal(result.digest, expected);
      assert.equal(result.sizeBytes, payload.length);
      assert.equal(result.segmented, true);
      assert.equal(result.segmentCount, 2);
      assert.deepEqual(result.segmentSources, [nodeA, nodeB]);
      assert.equal(result.originBytes, 0, "the receiving node pulled nothing from the origin itself");
      assert.equal(result.viaEgress, true);
      assert.equal(result.resumedBytes, 0);
      // Each part is attributed to the peer that carried it, and the parts add up to the object.
      assert.deepEqual(result.parts.map((part) => part.sourceNodeId), [nodeA, nodeB]);
      assert.deepEqual(result.parts.map((part) => part.index), [0, 1]);
      assert.deepEqual(result.parts.map((part) => part.resumed), [false, false]);
      assert.equal(result.parts.reduce((total, part) => total + part.bytes, 0), payload.length);
      // The receiver probes the origin itself, then each peer serves exactly one part.
      assert.deepEqual(local.state.ranges, [[0, 0]]);
      assert.equal(first.state.ranges.length, 1);
      assert.equal(second.state.ranges.length, 1);
      assert.equal((await cache.lookup(expected)).sizeBytes, payload.length);
    });
  } finally { await a.close(); await b.close(); }
});

test("a resume record that cannot be written never costs a transferred part", async () => {
  const payload = Buffer.alloc(8 * MiB, 7);
  const expected = digestOf(payload);
  const url = "https://example.com/state-less.bin";
  const caller = identity();
  const local = origin(payload);
  const first = origin(payload); const second = origin(payload);
  const a = await peer(caller, randomUUID(), first.impl);
  const b = await peer(caller, randomUUID(), second.impl);
  const nodeA = randomUUID(); const nodeB = randomUUID();
  try {
    await withCache(async (root, cache) => {
      // A directory where state.json belongs: the atomic rename cannot land, whatever the platform.
      await mkdir(join(root, "staging", stagingKey(url, payload.length), "state.json"), { recursive: true });
      const result = await fetchThroughCache({
        url,
        // A digest is what keeps this fill on the shared staging directory, where the blocked record sits.
        digest: expected,
        segments: { sources: [
          { nodeId: nodeA, overlayAddress: "127.0.0.1", port: a.port },
          { nodeId: nodeB, overlayAddress: "127.0.0.1", port: b.port },
        ] },
      }, {
        cache, identity: caller, fetchImpl: local.impl,
        peerEgress: (nodeId) => nodeId === nodeA ? { overlayAddress: "127.0.0.1", port: a.port } : nodeId === nodeB ? { overlayAddress: "127.0.0.1", port: b.port } : null,
      });
      // The bytes are the deliverable and the digest is the integrity proof; the resume record is a hint.
      assert.equal(result.segmented, true);
      assert.equal(result.digest, expected);
      assert.equal(first.state.ranges.length, 1);
      assert.equal(second.state.ranges.length, 1);
      assert.equal((await cache.lookup(expected)).sizeBytes, payload.length);
      // The planted directory is gone, so the fill really did run in the staging key it blocked.
      assert.deepEqual(await readdir(join(root, "staging")), []);
    });
  } finally { await a.close(); await b.close(); }
});

test("a part that lands after the resume record became unwritable is still kept", async () => {
  const root = await mkdtemp(join(tmpdir(), "stackpilot-staging-"));
  const url = "https://example.com/hint.bin";
  const totalBytes = 4 * MiB;
  const parts = [{ index: 0, start: 0, end: 2 * MiB - 1 }, { index: 1, start: 2 * MiB, end: totalBytes - 1 }];
  try {
    const staging = await SegmentStaging.open({ root, url, totalBytes, etag: null, parts });
    await staging.writePart(parts[0], Readable.from([Buffer.alloc(2 * MiB, 1)]));
    // The record was healthy until now; a directory in its place makes every later save fail.
    const directory = join(root, stagingKey(url, totalBytes));
    await rm(join(directory, "state.json"), { force: true });
    await mkdir(join(directory, "state.json"), { recursive: true });
    // This is the save that used to throw past writePart and cost the part; the bytes stay.
    await staging.writePart(parts[1], Readable.from([Buffer.alloc(2 * MiB, 1)]));
    assert.deepEqual([...staging.completed], [0, 1]);
    assert.equal((await staging.digest()).length, 64);
    await staging.discard();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a fill that cannot resume stages beside the resumable one instead of over it", async () => {
  const root = await mkdtemp(join(tmpdir(), "stackpilot-staging-"));
  const url = "https://example.com/shared.bin";
  const totalBytes = 4 * MiB;
  const parts = [{ index: 0, start: 0, end: 2 * MiB - 1 }, { index: 1, start: 2 * MiB, end: totalBytes - 1 }];
  const kept = Buffer.alloc(2 * MiB, 0x2a);
  const readFirstPart = async (path) => {
    const handle = await openFile(path, "r");
    try {
      const slice = Buffer.alloc(kept.length);
      await handle.read(slice, 0, slice.length, parts[0].start);
      return slice;
    } finally { await handle.close(); }
  };
  try {
    const resumable = await SegmentStaging.open({ root, url, totalBytes, etag: null, parts });
    await resumable.writePart(parts[0], Readable.from([kept]));
    assert.deepEqual([...resumable.completed], [0]);

    // A second task for the same object, carrying no digest to check a resume against.
    const blind = await SegmentStaging.open({ root, url, totalBytes, etag: null, parts, resume: false });
    assert.notEqual(blind.dataPath, resumable.dataPath);
    assert.deepEqual([...resumable.completed], [0], "the resumable fill keeps its record");
    assert.deepEqual(await readFirstPart(resumable.dataPath), kept, "the part it already wrote is still there");

    // The same range written by the blind fill never reaches the other file.
    await blind.writePart(parts[0], Readable.from([Buffer.alloc(2 * MiB, 0x55)]));
    assert.deepEqual(await readFirstPart(resumable.dataPath), kept, "the blind fill writes its own file");
    assert.deepEqual([...resumable.completed], [0]);
    assert.deepEqual([...blind.completed], [0]);

    await blind.discard(); await resumable.discard();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a blind fill resets a private directory a restarted process could have reused", async () => {
  const root = await mkdtemp(join(tmpdir(), "stackpilot-staging-"));
  const url = "https://example.com/restarted.bin";
  const totalBytes = 4 * MiB;
  const parts = [{ index: 0, start: 0, end: 2 * MiB - 1 }, { index: 1, start: 2 * MiB, end: totalBytes - 1 }];
  try {
    // A private name is unique per process, so landing on one twice takes pid reuse after a restart.
    // Learn the sequence, then plant a completed part at the name the next fill will take.
    const probe = await SegmentStaging.open({ root, url, totalBytes, etag: null, parts, resume: false });
    await probe.writePart(parts[0], Readable.from([Buffer.alloc(2 * MiB, 0x33)]));
    assert.deepEqual([...probe.completed], [0]);
    const probeName = basename(dirname(probe.dataPath));
    const sequence = Number(/\.(\d+)$/.exec(probeName)[1]);
    const planted = join(root, probeName.replace(/\.\d+$/, `.${sequence + 1}`));
    await cp(dirname(probe.dataPath), planted, { recursive: true });
    await probe.discard();

    const next = await SegmentStaging.open({ root, url, totalBytes, etag: null, parts, resume: false });
    // The planted directory is the one this fill opens; its record must be dropped, not adopted.
    assert.equal(next.dataPath, join(planted, "data.part"));
    assert.deepEqual([...next.completed], []);
    assert.equal(next.resumedBytes, 0);
    await next.discard();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("an origin without Range support degrades to the single-stream path", async () => {
  const payload = Buffer.alloc(9 * MiB, 5);
  const caller = identity();
  const peerServer = await peer(caller, randomUUID(), wholeOrigin(payload));
  const node = randomUUID();
  try {
    await withCache(async (_root, cache) => {
      const result = await fetchThroughCache({
        url: "https://example.com/a.bin",
        segments: { sources: [{ nodeId: node, overlayAddress: "127.0.0.1", port: peerServer.port }] },
      }, {
        cache, identity: caller, fetchImpl: wholeOrigin(payload),
        peerEgress: () => ({ overlayAddress: "127.0.0.1", port: peerServer.port }),
      });
      assert.equal(result.digest, digestOf(payload));
      assert.equal(result.segmented, undefined);
      assert.equal(result.segmentsFallbackReason, "CACHE_RANGE_UNSUPPORTED");
      assert.equal(result.originBytes, payload.length);
    });
  } finally { await peerServer.close(); }
});

test("a digest mismatch restarts the whole object once and then falls back to the origin", async () => {
  const payload = Buffer.alloc(9 * MiB, 11);
  const caller = identity();
  const corrupted = origin(payload, { corrupt: true });
  const peerServer = await peer(caller, randomUUID(), corrupted.impl);
  const direct = origin(payload);
  const node = randomUUID();
  try {
    await withCache(async (_root, cache) => {
      const result = await fetchThroughCache({
        url: "https://example.com/a.bin",
        digest: digestOf(payload),
        segments: { sources: [{ nodeId: node, overlayAddress: "127.0.0.1", port: peerServer.port }] },
      }, {
        cache, identity: caller, fetchImpl: direct.impl,
        peerEgress: () => ({ overlayAddress: "127.0.0.1", port: peerServer.port }),
      });
      assert.equal(result.digest, digestOf(payload));
      assert.equal(result.segmented, undefined);
      assert.equal(result.segmentsFallbackReason, "CACHE_DIGEST_MISMATCH");
      // One probe, one part per pass, then the direct read that finally succeeded.
      assert.equal(corrupted.state.ranges.length, 2);
      assert.equal(direct.state.requests, 2);
    });
  } finally { await peerServer.close(); }
});

test("a failed part is retried on its own and a rerun resumes from the parts already on disk", async () => {
  const payload = Buffer.alloc(9 * MiB, 13);
  const caller = identity();
  // Two failures cover both attempts of the first run; the second run gets a healthy origin.
  const flaky = origin(payload, { failTimes: 2 });
  const healthy = origin(payload);
  const local = origin(payload);
  const a = await peer(caller, randomUUID(), healthy.impl);
  const b = await peer(caller, randomUUID(), flaky.impl);
  const nodeA = randomUUID(); const nodeB = randomUUID();
  try {
    await withCache(async (root, cache) => {
      const dependencies = {
        cache, identity: caller, fetchImpl: local.impl,
        peerEgress: (nodeId) => nodeId === nodeA ? { overlayAddress: "127.0.0.1", port: a.port } : { overlayAddress: "127.0.0.1", port: b.port },
      };
      const parameters = {
        url: "https://example.com/a.bin",
        digest: digestOf(payload),
        segments: { sources: [
          { nodeId: nodeA, overlayAddress: "127.0.0.1", port: a.port },
          { nodeId: nodeB, overlayAddress: "127.0.0.1", port: b.port },
        ] },
      };
      await assert.rejects(() => fetchSegmented({ url: parameters.url, maxBytes: 32 * MiB, parameters, dependencies }),
        (error) => error.code === "CACHE_SEGMENT_PART_FAILED");
      const firstPass = healthy.state.ranges.length;
      assert.equal(firstPass, 1, "the healthy peer served its one part");

      const resumed = await fetchSegmented({ url: parameters.url, maxBytes: 32 * MiB, parameters, dependencies });
      assert.equal(resumed.digest, digestOf(payload));
      assert.equal(resumed.resumedBytes > 0, true);
      // The part that survived the failed pass is reported as resumed, the other one is not.
      assert.deepEqual(resumed.parts.map((part) => part.resumed).sort(), [false, true]);
      assert.equal(resumed.parts.reduce((total, part) => total + part.bytes, 0), payload.length);
      assert.equal(healthy.state.ranges.length, firstPass, "the completed part was not fetched again");
      assert.equal(await readdir(join(root, "staging")).then((entries) => entries.length), 0, "a committed job leaves no staging directory");
    });
  } finally { await a.close(); await b.close(); }
});

test("a fill without a digest never resumes parts it cannot verify", async () => {
  const payload = Buffer.alloc(9 * MiB, 19);
  const caller = identity();
  const flaky = origin(payload, { failTimes: 2 });
  const healthy = origin(payload);
  const local = origin(payload);
  const a = await peer(caller, randomUUID(), healthy.impl);
  const b = await peer(caller, randomUUID(), flaky.impl);
  const nodeA = randomUUID(); const nodeB = randomUUID();
  try {
    await withCache(async (_root, cache) => {
      const dependencies = {
        cache, identity: caller, fetchImpl: local.impl,
        peerEgress: (nodeId) => nodeId === nodeA ? { overlayAddress: "127.0.0.1", port: a.port } : { overlayAddress: "127.0.0.1", port: b.port },
      };
      const parameters = {
        url: "https://example.com/blind.bin",
        segments: { sources: [
          { nodeId: nodeA, overlayAddress: "127.0.0.1", port: a.port },
          { nodeId: nodeB, overlayAddress: "127.0.0.1", port: b.port },
        ] },
      };
      await assert.rejects(() => fetchSegmented({ url: parameters.url, maxBytes: 32 * MiB, parameters, dependencies }),
        (error) => error.code === "CACHE_SEGMENT_PART_FAILED");
      const firstPass = healthy.state.ranges.length;
      assert.equal(firstPass, 1, "the healthy peer served its one part");

      const rerun = await fetchSegmented({ url: parameters.url, maxBytes: 32 * MiB, parameters, dependencies });
      // Nothing proves the bytes left on disk belong to this object, so they are not reused.
      assert.equal(rerun.resumedBytes, 0);
      assert.deepEqual(rerun.parts.map((part) => part.resumed), [false, false]);
      assert.equal(healthy.state.ranges.length, firstPass + 1, "the surviving part was fetched again");
    });
  } finally { await a.close(); await b.close(); }
});

test("a peer the directory does not back is never called", async () => {
  const payload = Buffer.alloc(9 * MiB, 17);
  const caller = identity();
  const peerServer = await peer(caller, randomUUID(), origin(payload).impl);
  try {
    await withCache(async (_root, cache) => {
      const parameters = { url: "https://example.com/a.bin", segments: { sources: [{ nodeId: randomUUID(), overlayAddress: "100.64.0.10", port: peerServer.port }] } };
      await assert.rejects(() => fetchSegmented({
        url: parameters.url, maxBytes: 32 * MiB, parameters, dependencies: { cache, identity: caller, peerEgress: () => null },
      }), (error) => error.code === "CACHE_SEGMENT_NO_SOURCE");
    });
  } finally { await peerServer.close(); }
});

test("the proxy refuses to chain a segment plan to another peer", async () => {
  const caller = identity();
  const server = await peer(caller, randomUUID(), origin(Buffer.alloc(1024)).impl);
  try {
    const body = { url: "https://example.com/a.bin", segments: { sources: [{ nodeId: caller.nodeId, overlayAddress: "100.64.0.10", port: 18080 }] } };
    const raw = Buffer.from(JSON.stringify(body), "utf8");
    const signed = signDataPlaneRequest(caller, "POST", "/v1/fetch", raw);
    const response = await post(server.port, "/v1/fetch", body, signed.headers);
    assert.equal(response.status, 400);
    assert.equal(JSON.parse(response.body.toString("utf8")).code, "DATA_PLANE_EGRESS_CHAIN");
  } finally { await server.close(); }
});

test("the task result describes where the bytes came from", () => {
  const base = { url: "https://example.com/a.bin", digest: "a".repeat(64), sizeBytes: 9 * MiB, originBytes: 0, storedAt: "2025-01-01T00:00:00.000Z", elapsedMs: 12, hit: false, viaEgress: false, egressNodeId: null };
  assert.match(describeFill({ ...base, hit: true, originBytes: 0 }), /缓存命中 a{12}，本次回源 0 字节/);
  assert.match(describeFill({ ...base, segmented: true, segmentCount: 3, segmentSources: ["n1", "n2", "n3"], resumedBytes: 0 }),
    /3 个分片从 3 个节点并行取回 9437184 字节/);
  assert.match(describeFill({ ...base, segmented: true, segmentCount: 2, segmentSources: ["n1", "n2"], resumedBytes: 4096 }), /其中 4096 字节为上次续传/);
  assert.match(describeFill({ ...base, viaEgress: true, egressNodeId: "n1", originBytes: 0 }), /经出口节点取回 0 字节/);
  assert.match(describeFill({ ...base, segmentsFallbackReason: "CACHE_RANGE_UNSUPPORTED", originBytes: 9437184 }), /分片不可用（CACHE_RANGE_UNSUPPORTED）已直取 9437184 字节/);
  assert.match(describeFill({ ...base, egressFallbackReason: "EGRESS_TIMEOUT", originBytes: 9437184 }), /出口不可用（EGRESS_TIMEOUT）已直取/);
});

test("the task handler reports a plain fill and refuses a peer-named plan", async () => {
  const payload = Buffer.alloc(4096, 23);
  const caller = identity();
  await withCache(async (_root, cache) => {
    const summary = await cacheFetchHandler({ url: "https://example.com/a.bin" }, new AbortController().signal, {
      cache, identity: caller, fetchImpl: origin(payload).impl,
    });
    assert.equal(summary.data.digest, digestOf(payload));
    assert.match(summary.message, /回源 4096 字节/);
    await assert.rejects(() => cacheFetchHandler({
      url: "https://example.com/a.bin",
      segments: { sources: [{ nodeId: randomUUID(), overlayAddress: "127.0.0.1", port: 18080 }] },
    }, new AbortController().signal, { cache, identity: caller }), /overlay/i);
  });
});

test("a segmented fill publishes live counters and ends at the object size", async () => {
  const payload = Buffer.alloc(8 * MiB + 4096, 5);
  const caller = identity();
  const first = origin(payload); const second = origin(payload);
  const a = await peer(caller, randomUUID(), first.impl);
  const b = await peer(caller, randomUUID(), second.impl);
  const nodeA = randomUUID(); const nodeB = randomUUID();
  const samples = [];
  try {
    await withCache(async (_root, cache) => {
      await fetchThroughCache({
        url: "https://example.com/a.bin",
        segments: { sources: [
          { nodeId: nodeA, overlayAddress: "127.0.0.1", port: a.port },
          { nodeId: nodeB, overlayAddress: "127.0.0.1", port: b.port },
        ] },
      }, {
        cache, identity: caller, fetchImpl: origin(payload).impl,
        peerEgress: (nodeId) => nodeId === nodeA ? { overlayAddress: "127.0.0.1", port: a.port } : nodeId === nodeB ? { overlayAddress: "127.0.0.1", port: b.port } : null,
        onProgress: (sample) => samples.push(sample),
      });
    });
  } finally { await a.close(); await b.close(); }

  assert.ok(samples.length > 0, "a segmented fill must publish progress");
  assert.ok(samples.every((sample) => sample.totalBytes === payload.length));
  assert.ok(samples.every((sample) => sample.partsTotal === 2));
  assert.ok(samples.every((sample, index) => index === 0 || sample.bytesReceived >= samples[index - 1].bytesReceived));
  const last = samples.at(-1);
  assert.equal(last.bytesReceived, payload.length);
  assert.equal(last.partsDone, 2);
  // Each part carries its own counters, and the parts always add up to what the job reported.
  assert.ok(samples.every((sample) => Array.isArray(sample.parts) && sample.parts.length === 2));
  assert.ok(samples.every((sample) => sample.parts.every((part) => part.totalBytes > 0)));
  assert.ok(samples.every((sample) => sample.parts.reduce((total, part) => total + part.bytes, 0) === sample.bytesReceived));
  assert.deepEqual(new Set(last.parts.map((part) => part.sourceNodeId)), new Set([nodeA, nodeB]));
  assert.ok(last.parts.every((part) => part.bytes === part.totalBytes));
});

test("a direct fill publishes bytes and the origin's declared size", async () => {
  const payload = Buffer.alloc(1 * MiB, 7);
  const caller = identity();
  const samples = [];
  await withCache(async (_root, cache) => {
    const result = await fetchThroughCache({ url: "https://example.com/a.bin" }, {
      cache, identity: caller, fetchImpl: wholeOrigin(payload),
      peerEgress: () => null,
      onProgress: (sample) => samples.push(sample),
    });
    assert.equal(result.digest, digestOf(payload));
    assert.equal(result.segmented, undefined);
    assert.ok(samples.every((sample) => sample.parts === undefined), "a direct fill has no parts to report");
  });
  assert.ok(samples.length > 0);
  assert.ok(samples.every((sample) => sample.totalBytes === payload.length));
  assert.ok(samples.every((sample) => sample.partsTotal === 0));
  assert.ok(samples.every((sample, index) => index === 0 || sample.bytesReceived >= samples[index - 1].bytesReceived));
  // Reporting steps at 256 KiB, so the last sample is at most one step short of the total.
  assert.ok(samples.at(-1).bytesReceived <= payload.length);
  assert.ok(samples.at(-1).bytesReceived > payload.length - 256 * 1024);
});

test("one staging directory has one writer at a time", async () => {
  const key = randomUUID();
  const first = await lockStagingFill(key);
  let secondOwns = false;
  const second = lockStagingFill(key).then((release) => { secondOwns = true; return release; });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(secondOwns, false, "a second fill waits while the first owns the directory");
  first();
  const releaseSecond = await second;
  assert.equal(secondOwns, true);
  releaseSecond();
  // A released key is usable again...
  const again = await Promise.race([lockStagingFill(key), new Promise((resolve) => setTimeout(() => resolve(null), 50))]);
  assert.equal(typeof again, "function", "the queue keeps going after the last owner released");
  again();
  // ...and an unrelated object never waits behind this one.
  const other = await Promise.race([lockStagingFill(randomUUID()), new Promise((resolve) => setTimeout(() => resolve(null), 50))]);
  assert.equal(typeof other, "function");
  other();
});

test("two resumable fills of one object never write the same staging file", async () => {
  const payload = Buffer.alloc(9 * MiB, 29);
  const caller = identity();
  let openGate;
  const gate = new Promise((resolve) => { openGate = resolve; });
  const slow = origin(payload);
  let streaming = 0;
  // The first peer holds its part, so the first fill is still writing when the second one arrives.
  const slowImpl = async (url, init) => { streaming += 1; await gate; return slow.impl(url, init); };
  const quick = origin(payload);
  const a = await peer(caller, randomUUID(), slowImpl);
  const b = await peer(caller, randomUUID(), quick.impl);
  const nodeA = randomUUID(); const nodeB = randomUUID();
  const url = "https://example.com/shared.bin";
  const parameters = (nodeId, port) => ({ url, digest: digestOf(payload), segments: { sources: [{ nodeId, overlayAddress: "127.0.0.1", port }] } });
  try {
    await withCache(async (root, cache) => {
      const probe = origin(payload);
      let probed = 0;
      const probeImpl = async (url, init) => { const response = await probe.impl(url, init); probed += 1; return response; };
      const dependencies = {
        cache, identity: caller, fetchImpl: origin(payload).impl,
        peerEgress: (nodeId) => nodeId === nodeA ? { overlayAddress: "127.0.0.1", port: a.port } : { overlayAddress: "127.0.0.1", port: b.port },
      };
      const first = fetchSegmented({ url, maxBytes: 32 * MiB, parameters: parameters(nodeA, a.port), dependencies });
      for (let waited = 0; streaming === 0 && waited < 400; waited += 1) await new Promise((resolve) => setTimeout(resolve, 5));
      assert.equal(streaming, 1, "the first fill is streaming its part");
      const second = fetchSegmented({ url, maxBytes: 32 * MiB, parameters: parameters(nodeB, b.port), dependencies: { ...dependencies, fetchImpl: probeImpl } });
      // Probing is the last step before the lock, so waiting for it tells "queued behind the first
      // fill" apart from "stuck earlier than the lock".
      for (let waited = 0; probed === 0 && waited < 400; waited += 1) await new Promise((resolve) => setTimeout(resolve, 5));
      assert.ok(probed >= 1, "the second fill finished probing");
      const outcome = await Promise.race([
        second.then(() => "settled", () => "settled"),
        new Promise((resolve) => setTimeout(() => resolve("waiting"), 150)),
      ]);
      // Same object means the same staging directory: the second fill has to queue instead of
      // resetting the sparse file the first one is writing, and must not call its peer yet.
      assert.equal(outcome, "waiting");
      assert.equal(quick.state.requests, 0);
      openGate();
      const [one, two] = await Promise.all([first, second]);
      assert.equal(one.digest, digestOf(payload));
      assert.equal(two.digest, digestOf(payload));
      assert.equal(await readdir(join(root, "staging")).then((entries) => entries.length), 0, "both fills cleaned up their staging");
    });
  } finally { openGate(); await a.close(); await b.close(); }
});

test("a cancelled fill leaves the queue instead of waiting for the running one", async () => {
  const key = randomUUID();
  const first = await lockStagingFill(key);
  const controller = new AbortController();
  const queued = lockStagingFill(key, controller.signal);
  let thirdOwns = false;
  const third = lockStagingFill(key).then((release) => { thirdOwns = true; return release; });
  controller.abort();
  const outcome = await Promise.race([
    queued.then(() => "settled", (error) => error.code ?? "no-code"),
    new Promise((resolve) => setTimeout(() => resolve("blocked"), 500)),
  ]);
  assert.equal(outcome, "CACHE_FETCH_CANCELLED", "an aborted waiter rejects instead of sitting in the queue");
  await new Promise((resolve) => setTimeout(resolve, 20));
  // The fill behind the cancelled one keeps its place: a cancelled waiter must not hand the
  // directory to whoever is next in line while the owner is still writing.
  assert.equal(thirdOwns, false);
  first();
  const releaseThird = await Promise.race([third, new Promise((resolve) => setTimeout(() => resolve(null), 500))]);
  // A waiter that was cancelled but left in the queue would be shifted next, find itself settled and
  // stall the lock, so the fill behind it would never run.
  assert.equal(typeof releaseThird, "function", "the cancelled waiter is gone from the queue");
  // Flipping the flag happens one microtask after the grant that resolved this race.
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(thirdOwns, true);
  releaseThird();
  // An already-aborted signal never takes the directory, and the key stays usable afterwards.
  const dead = new AbortController();
  dead.abort();
  await assert.rejects(() => lockStagingFill(key, dead.signal), (error) => error.code === "CACHE_FETCH_CANCELLED");
  (await lockStagingFill(key))();
});

test("a blind directory expires by the hour while a resumable one waits a day", async () => {
  assert.ok(NETWORK_SEGMENT_BLIND_TTL_MS < NETWORK_SEGMENT_STAGING_TTL_MS, "the two windows have to differ for this to judge anything");
  const url = "https://example.com/sweep.bin";
  const totalBytes = 9 * MiB;
  await withCache(async (_root, cache) => {
    const blind = join(cache.stagingRoot, `${stagingKey(url, totalBytes)}.blind.999999.3`);
    const resumable = join(cache.stagingRoot, stagingKey(url, totalBytes));
    const age = new Date(Date.now() - NETWORK_SEGMENT_BLIND_TTL_MS - 60_000);
    // Nothing creates the staging root up front, so these two directories are all the sweep sees.
    for (const directory of [blind, resumable]) {
      await mkdir(directory, { recursive: true });
      await utimes(directory, age, age);
    }
    // Opening any other object sweeps what it finds on the way in.
    const other = await SegmentStaging.open({
      root: cache.stagingRoot, url: "https://example.com/other.bin", totalBytes: 4096, etag: null, parts: [], resume: true,
    });
    await other.discard();
    // The blind directory held bytes nothing can resume, so an hour is already too long; the
    // resumable one is the same age and stays for its full day.
    assert.deepEqual(await readdir(cache.stagingRoot).then((entries) => entries.sort()), [basename(resumable)]);
  });
});

test("a fill cancelled while queued for the directory stops without disturbing the owner", async () => {
  const payload = Buffer.alloc(9 * MiB, 31);
  const caller = identity();
  let openGate;
  const gate = new Promise((resolve) => { openGate = resolve; });
  const slow = origin(payload);
  let streaming = 0;
  const slowImpl = async (url, init) => { streaming += 1; await gate; return slow.impl(url, init); };
  const quick = origin(payload);
  const a = await peer(caller, randomUUID(), slowImpl);
  const b = await peer(caller, randomUUID(), quick.impl);
  const nodeA = randomUUID(); const nodeB = randomUUID();
  const url = "https://example.com/cancelled.bin";
  const parameters = (nodeId, port) => ({ url, digest: digestOf(payload), segments: { sources: [{ nodeId, overlayAddress: "127.0.0.1", port }] } });
  try {
    await withCache(async (root, cache) => {
      const dependencies = {
        cache, identity: caller, fetchImpl: origin(payload).impl,
        peerEgress: (nodeId) => nodeId === nodeA ? { overlayAddress: "127.0.0.1", port: a.port } : { overlayAddress: "127.0.0.1", port: b.port },
      };
      const first = fetchSegmented({ url, maxBytes: 32 * MiB, parameters: parameters(nodeA, a.port), dependencies });
      for (let waited = 0; streaming === 0 && waited < 400; waited += 1) await new Promise((resolve) => setTimeout(resolve, 5));
      assert.equal(streaming, 1);
      const controller = new AbortController();
      const second = fetchSegmented({ url, maxBytes: 32 * MiB, parameters: parameters(nodeB, b.port), dependencies: { ...dependencies, signal: controller.signal } });
      // The first fill is holding its part open, so without an abortable queue this would sit here.
      await new Promise((resolve) => setTimeout(resolve, 30));
      controller.abort();
      const outcome = await Promise.race([
        second.then(() => "settled", (error) => error.code ?? "no-code"),
        new Promise((resolve) => setTimeout(() => resolve("blocked"), 500)),
      ]);
      assert.equal(outcome, "CACHE_FETCH_CANCELLED");
      assert.equal(quick.state.requests, 0, "the cancelled fill never reached its peer");
      openGate();
      assert.equal((await first).digest, digestOf(payload), "the running fill still commits");
      assert.equal(await readdir(join(root, "staging")).then((entries) => entries.length), 0);
    });
  } finally { openGate(); await a.close(); await b.close(); }
});
