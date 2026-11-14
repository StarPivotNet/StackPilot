import { mkdir, statfs } from "node:fs/promises";
import { join, resolve } from "node:path";
import { NETWORK_TRANSFER_MIN_BYTES_PER_SECOND, NETWORK_TRANSFER_STALL_WINDOW_MS } from "@stackpilot/contracts";
import { agentLogger } from "../logging/logger.js";
import { ProgressDeadline } from "./progressDeadline.js";
import { ContentCache } from "./store.js";

/** The plan keeps the cache inside 10%–20% of the volume; 15% is the middle of that band. */
export const CACHE_CAPACITY_SHARE = 0.15;
export const CACHE_MIN_CAPACITY_BYTES = 1024 ** 3;
export const CACHE_MAX_CAPACITY_BYTES = 50 * 1024 ** 3;

/** Same default state directory as `loadAgentConfig`, so a dev run and the systemd unit agree. */
export function cacheRootFromEnv(env: NodeJS.ProcessEnv = process.env) {
  return join(resolve(env.STACKPILOT_AGENT_STATE_DIR ?? ".stackpilot/agent"), "cache");
}

export function cacheCapacityFrom(volumeBytes: number) {
  if (!Number.isFinite(volumeBytes) || volumeBytes <= 0) return CACHE_MIN_CAPACITY_BYTES;
  return Math.min(Math.max(Math.floor(volumeBytes * CACHE_CAPACITY_SHARE), CACHE_MIN_CAPACITY_BYTES), CACHE_MAX_CAPACITY_BYTES);
}

export function configuredCapacityBytes(env: NodeJS.ProcessEnv = process.env) {
  const parsed = Number.parseInt(env.STACKPILOT_AGENT_CACHE_BYTES ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed >= 1024 ** 2 && parsed <= CACHE_MAX_CAPACITY_BYTES ? parsed : undefined;
}

/**
 * The only bound on a transfer that keeps trickling: an idle timer never fires while bytes arrive.
 * A window of `0` disables it, which is the escape hatch for a node whose uplink is legitimately
 * below the floor; any other unusable value falls back to the documented default.
 */
export function transferDeadlineFromEnv(env: NodeJS.ProcessEnv = process.env): ProgressDeadline | null {
  const windowSeconds = Number.parseInt(env.STACKPILOT_AGENT_CACHE_STALL_WINDOW_SECONDS ?? "", 10);
  if (windowSeconds === 0) return null;
  const minRate = Number.parseInt(env.STACKPILOT_AGENT_CACHE_MIN_BYTES_PER_SECOND ?? "", 10);
  return new ProgressDeadline({
    windowMs: Number.isSafeInteger(windowSeconds) && windowSeconds >= 10 ? windowSeconds * 1000 : NETWORK_TRANSFER_STALL_WINDOW_MS,
    minBytesPerSecond: Number.isSafeInteger(minRate) && minRate > 0 ? minRate : NETWORK_TRANSFER_MIN_BYTES_PER_SECOND,
  });
}

async function volumeBytes(root: string) {
  try {
    const info = await statfs(root);
    const total = info.blocks * info.bsize;
    return Number.isSafeInteger(total) && total > 0 ? total : 0;
  } catch { return 0; }
}

export async function openAgentCache(env: NodeJS.ProcessEnv = process.env) {
  const root = cacheRootFromEnv(env);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const requested = env.STACKPILOT_AGENT_CACHE_BYTES;
  const configured = configuredCapacityBytes(env);
  const capacityBytes = configured ?? cacheCapacityFrom(await volumeBytes(root));
  // An operator who set an out-of-range value needs one line in the log to explain the fallback.
  if (requested !== undefined && requested.trim() !== "" && configured === undefined) {
    agentLogger.log({ level: "warn", time: new Date().toISOString(), message: "STACKPILOT_AGENT_CACHE_BYTES was ignored", requested, capacityBytes });
  }
  agentLogger.log({ level: "info", time: new Date().toISOString(), message: "Shared cache ready", cacheRoot: root, capacityBytes });
  return ContentCache.open({ root, capacityBytes });
}

let shared: Promise<ContentCache> | null = null;

/** One cache per Agent process: the task handler and the heartbeat must see the same counters. */
export function agentCache(env: NodeJS.ProcessEnv = process.env) {
  shared ??= openAgentCache(env).catch((error: unknown) => { shared = null; throw error; });
  return shared;
}
