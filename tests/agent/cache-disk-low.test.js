import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { fetchThroughCache } from "../../apps/agent/dist/cache/fetch.js";
import { ContentCache } from "../../apps/agent/dist/cache/store.js";

const MiB = 1024 ** 2;
const OBJECT_URL = "https://example.com/a.bin";
const digestOf = (payload) => createHash("sha256").update(payload).digest("hex");

/** An origin whose body counts the bytes pulled, so a pre-flight refusal is measurable. */
function meteredOrigin(payload, { declareSize = true } = {}) {
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
    const headers = declareSize ? { "content-length": String(payload.length) } : {};
    return new Response(Readable.toWeb(stream), { status: 200, headers });
  };
  return { impl, state };
}

async function withCache(capacityBytes, reserveBytes, run) {
  const root = await mkdtemp(join(tmpdir(), "stackpilot-disk-low-"));
  try { return await run(await ContentCache.open({ root, capacityBytes, reserveBytes })); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test("a cache that cannot hold the object refuses before the transfer", async () => {
  const payload = randomBytes(8 * MiB);
  const origin = meteredOrigin(payload);
  await withCache(4 * MiB, 1 * MiB, async (cache) => {
    await assert.rejects(
      fetchThroughCache({ url: OBJECT_URL, digest: digestOf(payload) }, { cache, fetchImpl: origin.impl }),
      (error) => error.code === "CACHE_DISK_LOW",
    );
    assert.equal(origin.state.bytes, 0, `the origin was read ${origin.state.bytes} bytes before the refusal`);
    assert.equal(await cache.lookup(digestOf(payload)), null);
  });
});

test("a volume below its reserve refuses the same way", async () => {
  const payload = randomBytes(MiB);
  const origin = meteredOrigin(payload);
  await withCache(64 * MiB, 1024 ** 4, async (cache) => {
    await assert.rejects(
      fetchThroughCache({ url: OBJECT_URL }, { cache, fetchImpl: origin.impl }),
      (error) => error.code === "CACHE_DISK_LOW",
    );
    assert.ok(origin.state.bytes < payload.length, `the origin was read ${origin.state.bytes} bytes before the refusal`);
  });
});

test("an object of unknown size is refused at the commit instead of being kept", async () => {
  const payload = randomBytes(8 * MiB);
  const origin = meteredOrigin(payload, { declareSize: false });
  await withCache(4 * MiB, 1 * MiB, async (cache) => {
    await assert.rejects(
      fetchThroughCache({ url: OBJECT_URL, digest: digestOf(payload) }, { cache, fetchImpl: origin.impl }),
      (error) => error.code === "CACHE_DISK_LOW",
    );
    assert.equal(origin.state.bytes, payload.length);
    assert.equal(await cache.lookup(digestOf(payload)), null);
  });
});

test("a refused fill leaves the cache able to take a smaller object", async () => {
  const large = randomBytes(8 * MiB);
  const small = randomBytes(MiB);
  await withCache(4 * MiB, 1 * MiB, async (cache) => {
    await assert.rejects(
      fetchThroughCache({ url: OBJECT_URL, digest: digestOf(large) }, { cache, fetchImpl: meteredOrigin(large).impl }),
      (error) => error.code === "CACHE_DISK_LOW",
    );
    const filled = await fetchThroughCache(
      { url: "https://example.com/small.bin", digest: digestOf(small) },
      { cache, fetchImpl: meteredOrigin(small).impl },
    );
    assert.equal(filled.sizeBytes, small.length);
    assert.equal(filled.hit, false);
  });
});
