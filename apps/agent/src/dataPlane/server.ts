import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  AGENT_PROTOCOL_VERSION, MESH_DATA_PLANE_FETCH_PATH, MESH_DATA_PLANE_HEALTH_PATH, MESH_DATA_PLANE_RANGE_PATH,
  NetworkCacheFetchTaskParametersSchema, NetworkCacheRangeRequestSchema, NetworkMeshOverlayAddressSchema,
} from "@stackpilot/contracts";
import { ensureObject } from "../cache/fetch.js";
import { CacheError } from "../cache/errors.js";
import { openOriginRange } from "../cache/origin.js";
import type { ContentCache } from "../cache/store.js";
import { DataPlaneNonceCache, verifyDataPlaneRequest } from "./auth.js";

const MAX_BODY_BYTES = 16 * 1024;
/** A peer that stops reading leaves the fill stalled on backpressure; five idle minutes ends it. */
const STREAM_IDLE_TIMEOUT_MS = 300_000;

export type DataPlaneServerOptions = {
  nodeId: string;
  cache: ContentCache;
  /** Peer credentials come from the Controller directory; an unknown node is refused, not guessed. */
  resolvePublicKey: (nodeId: string) => string | null;
  now?: () => Date;
  nonces?: DataPlaneNonceCache;
  /** Tests bind loopback; production must stay on the overlay address. */
  allowNonOverlayAddress?: boolean;
  /** Tests serve a fixed origin; production leaves this undefined and the origin is the real one. */
  fetchImpl?: typeof fetch;
};

function json(response: ServerResponse, status: number, payload: unknown) {
  const raw = Buffer.from(JSON.stringify(payload), "utf8");
  response.writeHead(status, { "Content-Type": "application/json", "Content-Length": String(raw.length), "Cache-Control": "no-store" });
  response.end(raw);
}

async function readBody(request: IncomingMessage): Promise<Buffer | null> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

/**
 * The data plane every node exposes on the overlay. It never proxies generic requests: the only
 * transfer it serves is a cache fill for an https origin that passes the same URL policy.
 */
export function createDataPlaneServer(options: DataPlaneServerOptions): Server {
  const nonces = options.nonces ?? new DataPlaneNonceCache();
  const now = options.now ?? (() => new Date());

  const server = createServer((request, response) => {
    void handle(request, response).catch(() => { if (!response.headersSent) json(response, 500, { code: "DATA_PLANE_FAILED", message: "The data plane failed" }); else response.destroy(); });
  });

  async function handle(request: IncomingMessage, response: ServerResponse) {
    const path = new URL(request.url ?? "/", "http://overlay").pathname;
    if (path === MESH_DATA_PLANE_HEALTH_PATH) {
      if ((request.method ?? "GET") !== "GET") { json(response, 405, { code: "DATA_PLANE_METHOD", message: "Use GET" }); return; }
      json(response, 200, { nodeId: options.nodeId, protocolVersion: AGENT_PROTOCOL_VERSION, collectedAt: now().toISOString() });
      return;
    }
    if (path === MESH_DATA_PLANE_RANGE_PATH) { await handleRange(request, response, path); return; }
    if (path !== MESH_DATA_PLANE_FETCH_PATH) { json(response, 404, { code: "DATA_PLANE_NOT_FOUND", message: "Unknown data-plane path" }); return; }
    if ((request.method ?? "GET") !== "POST") { json(response, 405, { code: "DATA_PLANE_METHOD", message: "Use POST" }); return; }

    const body = await readBody(request);
    if (body === null) { json(response, 413, { code: "DATA_PLANE_BODY_TOO_LARGE", message: "Request body too large" }); return; }
    const verification = verifyDataPlaneRequest({
      method: "POST", path, body, headers: request.headers,
      resolvePublicKey: options.resolvePublicKey, nonces,
      now: () => now().getTime(),
    });
    if (!verification.ok) { json(response, 401, { code: verification.code, message: "Peer authentication failed" }); return; }

    let parsed: ReturnType<typeof NetworkCacheFetchTaskParametersSchema.parse>;
    try { parsed = NetworkCacheFetchTaskParametersSchema.parse(JSON.parse(body.toString("utf8"))); }
    catch { json(response, 400, { code: "DATA_PLANE_BAD_REQUEST", message: "Invalid cache fill parameters" }); return; }
    // An egress peer fills from the origin itself; chaining would let one request walk the whole mesh.
    if (parsed.egress || parsed.segments) { json(response, 400, { code: "DATA_PLANE_EGRESS_CHAIN", message: "An egress peer must not forward another peer request" }); return; }

    try {
      // A large object can outlive any fixed budget; the fill stops when the caller goes away.
      const controller = new AbortController();
      response.on("close", () => { if (!response.writableEnded) controller.abort(); });
      const ensured = await ensureObject(parsed, { cache: options.cache, signal: controller.signal });
      const lease = await options.cache.readVerified(ensured.digest);
      response.setTimeout(STREAM_IDLE_TIMEOUT_MS, () => response.destroy());
      response.writeHead(200, {
        "Content-Type": "application/octet-stream", "Content-Length": String(lease.sizeBytes), "Cache-Control": "no-store",
        "X-StackPilot-Digest": lease.digest, "X-StackPilot-Size": String(lease.sizeBytes), "X-StackPilot-Hit": ensured.hit ? "1" : "0",
      });
      response.on("close", () => lease.body.destroy());
      lease.body.pipe(response);
      lease.body.once("error", () => response.destroy());
    } catch (error) {
      const code = error instanceof CacheError ? error.code : "DATA_PLANE_FILL_FAILED";
      if (response.headersSent) { response.destroy(); return; }
      json(response, code === "CACHE_OBJECT_MISSING" ? 503 : 502, { code, message: error instanceof CacheError ? error.message : "The fill failed" });
    }
  }

  /**
   * One byte range of an origin object, streamed straight through: nothing is stored on this node,
   * so a segmented download costs the peer bandwidth and no cache space.
   */
  async function handleRange(request: IncomingMessage, response: ServerResponse, path: string) {
    if ((request.method ?? "GET") !== "POST") { json(response, 405, { code: "DATA_PLANE_METHOD", message: "Use POST" }); return; }
    const body = await readBody(request);
    if (body === null) { json(response, 413, { code: "DATA_PLANE_BODY_TOO_LARGE", message: "Request body too large" }); return; }
    const verification = verifyDataPlaneRequest({
      method: "POST", path, body, headers: request.headers,
      resolvePublicKey: options.resolvePublicKey, nonces, now: () => now().getTime(),
    });
    if (!verification.ok) { json(response, 401, { code: verification.code, message: "Peer authentication failed" }); return; }

    let parsed: ReturnType<typeof NetworkCacheRangeRequestSchema.parse>;
    try { parsed = NetworkCacheRangeRequestSchema.parse(JSON.parse(body.toString("utf8"))); }
    catch { json(response, 400, { code: "DATA_PLANE_BAD_REQUEST", message: "Invalid range parameters" }); return; }

    try {
      const controller = new AbortController();
      response.on("close", () => { if (!response.writableEnded) controller.abort(); });
      const range = await openOriginRange(parsed.url, parsed.start, parsed.end, {
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}), signal: controller.signal,
      });
      response.setTimeout(STREAM_IDLE_TIMEOUT_MS, () => response.destroy());
      response.writeHead(200, {
        "Content-Type": "application/octet-stream", "Content-Length": String(range.bytes),
        "Content-Range": `bytes ${parsed.start}-${parsed.end}/${range.totalBytes ?? "*"}`, "Cache-Control": "no-store",
      });
      response.on("close", () => range.stream.destroy());
      // The announced length is the contract; an origin that oversends is cut off rather than trusted.
      let sent = 0;
      const meter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          if (sent + chunk.length > range.bytes) { callback(new CacheError("DATA_PLANE_RANGE_OVERFLOW", "The origin sent more bytes than the range covers")); return; }
          sent += chunk.length;
          callback(null, chunk);
        },
      });
      void pipeline(range.stream, meter, response).catch(() => response.destroy());
    } catch (error) {
      const code = error instanceof CacheError ? error.code : "DATA_PLANE_RANGE_FAILED";
      if (response.headersSent) { response.destroy(); return; }
      json(response, code === "CACHE_RANGE_UNSUPPORTED" ? 501 : 502, { code, message: error instanceof CacheError ? error.message : "The range fetch failed" });
    }
  }

  return server;
}

export type RunningDataPlane = { server: Server; address: string; port: number; close: () => Promise<void> };

/** Binds `address:port` only: a proxy reachable off the overlay would bypass the helper's firewall. */
export async function startDataPlaneServer(options: DataPlaneServerOptions & { address: string; port: number }): Promise<RunningDataPlane> {
  if (!options.allowNonOverlayAddress && !NetworkMeshOverlayAddressSchema.safeParse(options.address).success) {
    throw new CacheError("DATA_PLANE_ADDRESS_NOT_OVERLAY", "The data plane only binds an overlay address");
  }
  const server = createDataPlaneServer(options);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.address, () => { server.off("error", reject); resolve(); });
  });
  const bound = server.address();
  return {
    server, address: options.address, port: typeof bound === "object" && bound !== null ? bound.port : options.port,
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections?.(); }),
  };
}
