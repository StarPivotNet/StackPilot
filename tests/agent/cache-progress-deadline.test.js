import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { Readable } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fetchThroughCache } from "../../apps/agent/dist/cache/fetch.js";
import { ProgressDeadline } from "../../apps/agent/dist/cache/progressDeadline.js";
import { SegmentStaging } from "../../apps/agent/dist/cache/staging.js";
import { ContentCache } from "../../apps/agent/dist/cache/store.js";
import { startDataPlaneServer } from "../../apps/agent/dist/dataPlane/server.js";

const MiB = 1024 ** 2;
const digestOf = (payload) => createHash("sha256").update(payload).digest("hex");

async function withCache(run) {
  const root = await mkdtemp(join(tmpdir(), "stackpilot-deadline-"));
  try {
    return await run(root, await ContentCache.open({ root, capacityBytes: 64 * MiB, reserveBytes: MiB }));
  } finally { await rm(root, { recursive: true, force: true }); }
}

/** An origin whose body keeps arriving, just far too slowly for the floor it is judged against. */
function trickleBody(payload, { chunkBytes = 1024, gapMs = 40 } = {}) {
  let offset = 0;
  return new ReadableStream({
    async pull(controller) {
      if (offset >= payload.length) { controller.close(); return; }
      await new Promise((resolve) => setTimeout(resolve, gapMs));
      const end = Math.min(offset + chunkBytes, payload.length);
      controller.enqueue(payload.subarray(offset, end));
      offset = end;
    },
  });
}

const trickleResponse = (payload, options) => new Response(trickleBody(payload, options), {
  status: 200, headers: { "content-length": String(payload.length) },
});

/** A range-capable origin that answers the one-byte probe at once and crawls every real range. */
function rangeOrigin(payload, { trickle = false } = {}) {
  const state = { requests: 0, ranges: [] };
  const impl = async (_url, init) => {
    state.requests += 1;
    const header = init?.headers?.Range ?? init?.headers?.range ?? null;
    const match = header === null ? null : /^bytes=(\d+)-(\d+)$/.exec(header);
    if (match === null) return new Response(payload, { status: 200, headers: { "content-length": String(payload.length) } });
    const start = Number(match[1]); const end = Number(match[2]);
    state.ranges.push([start, end]);
    const slice = payload.subarray(start, end + 1);
    const headers = { "content-range": `bytes ${start}-${end}/${payload.length}`, "content-length": String(slice.length) };
    if (!trickle || end === 0) return new Response(slice, { status: 206, headers });
    return new Response(trickleBody(slice), { status: 206, headers });
  };
  return { impl, state };
}

function identity() {
  const pair = generateKeyPairSync("ed25519");
  return {
    nodeId: randomUUID(), credentialId: randomUUID(),
    privateKey: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKey: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

function trickleStream(totalBytes, { chunkBytes = 1024, gapMs = 40 } = {}) {
  let sent = 0;
  return new Readable({
    read() {
      setTimeout(() => {
        if (sent >= totalBytes) { this.push(null); return; }
        const size = Math.min(chunkBytes, totalBytes - sent);
        sent += size;
        this.push(Buffer.alloc(size, 7));
      }, gapMs);
    },
  });
}

test("a transfer that only trickles is ended by the progress deadline", async () => {
  await withCache(async (_root, cache) => {
    const payload = Buffer.alloc(8 * MiB, 7);
    const deadline = new ProgressDeadline({ windowMs: 200, minBytesPerSecond: 1024 * 1024 });
    try {
      await assert.rejects(
        fetchThroughCache({ url: "https://example.com/trickle.bin", digest: digestOf(payload) }, {
          cache, fetchImpl: async () => trickleResponse(payload), deadline,
        }),
        (error) => error.code === "CACHE_TRANSFER_STALLED",
      );
    } finally { deadline.stop(); }
  });
});

test("a slow transfer above the floor is left alone", async () => {
  await withCache(async (_root, cache) => {
    const payload = Buffer.alloc(256 * 1024, 3);
    // 8 KiB every 10ms is slow for a real link but far above a 1 KiB/s floor: slow is not stalled.
    const deadline = new ProgressDeadline({ windowMs: 200, minBytesPerSecond: 1024 });
    try {
      const result = await fetchThroughCache({ url: "https://example.com/slow.bin", digest: digestOf(payload) }, {
        cache, fetchImpl: async () => trickleResponse(payload, { chunkBytes: 8 * 1024, gapMs: 10 }), deadline,
      });
      assert.equal(result.sizeBytes, payload.length);
      assert.equal(result.digest, digestOf(payload));
      assert.equal(result.hit, false);
    } finally { deadline.stop(); }
  });
});

test("a part that trickles is destroyed by the deadline instead of holding the job", async () => {
  await withCache(async (root) => {
    const totalBytes = 4 * MiB;
    const parts = [{ index: 0, start: 0, end: totalBytes - 1 }];
    const staging = await SegmentStaging.open({ root: join(root, "staging"), url: "https://example.com/part.bin", totalBytes, etag: null, parts });
    const deadline = new ProgressDeadline({ windowMs: 200, minBytesPerSecond: 1024 * 1024 });
    try {
      await assert.rejects(
        staging.writePart(parts[0], trickleStream(totalBytes), 60_000, undefined, deadline),
        (error) => error.code === "CACHE_TRANSFER_STALLED",
      );
      // The part is not finished, so the staging area stays resumable rather than claiming progress.
      assert.deepEqual(staging.completed, []);
    } finally { deadline.stop(); }
  });
});

test("a stall on the segmented path ends the task instead of trying another route", async () => {
  const payload = Buffer.alloc(8 * MiB, 9);
  const caller = identity();
  const peerId = randomUUID();
  const origin = rangeOrigin(payload, { trickle: true });
  const peerRoot = await mkdtemp(join(tmpdir(), "stackpilot-deadline-peer-"));
  const peerServer = await startDataPlaneServer({
    nodeId: peerId,
    cache: await ContentCache.open({ root: peerRoot, capacityBytes: 32 * MiB, reserveBytes: MiB }),
    resolvePublicKey: (id) => id === caller.nodeId ? caller.publicKey : null,
    address: "127.0.0.1", port: 0, allowNonOverlayAddress: true, fetchImpl: origin.impl,
  });
  try {
    await withCache(async (_root, cache) => {
      const deadline = new ProgressDeadline({ windowMs: 300, minBytesPerSecond: 256 * 1024 });
      try {
        await assert.rejects(
          fetchThroughCache({
            url: "https://example.com/seg.bin", digest: digestOf(payload),
            segments: { sources: [{ nodeId: peerId, overlayAddress: "127.0.0.1", port: peerServer.port }] },
          }, {
            cache, identity: caller, fetchImpl: origin.impl, deadline,
            peerEgress: () => ({ overlayAddress: "127.0.0.1", port: peerServer.port }),
          }),
          (error) => error.code === "CACHE_TRANSFER_STALLED",
        );
      } finally { deadline.stop(); }
      // The probe and the peer's own range are the only origin requests: the task was not retried.
      assert.deepEqual(origin.state.ranges, [[0, 0], [0, payload.length - 1]]);
      assert.equal(origin.state.requests, 2);
    });
  } finally { await peerServer.close(); await rm(peerRoot, { recursive: true, force: true }); }
});

test("waiting for a slow origin's first byte is not a stall", async () => {
  const deadline = new ProgressDeadline({ windowMs: 100, minBytesPerSecond: 1024 * 1024 });
  await new Promise((resolve) => setTimeout(resolve, 300));
  // No byte has arrived yet, so there is no progress to judge; the request has its own timeouts.
  assert.equal(deadline.signal.aborted, false);
  deadline.observe(1024);
  deadline.stop();
  assert.notEqual(deadline.signal.reason?.code, "CACHE_TRANSFER_STALLED");
});

test("the deadline stops once the bytes are in", async () => {
  const deadline = new ProgressDeadline({ windowMs: 100, minBytesPerSecond: 1024 * 1024 });
  deadline.observe(1024 * 1024);
  deadline.stop();
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(deadline.signal.aborted, true);
  // Stopping after the last byte is not a stall: no coded error is published.
  assert.notEqual(deadline.signal.reason?.code, "CACHE_TRANSFER_STALLED");
});
