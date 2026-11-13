import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NetworkCacheFetchTaskParametersSchema, NetworkEgressProbeResultSchema } from "@stackpilot/contracts";
import { fetchThroughCache } from "../../apps/agent/dist/cache/fetch.js";
import { ContentCache } from "../../apps/agent/dist/cache/store.js";
import { signDataPlaneRequest } from "../../apps/agent/dist/dataPlane/auth.js";
import { openEgressResponse } from "../../apps/agent/dist/dataPlane/client.js";
import { startDataPlaneServer } from "../../apps/agent/dist/dataPlane/server.js";
import { cacheFetchHandler } from "../../apps/agent/dist/tasks/handlers/cacheFetch.js";
import { egressProbeHandler } from "../../apps/agent/dist/tasks/handlers/egressProbe.js";
import { taskRegistry } from "../../apps/agent/dist/tasks/registry.js";

const digest = (payload) => createHash("sha256").update(payload).digest("hex");

function identity() {
  const pair = generateKeyPairSync("ed25519");
  return {
    nodeId: randomUUID(), credentialId: randomUUID(),
    privateKey: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKey: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

async function withCache(run) {
  const root = await mkdtemp(join(tmpdir(), "stackpilot-egress-"));
  try { return await run(await ContentCache.open({ root, capacityBytes: 64 * 1024 ** 2 })); }
  finally { await rm(root, { recursive: true, force: true }); }
}

async function seed(cache, url, payload) {
  const temp = cache.reservePath();
  await writeFile(temp, payload);
  return cache.commit(temp, { digest: digest(payload), url, sizeBytes: payload.length });
}

function post(port, body, headers = {}) {
  const raw = Buffer.from(JSON.stringify(body), "utf8");
  return new Promise((resolve, reject) => {
    const req = request({
      host: "127.0.0.1", port, path: "/v1/fetch", method: "POST",
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

const json = (response) => JSON.parse(response.body.toString("utf8"));

test("the probe task is a cancellable linux task bound to the transfer capability", () => {
  const definition = taskRegistry["network.egress.probe"];
  assert.equal(definition.capability, "network.transfer");
  assert.deepEqual(definition.platforms, ["linux"]);
  assert.equal(definition.cancellable, true);
  assert.equal(definition.timeoutMs, 60_000);
  assert.doesNotThrow(() => definition.validate({ targets: [{ url: "https://example.com/releases/latest" }] }));
  for (const parameters of [{}, { targets: [] }, { targets: [{ url: "http://example.com/a" }] }, { targets: [{ url: "https://example.com/a", method: "POST" }] }]) {
    assert.throws(() => definition.validate(parameters), JSON.stringify(parameters));
  }
});

test("the data plane refuses to bind anything but an overlay address", async () => {
  const caller = identity();
  await withCache(async (cache) => {
    await assert.rejects(() => startDataPlaneServer({
      nodeId: caller.nodeId, cache, resolvePublicKey: () => caller.publicKey, address: "0.0.0.0", port: 0,
    }), (error) => error.code === "DATA_PLANE_ADDRESS_NOT_OVERLAY");
  });
});

test("a signed peer fetch streams the cached object back with its digest", async () => {
  const caller = identity(); const payload = Buffer.from("layer-4 payload");
  await withCache(async (cache) => {
    const entry = await seed(cache, "https://example.com/layer.tgz", payload);
    const server = await startDataPlaneServer({
      nodeId: randomUUID(), cache, resolvePublicKey: (nodeId) => nodeId === caller.nodeId ? caller.publicKey : null,
      address: "127.0.0.1", port: 0, allowNonOverlayAddress: true,
    });
    try {
      const response = await openEgressResponse({
        egress: { nodeId: caller.nodeId, overlayAddress: "127.0.0.1", port: server.port },
        parameters: { url: "https://example.com/layer.tgz" },
        identity: caller,
      });
      const chunks = []; for await (const chunk of response.stream) chunks.push(chunk);
      assert.equal(Buffer.concat(chunks).toString("utf8"), payload.toString("utf8"));
      assert.equal(response.digest, entry.digest);
      assert.equal(response.hit, true);
      assert.equal(response.sizeBytes, payload.length);
    } finally { await server.close(); }
  });
});

test("the proxy rejects missing, unknown, tampered and replayed signatures", async () => {
  const caller = identity(); const payload = Buffer.from("layer 5");
  await withCache(async (cache) => {
    await seed(cache, "https://example.com/layer.tgz", payload);
    const server = await startDataPlaneServer({
      nodeId: randomUUID(), cache, resolvePublicKey: (nodeId) => nodeId === caller.nodeId ? caller.publicKey : null,
      address: "127.0.0.1", port: 0, allowNonOverlayAddress: true,
    });
    try {
      const body = { url: "https://example.com/layer.tgz" };
      const unsigned = await post(server.port, body);
      assert.equal(unsigned.status, 401);
      assert.equal(json(unsigned).code, "DATA_PLANE_AUTH_MISSING");

      const raw = Buffer.from(JSON.stringify(body), "utf8");
      const signed = signDataPlaneRequest(caller, "POST", "/v1/fetch", raw);
      const unknown = await post(server.port, body, { ...signed.headers, "x-stackpilot-node-id": randomUUID() });
      assert.equal(unknown.status, 401);
      assert.equal(json(unknown).code, "DATA_PLANE_AUTH_UNKNOWN_PEER");

      const tampered = await post(server.port, { url: "https://example.com/other.tgz" }, signed.headers);
      assert.equal(tampered.status, 401);
      assert.equal(json(tampered).code, "DATA_PLANE_AUTH_SIGNATURE");

      const accepted = await post(server.port, body, signed.headers);
      assert.equal(accepted.status, 200);
      const replayed = await post(server.port, body, signed.headers);
      assert.equal(replayed.status, 401);
      assert.equal(json(replayed).code, "DATA_PLANE_AUTH_REPLAY");
    } finally { await server.close(); }
  });
});

test("an egress peer refuses to chain another egress request", async () => {
  const caller = identity(); const payload = Buffer.from("layer 6");
  await withCache(async (cache) => {
    await seed(cache, "https://example.com/layer.tgz", payload);
    const server = await startDataPlaneServer({
      nodeId: randomUUID(), cache, resolvePublicKey: (nodeId) => nodeId === caller.nodeId ? caller.publicKey : null,
      address: "127.0.0.1", port: 0, allowNonOverlayAddress: true,
    });
    try {
      const body = { url: "https://example.com/layer.tgz", egress: { nodeId: randomUUID(), overlayAddress: "100.64.0.5", port: 18080 } };
      const response = await post(server.port, body, signDataPlaneRequest(caller, "POST", "/v1/fetch", Buffer.from(JSON.stringify(body))).headers);
      assert.equal(response.status, 400);
      assert.equal(json(response).code, "DATA_PLANE_EGRESS_CHAIN");
    } finally { await server.close(); }
  });
});

test("a fill through a healthy egress reports viaEgress and never touches the origin", async () => {
  const caller = identity(); const peer = identity(); const payload = Buffer.from("via egress payload");
  await withCache(async (peerCache) => {
    const entry = await seed(peerCache, "https://example.com/layer.tgz", payload);
    const server = await startDataPlaneServer({
      nodeId: peer.nodeId, cache: peerCache, resolvePublicKey: (nodeId) => nodeId === caller.nodeId ? caller.publicKey : null,
      address: "127.0.0.1", port: 0, allowNonOverlayAddress: true,
    });
    try {
      await withCache(async (localCache) => {
        const result = await fetchThroughCache({
          url: "https://example.com/layer.tgz",
          egress: { nodeId: peer.nodeId, overlayAddress: "127.0.0.1", port: server.port },
        }, {
          cache: localCache, identity: caller, peerEgress: (nodeId) => nodeId === peer.nodeId ? { overlayAddress: "127.0.0.1", port: server.port } : null,
          fetchImpl: async () => { throw new Error("the origin must not be contacted"); },
        });
        assert.equal(result.viaEgress, true);
        assert.equal(result.egressNodeId, peer.nodeId);
        assert.equal(result.digest, entry.digest);
        assert.equal(result.originBytes, 0);
        assert.equal(result.hit, false);
      });
    } finally { await server.close(); }
  });
});

test("an unreachable egress degrades to a direct fetch instead of failing the task", async () => {
  const caller = identity(); const payload = Buffer.from("direct fallback payload"); const peerId = randomUUID();
  await withCache(async (cache) => {
    const result = await fetchThroughCache({
      url: "https://example.com/layer.tgz",
      egress: { nodeId: peerId, overlayAddress: "127.0.0.1", port: 1 },
    }, {
      cache, identity: caller,
      peerEgress: (nodeId) => nodeId === peerId ? { overlayAddress: "127.0.0.1", port: 1 } : null,
      fetchImpl: async () => new Response(Buffer.from(payload), { status: 200, headers: { "Content-Length": String(payload.length) } }),
    });
    assert.equal(result.viaEgress, false);
    assert.equal(result.egressNodeId, null);
    assert.equal(result.egressFallbackReason, "EGRESS_UNREACHABLE");
    assert.equal(result.digest, digest(payload));
    assert.equal(result.sizeBytes, payload.length);
    assert.equal(result.originBytes, payload.length);
  });
});

test("a bounded probe reports time-to-first-byte and throughput per source", async () => {
  const payload = Buffer.alloc(4_096, 7);
  const result = await egressProbeHandler({ targets: [{ url: "https://fast.example.com/a" }, { url: "https://slow.example.com/b" }] }, new AbortController().signal, {
    fetchImpl: async (url) => {
      if (String(url).includes("slow")) throw new Error("connect ECONNREFUSED");
      return new Response(payload, { status: 200 });
    },
  });
  assert.equal(NetworkEgressProbeResultSchema.safeParse(result.data).success, true);
  const [fast, slow] = result.data.samples;
  assert.equal(fast.ok, true);
  assert.equal(fast.statusCode, 200);
  assert.equal(fast.host, "fast.example.com");
  assert.ok(fast.ttfbMs >= 0);
  assert.ok(fast.bytesPerSecond > 0);
  assert.equal(slow.ok, false);
  assert.equal(slow.errorCode, "EGRESS_PROBE_FAILED");
  assert.match(result.message, /2 source\(s\); 1 responded/);
});

test("an egress the peer directory does not back is never called, even with a valid signature", async () => {
  const caller = identity(); const peerId = randomUUID(); const payload = Buffer.from("origin after untrusted egress");
  await withCache(async (cache) => {
    let originCalls = 0;
    const result = await fetchThroughCache({
      url: "https://example.com/layer.tgz",
      egress: { nodeId: peerId, overlayAddress: "169.254.169.254", port: 18080 },
    }, {
      cache, identity: caller,
      // The directory knows this node at another address: the task parameters must not win.
      peerEgress: (nodeId) => nodeId === peerId ? { overlayAddress: "100.64.0.9", port: 18080 } : null,
      fetchImpl: async () => { originCalls += 1; return new Response(payload, { status: 200, headers: { "Content-Length": String(payload.length) } }); },
    });
    assert.equal(result.viaEgress, false);
    assert.equal(result.egressFallbackReason, "EGRESS_UNKNOWN_PEER");
    assert.equal(result.digest, digest(payload));
    assert.equal(originCalls, 1);
  });
});

test("the task schema refuses an egress target that is not an overlay address", async () => {
  const nodeId = randomUUID();
  assert.equal(NetworkCacheFetchTaskParametersSchema.safeParse({
    url: "https://example.com/layer.tgz", egress: { nodeId, overlayAddress: "100.64.0.9", port: 18080 },
  }).success, true);
  for (const overlayAddress of ["127.0.0.1", "169.254.169.254", "10.0.0.5", "1.2.3.4"]) {
    assert.equal(NetworkCacheFetchTaskParametersSchema.safeParse({
      url: "https://example.com/layer.tgz", egress: { nodeId, overlayAddress, port: 18080 },
    }).success, false, overlayAddress);
  }
  await assert.rejects(() => cacheFetchHandler({
    url: "https://example.com/layer.tgz", egress: { nodeId, overlayAddress: "127.0.0.1", port: 18080 },
  }, new AbortController().signal), (error) => error.name === "ZodError");
});

test("an egress whose digest header lies leaves no entry for that URL", async () => {
  const caller = identity(); const peerId = randomUUID(); const payload = Buffer.from("poisoned egress bytes");
  const url = "https://example.com/poisoned.tgz";
  const peer = createServer((_request, response) => {
    response.writeHead(200, {
      "Content-Type": "application/octet-stream", "Content-Length": String(payload.length),
      "X-StackPilot-Digest": "b".repeat(64), "X-StackPilot-Size": String(payload.length), "X-StackPilot-Hit": "0",
    });
    response.end(payload);
  });
  await new Promise((resolve) => peer.listen(0, "127.0.0.1", resolve));
  const port = peer.address().port;
  try {
    await withCache(async (cache) => {
      await assert.rejects(() => fetchThroughCache({ url, egress: { nodeId: peerId, overlayAddress: "127.0.0.1", port } }, {
        cache, identity: caller,
        peerEgress: () => ({ overlayAddress: "127.0.0.1", port }),
        fetchImpl: async () => { throw new Error("the origin is down"); },
      }), /the origin is down/);
      // The peer's bytes must not become a hit: the declared digest was checked before commit.
      assert.equal(await cache.findByUrl(url), null);
    });
  } finally { await new Promise((resolve) => peer.close(resolve)); }
});

test("an egress answer without a digest header is refused", async () => {
  const caller = identity(); const peerId = randomUUID(); const url = "https://example.com/no-digest.tgz";
  const peerPayload = Buffer.from("peer bytes without a digest");
  const peer = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": String(peerPayload.length) });
    response.end(peerPayload);
  });
  await new Promise((resolve) => peer.listen(0, "127.0.0.1", resolve));
  const port = peer.address().port;
  try {
    await withCache(async (cache) => {
      const origin = Buffer.from("origin bytes");
      const result = await fetchThroughCache({ url, egress: { nodeId: peerId, overlayAddress: "127.0.0.1", port } }, {
        cache, identity: caller,
        peerEgress: () => ({ overlayAddress: "127.0.0.1", port }),
        fetchImpl: async () => new Response(origin, { status: 200, headers: { "Content-Length": String(origin.length) } }),
      });
      // Without the announced digest the peer's bytes could never be checked before the commit.
      assert.equal(result.viaEgress, false);
      assert.equal(result.egressFallbackReason, "EGRESS_REJECTED");
      assert.equal(result.digest, digest(origin));
      assert.equal(result.originBytes, origin.length);
    });
  } finally { await new Promise((resolve) => peer.close(resolve)); }
});

test("a probe refuses to follow a redirect into a private address", async () => {
  const result = await egressProbeHandler({ targets: [{ url: "https://public.example.com/asset" }] }, new AbortController().signal, {
    fetchImpl: async () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1:8080/admin" } }),
  });
  const [sample] = result.data.samples;
  assert.equal(sample.ok, false);
  assert.equal(sample.errorCode, "CACHE_URL_FORBIDDEN");
  assert.equal(sample.host, "public.example.com");
  assert.match(result.message, /0 responded/);
});

test("a probe records a refused target instead of failing the whole round", async () => {
  const result = await egressProbeHandler({ targets: [{ url: "https://127.0.0.1/asset" }, { url: "https://example.com/asset" }] }, new AbortController().signal, {
    fetchImpl: async () => new Response(Buffer.from("ok"), { status: 200 }),
  });
  assert.equal(NetworkEgressProbeResultSchema.safeParse(result.data).success, true);
  const [refused, fine] = result.data.samples;
  assert.equal(refused.ok, false);
  assert.equal(refused.errorCode, "CACHE_URL_FORBIDDEN");
  assert.equal(refused.host, "-");
  assert.equal(fine.ok, true);
});
