import type { DataPlaneIdentity } from "../dataPlane/auth.js";
import type { ProgressDeadline } from "./progressDeadline.js";
import type { ContentCache } from "./store.js";

/**
 * Live counters for one fill. The Agent throttles them; the Controller derives the rate from two
 * samples, so no node is trusted to publish a speed it did not measure.
 */
export type FillPartProgress = { index: number; sourceNodeId: string; bytes: number; totalBytes: number };

export type FillProgress = {
  bytesReceived: number; totalBytes: number | null; partsDone: number; partsTotal: number;
  /** Absent on a direct fill: one stream has no parts to report. */
  parts?: FillPartProgress[];
};

/** Report at most one sample per this many bytes; the executor additionally throttles by time. */
export const PROGRESS_STEP_BYTES = 256 * 1024;

/**
 * Everything one transfer needs. Kept in its own module so the segmented path can describe its
 * requirements without importing the whole-object fetch that calls it.
 */
export type FetchDependencies = {
  cache: ContentCache;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  /** Required to call a peer's proxy; without it a peer request degrades to a direct fetch. */
  identity?: DataPlaneIdentity;
  /**
   * Authoritative peer lookup: a task parameter may name any address, so the receiving node only
   * calls a peer whose overlay address and port match the Controller's own directory entry.
   */
  peerEgress?: (nodeId: string) => { overlayAddress: string; port: number } | null;
  /**
   * Whole-transfer progress deadline. One instance spans every fallback of the same task, so a task
   * that crawls through three routes is still judged as one transfer; the handler stops it.
   */
  deadline?: ProgressDeadline | null;
  onProgress?: (progress: FillProgress) => void;
};
