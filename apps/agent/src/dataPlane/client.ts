import { request, type IncomingMessage } from "node:http";
import type { Readable } from "node:stream";
import { MESH_DATA_PLANE_FETCH_PATH, type NetworkCacheDigestSchema } from "@stackpilot/contracts";
import type { z } from "zod";
import { CacheError } from "../cache/errors.js";
import { signDataPlaneRequest, type DataPlaneIdentity } from "./auth.js";

const DIGEST = /^[a-f0-9]{64}$/;
const MAX_ERROR_BYTES = 2_048;
/** Inactivity bound while the peer streams; a dead socket is dropped instead of pinning the task. */
const EGRESS_TIMEOUT_MS = 30_000;
/** Headers arrive before any body, so a peer that never answers is dropped long before a transfer could finish. */
const EGRESS_HEADER_TIMEOUT_MS = 8_000;

export type EgressTarget = { nodeId: string; overlayAddress: string; port: number };

export type EgressResponse = {
  status: number;
  stream: Readable;
  digest: (z.infer<typeof NetworkCacheDigestSchema>) | null;
  sizeBytes: number | null;
  hit: boolean;
};

const numericHeader = (value: string | string[] | undefined) => {
  const parsed = typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
};

/**
 * Calls a peer's data-plane proxy. Any transport failure surfaces as an `EGRESS_*` CacheError so
 * the caller can fall back to a direct fetch without inspecting socket codes.
 */
export async function openEgressResponse(input: {
  egress: EgressTarget;
  parameters: { url: string; digest?: string; maxBytes?: number };
  identity: DataPlaneIdentity;
  signal?: AbortSignal;
  timeoutMs?: number;
  headerTimeoutMs?: number;
}): Promise<EgressResponse> {
  const body = Buffer.from(JSON.stringify(input.parameters), "utf8");
  const signed = signDataPlaneRequest(input.identity, "POST", MESH_DATA_PLANE_FETCH_PATH, body);
  return new Promise<EgressResponse>((resolve, reject) => {
    let settled = false;
    let active: IncomingMessage | null = null;
    let headerTimer: NodeJS.Timeout | null = null;
    const clearHeaderTimer = () => { if (headerTimer !== null) { clearTimeout(headerTimer); headerTimer = null; } };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      // A rejection must not leave the peer's response stream open: the caller never sees it.
      active?.destroy();
      reject(error);
    };
    const req = request({
      host: input.egress.overlayAddress, port: input.egress.port, path: MESH_DATA_PLANE_FETCH_PATH, method: "POST",
      headers: { ...signed.headers, "Content-Type": "application/json", "Content-Length": String(body.length) },
      timeout: input.timeoutMs ?? EGRESS_TIMEOUT_MS,
    }, (response) => {
      clearHeaderTimer();
      active = response;
      if (response.statusCode !== 200) {
        const chunks: Buffer[] = []; let size = 0;
        response.on("data", (chunk: Buffer) => { size += chunk.length; if (size <= MAX_ERROR_BYTES) chunks.push(chunk); });
        response.on("end", () => {
          let code = "EGRESS_REJECTED";
          try { const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { code?: unknown }; if (typeof parsed.code === "string" && parsed.code.length <= 64) code = parsed.code; } catch { /* an unparsable rejection keeps the generic code */ }
          fail(new CacheError(code, `The egress peer answered with HTTP ${response.statusCode}`));
        });
        response.on("error", () => fail(new CacheError("EGRESS_UNREACHABLE", "The egress response failed")));
        response.on("close", () => fail(new CacheError("EGRESS_UNREACHABLE", "The egress peer closed the response early")));
        return;
      }
      // A 200 must announce the object digest; without it the caller cannot check what it stores.
      const digestHeader = typeof response.headers["x-stackpilot-digest"] === "string" ? response.headers["x-stackpilot-digest"] : null;
      if (digestHeader === null || !DIGEST.test(digestHeader)) {
        fail(new CacheError("EGRESS_REJECTED", "The egress peer did not announce the object digest"));
        return;
      }
      settled = true;
      resolve({
        status: response.statusCode ?? 200, stream: response, digest: digestHeader,
        sizeBytes: numericHeader(response.headers["x-stackpilot-size"]),
        hit: response.headers["x-stackpilot-hit"] === "1",
      });
    });
    req.on("timeout", () => req.destroy(new CacheError("EGRESS_TIMEOUT", "The egress peer did not answer in time")));
    req.on("error", (error) => fail(error instanceof CacheError ? error : new CacheError("EGRESS_UNREACHABLE", "The egress peer is unreachable")));
    // The header bound covers a peer whose proxy accepts the connection but never answers.
    headerTimer = setTimeout(() => req.destroy(new CacheError("EGRESS_TIMEOUT", "The egress peer did not answer in time")), input.headerTimeoutMs ?? EGRESS_HEADER_TIMEOUT_MS);
    headerTimer.unref?.();
    const onAbort = () => req.destroy(new CacheError("EGRESS_ABORTED", "The egress request was cancelled"));
    input.signal?.addEventListener("abort", onAbort, { once: true });
    req.on("close", () => { clearHeaderTimer(); input.signal?.removeEventListener("abort", onAbort); });
    req.end(body);
  });
}
