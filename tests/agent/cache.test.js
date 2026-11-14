import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NetworkCacheFetchResultSchema } from "@stackpilot/contracts";
import { fetchThroughCache } from "../../apps/agent/dist/cache/fetch.js";
import { cacheCapacityFrom, configuredCapacityBytes, transferDeadlineFromEnv } from "../../apps/agent/dist/cache/runtime.js";
import { ContentCache } from "../../apps/agent/dist/cache/store.js";
import { assertAllowedOriginUrl } from "../../apps/agent/dist/cache/urlPolicy.js";
import { cacheFetchHandler } from "../../apps/agent/dist/tasks/handlers/cacheFetch.js";
import { taskRegistry } from "../../apps/agent/dist/tasks/registry.js";

const digestOf = (payload) => createHash("sha256").update(payload).digest("hex");

async function withCache(capacityBytes, run) {
  const root = await mkdtemp(join(tmpdir(), "stackpilot-cache-"));
  try { return await run(root, await ContentCache.open({ root, capacityBytes })); }
  finally { await rm(root, { recursive: true, force: true }); }
}

async function store(cache, digest, url, payload) {
  const temp = cache.reservePath();
  await writeFile(temp, payload);
  return cache.commit(temp, { digest, url, sizeBytes: payload.length });
}

const origin = (payload, headers = {}) => async () => new Response(Buffer.from(payload), { status: 200, headers });

test("a cache fill is a cancellable single-attempt linux task bound to the transfer capability", () => {
  const definition = taskRegistry["network.cache.fetch"];
  assert.equal(definition.capability, "network.transfer");
  assert.deepEqual(definition.platforms, ["linux"]);
  assert.equal(definition.cancellable, true);
  assert.equal(definition.retryable, false);
  assert.doesNotThrow(() => definition.validate({ url: "https://example.com/layer.tgz" }));
  for (const parameters of [{}, { url: "http://example.com/a" }, { url: "https://example.com/a", destination: "/etc/passwd" }, { url: "https://example.com/a", digest: "not-a-digest" }]) {
    assert.throws(() => definition.validate(parameters), JSON.stringify(parameters));
  }
});

test("the origin policy refuses non-public targets before anything is transferred", () => {
  assert.equal(assertAllowedOriginUrl("https://example.com/layer.tgz").hostname, "example.com");
  const blocked = [
    "http://example.com/a", "https://user:pw@example.com/a", "https://localhost/a", "https://cache.localhost/a",
    "https://127.0.0.1/a", "https://10.1.2.3/a", "https://192.168.1.1/a", "https://169.254.1.1/a", "https://172.16.4.4/a",
    "https://100.64.1.1/a", "https://[::1]/a", "https://[fd00::1]/a", "https://[fe80::1]/a",
    "https://metadata.google.internal/a", "https://files.internal/a", "https://nas.local/a",
    // Trailing-dot FQDNs and every IPv6 spelling the URL parser normalises into hex.
    "https://localhost./a", "https://metadata.google.internal./a", "https://nas.local./a",
    "https://[::ffff:127.0.0.1]/a", "https://[::ffff:169.254.169.254]/a", "https://[0:0:0:0:0:ffff:127.0.0.1]/a",
    "https://[::ffff:7f00:1]/a", "https://[::ffff:a9fe:a9fe]/a", "https://[::]/a", "https://[::ffff:0:7f00:1]/a",
    "https://[64:ff9b::7f00:1]/a", "https://[2002:7f00:1::]/a", "https://[ff02::1]/a", "https://[fec0::1]/a",
  ];
  for (const url of blocked) assert.throws(() => assertAllowedOriginUrl(url), (error) => error.code === "CACHE_URL_FORBIDDEN", url);
  assert.throws(() => assertAllowedOriginUrl("not a url"), (error) => error.code === "CACHE_URL_INVALID");
});

test("a committed object survives a reopen and turns a repeat lookup into a hit", async () => {
  const payload = Buffer.from("layer bytes");
  const digest = digestOf(payload);
  await withCache(10 * 1024 ** 2, async (root, cache) => {
    await store(cache, digest, "https://example.com/layer.tgz", payload);
    const stats = await cache.stats();
    assert.equal(stats.entryCount, 1);
    assert.equal(stats.usedBytes, payload.length);
    assert.equal(stats.capacityBytes, 10 * 1024 ** 2);
    assert.equal(stats.hits, 0);
    assert.equal((await cache.lookup(digest)).sizeBytes, payload.length);
    assert.equal((await cache.stats()).hits, 1);

    const reopened = await ContentCache.open({ root, capacityBytes: stats.capacityBytes });
    assert.equal((await reopened.findByUrl("https://example.com/layer.tgz")).digest, digest);
    assert.equal((await reopened.lookup(digest)).digest, digest);
  });
});

test("a tampered object is evicted from the index instead of served as a hit", async () => {
  const payload = Buffer.from("layer bytes");
  const digest = digestOf(payload);
  await withCache(10 * 1024 ** 2, async (root, cache) => {
    await store(cache, digest, "https://example.com/layer.tgz", payload);
    await writeFile(join(root, "objects", digest.slice(0, 2), digest), Buffer.from("corrupted"));
    assert.equal(await cache.lookup(digest), null);
    assert.equal((await cache.stats()).entryCount, 0);
  });
});

test("a same-length corruption passes the size check but fails the verified read", async () => {
  const payload = Buffer.from("layer bytes");
  const digest = digestOf(payload);
  await withCache(10 * 1024 ** 2, async (root, cache) => {
    await store(cache, digest, "https://example.com/layer.tgz", payload);
    const lease = await cache.readVerified(digest);
    const chunks = [];
    for await (const chunk of lease.body) chunks.push(chunk);
    assert.equal(Buffer.concat(chunks).toString(), "layer bytes");
    assert.equal(lease.url, "https://example.com/layer.tgz");

    await writeFile(join(root, "objects", digest.slice(0, 2), digest), Buffer.from("EVIL-BYTES!"));
    assert.equal((await cache.lookup(digest)).sizeBytes, payload.length, "lookup proves presence and size only");
    const corrupted = await cache.readVerified(digest);
    await assert.rejects(
      async () => { for await (const _chunk of corrupted.body) { /* drain */ } },
      (error) => error.code === "CACHE_OBJECT_CORRUPTED",
    );
    // The drop is queued behind the failed read, so the next lookup already sees it.
    assert.equal(await cache.lookup(digest), null);
    assert.equal((await cache.stats()).entryCount, 0);
  });
});

test("objects the index no longer references are swept on the next open", async () => {
  const payload = Buffer.from("layer bytes");
  const digest = digestOf(payload);
  const root = await mkdtemp(join(tmpdir(), "stackpilot-cache-"));
  try {
    const cache = await ContentCache.open({ root, capacityBytes: 10 * 1024 ** 2 });
    await store(cache, digest, "https://example.com/layer.tgz", payload);
    await writeFile(join(root, "objects", digest.slice(0, 2), "f".repeat(64)), Buffer.from("orphan"));
    await rm(join(root, "index.json"));
    await ContentCache.open({ root, capacityBytes: 10 * 1024 ** 2 });
    assert.deepEqual(await readdir(join(root, "objects")), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a part file left by a killed process is removed when the store reopens", async () => {
  const root = await mkdtemp(join(tmpdir(), "stackpilot-cache-"));
  try {
    const cache = await ContentCache.open({ root, capacityBytes: 10 * 1024 ** 2 });
    await writeFile(cache.reservePath(), Buffer.from("partial transfer"));
    await writeFile(join(root, "tmp", "stale.part"), Buffer.from("partial transfer"));
    assert.ok((await readdir(join(root, "tmp"))).length >= 1);
    const reopened = await ContentCache.open({ root, capacityBytes: 10 * 1024 ** 2 });
    assert.deepEqual(await readdir(join(root, "tmp")), []);
    assert.equal((await reopened.stats()).usedBytes, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("the reserve watermark refuses a commit instead of filling the volume", async () => {
  const root = await mkdtemp(join(tmpdir(), "stackpilot-cache-"));
  try {
    const cache = await ContentCache.open({ root, capacityBytes: 1024 ** 3, reserveBytes: Number.MAX_SAFE_INTEGER });
    const payload = Buffer.from("layer bytes");
    const temp = cache.reservePath();
    await writeFile(temp, payload);
    await assert.rejects(() => cache.commit(temp, { digest: digestOf(payload), url: "https://example.com/layer.tgz", sizeBytes: payload.length }), (error) => error.code === "CACHE_DISK_LOW");
    assert.equal((await cache.stats()).entryCount, 0);
    assert.equal((await cache.stats()).usedBytes, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("two concurrent fills for the same URL pull the origin once", async () => {
  await withCache(1024 * 1024, async (root, cache) => {
    let calls = 0;
    const fetchImpl = async () => { calls += 1; await new Promise((resolve) => setTimeout(resolve, 25)); return origin("asset")(); };
    const [first, second] = await Promise.all([
      fetchThroughCache({ url: "https://example.com/shared.bin" }, { cache, fetchImpl }),
      fetchThroughCache({ url: "https://example.com/shared.bin" }, { cache, fetchImpl }),
    ]);
    assert.equal(calls, 1);
    assert.deepEqual([first.hit, second.hit], [false, false]);
    assert.equal(first.originBytes + second.originBytes, 5, "the pair reports the real origin traffic exactly once");
    assert.equal((await cache.stats()).entryCount, 1);
    assert.ok(root);
  });
});

test("the store evicts the least recently used object to stay inside its capacity", async () => {
  await withCache(12, async (root, cache) => {
    const payloads = ["aaaa", "bbbb", "cccc"].map((value) => Buffer.from(value));
    for (const payload of payloads) await store(cache, digestOf(payload), `https://example.com/${payload.toString()}.bin`, payload);
    assert.equal((await cache.stats()).usedBytes, 12);
    const newest = Buffer.from("dddd");
    await store(cache, digestOf(newest), "https://example.com/dddd.bin", newest);
    const stats = await cache.stats();
    assert.equal(stats.usedBytes, 12);
    assert.equal(stats.entryCount, 3);
    assert.equal(stats.evictions, 1);
    assert.equal(await cache.lookup(digestOf(payloads[0])), null, "the oldest entry made room");
    assert.equal((await cache.lookup(digestOf(newest))).sizeBytes, 4);
    assert.ok(root);
  });
});

test("a second fill for the same URL is a hit that never touches the origin", async () => {
  await withCache(1024 * 1024, async (root, cache) => {
    let calls = 0;
    const fetchImpl = async () => { calls += 1; return origin("asset")(); };
    const first = await fetchThroughCache({ url: "https://example.com/asset.bin" }, { cache, fetchImpl });
    assert.equal(first.hit, false);
    assert.equal(first.originBytes, 5);
    assert.equal(first.sizeBytes, 5);
    assert.equal(first.digest, digestOf(Buffer.from("asset")));
    assert.equal(calls, 1);

    const second = await fetchThroughCache({ url: "https://example.com/asset.bin" }, { cache, fetchImpl });
    assert.equal(second.hit, true);
    assert.equal(second.originBytes, 0);
    assert.equal(second.digest, first.digest);
    assert.equal(calls, 1);

    const byDigest = await fetchThroughCache({ url: "https://example.com/other.bin", digest: first.digest }, { cache, fetchImpl });
    assert.equal(byDigest.hit, true, "a known digest short-circuits before the network");
    assert.equal(calls, 1);

    const stats = await cache.stats();
    assert.equal(stats.hits, 2);
    assert.equal(stats.misses, 1);
    assert.ok(root);
  });
});

test("cache fill refuses an oversized object, a mismatched digest, a private redirect and a failed origin", async () => {
  await withCache(1024 * 1024, async (root, cache) => {
    const oversized = async () => new Response(Buffer.alloc(4096), { status: 200 });
    await assert.rejects(() => fetchThroughCache({ url: "https://example.com/big.bin", maxBytes: 1024 }, { cache, fetchImpl: oversized }), (error) => error.code === "CACHE_TOO_LARGE");

    await assert.rejects(
      () => fetchThroughCache({ url: "https://example.com/mismatch.bin", digest: "0".repeat(64) }, { cache, fetchImpl: origin("abc") }),
      (error) => error.code === "CACHE_DIGEST_MISMATCH",
    );

    const redirect = async () => new Response(null, { status: 302, headers: { location: "https://127.0.0.1/a" } });
    await assert.rejects(() => fetchThroughCache({ url: "https://example.com/r" }, { cache, fetchImpl: redirect }), (error) => error.code === "CACHE_URL_FORBIDDEN");

    const missing = async () => new Response("gone", { status: 404 });
    await assert.rejects(() => fetchThroughCache({ url: "https://example.com/404" }, { cache, fetchImpl: missing }), (error) => error.code === "CACHE_ORIGIN_ERROR");
    assert.equal((await cache.stats()).entryCount, 0, "a rejected transfer leaves nothing behind");
    assert.ok(root);
  });
});

test("the task handler reports the digest, the origin byte count and the hit", async () => {
  await withCache(1024 * 1024, async (root, cache) => {
    const fetchImpl = origin("asset");
    const signal = new AbortController().signal;
    const first = await cacheFetchHandler({ url: "https://example.com/a.bin" }, signal, { cache, fetchImpl });
    assert.match(first.message, /回源 5 字节/);
    assert.equal(first.truncated, false);
    assert.equal(NetworkCacheFetchResultSchema.safeParse(first.data).success, true);
    const second = await cacheFetchHandler({ url: "https://example.com/a.bin" }, signal, { cache, fetchImpl });
    assert.match(second.message, /缓存命中/);
    assert.match(second.message, /回源 0 字节/);
    assert.ok(root);
  });
});

test("the default capacity follows the volume share with a floor and a ceiling", () => {
  assert.equal(cacheCapacityFrom(0), 1024 ** 3);
  assert.equal(cacheCapacityFrom(100 * 1024 ** 3), 15 * 1024 ** 3);
  assert.equal(cacheCapacityFrom(1024 ** 4), 50 * 1024 ** 3);
  assert.equal(configuredCapacityBytes({ STACKPILOT_AGENT_CACHE_BYTES: "2097152" }), 2 * 1024 ** 2);
  assert.equal(configuredCapacityBytes({ STACKPILOT_AGENT_CACHE_BYTES: "abc" }), undefined);
  assert.equal(configuredCapacityBytes({}), undefined);
});

test("the progress deadline reads its window and floor from the environment", () => {
  const defaults = transferDeadlineFromEnv({});
  assert.deepEqual(defaults.options, { windowMs: 120_000, minBytesPerSecond: 2_048 });
  defaults.stop();
  assert.equal(transferDeadlineFromEnv({ STACKPILOT_AGENT_CACHE_STALL_WINDOW_SECONDS: "0" }), null);
  const custom = transferDeadlineFromEnv({ STACKPILOT_AGENT_CACHE_STALL_WINDOW_SECONDS: "30", STACKPILOT_AGENT_CACHE_MIN_BYTES_PER_SECOND: "1024" });
  assert.deepEqual(custom.options, { windowMs: 30_000, minBytesPerSecond: 1_024 });
  custom.stop();
  // An unusable value falls back to the default instead of disabling the only bound on a trickle.
  const invalid = transferDeadlineFromEnv({ STACKPILOT_AGENT_CACHE_STALL_WINDOW_SECONDS: "3", STACKPILOT_AGENT_CACHE_MIN_BYTES_PER_SECOND: "-5" });
  assert.deepEqual(invalid.options, { windowMs: 120_000, minBytesPerSecond: 2_048 });
  invalid.stop();
});
