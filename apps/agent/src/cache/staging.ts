import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open as openFile, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { NETWORK_SEGMENT_BLIND_TTL_MS, NETWORK_SEGMENT_IDLE_TIMEOUT_MS, NETWORK_SEGMENT_STAGING_TTL_MS } from "@stackpilot/contracts";
import { z } from "zod";
import { PROGRESS_STEP_BYTES } from "./dependencies.js";
import { CacheError } from "./errors.js";
import type { ProgressDeadline } from "./progressDeadline.js";

const DATA_FILE = "data.part";
const STATE_FILE = "state.json";
const BLIND_MARKER = ".blind.";
const STATE_WRITE_ATTEMPTS = 3;
const STATE_WRITE_BACKOFF_MS = 20;
// Windows reports a lock held by a scanner or by another writer as EPERM; a momentary one is worth a retry.
const TRANSIENT_STATE_ERRORS = new Set(["EPERM", "EACCES", "EBUSY"]);
const BytesSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export type SegmentRange = { index: number; start: number; end: number };

const PartSchema = z.object({ index: z.number().int().min(0).max(64), start: BytesSchema, end: BytesSchema }).strict();
const StateSchema = z.object({
  version: z.literal(1),
  url: z.string().min(1).max(2048),
  totalBytes: BytesSchema,
  etag: z.string().max(256).nullable(),
  parts: z.array(PartSchema).max(64),
  completed: z.array(z.number().int().min(0).max(64)).max(64),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();
type StagingState = z.infer<typeof StateSchema>;

/** The staging directory name is a function of what is being fetched, so a restart finds the same one. */
export function stagingKey(url: string, totalBytes: number) {
  return createHash("sha256").update(`${url}\u0000${totalBytes}`).digest("hex");
}

let blindSequence = 0;

const fillLocks = new Map<string, { owners: number; waiters: { grant: () => void }[] }>();

/**
 * One writer per resumable staging directory. The directory name is a function of the object, so two
 * tasks for the same object can reach the segmented fill together (the in-flight de-dupe key also
 * carries `maxBytes`); the later one waits here instead of resetting the file the first one is
 * writing. Ownership passes straight from one holder to the next queued fill, in order: releasing
 * after granting would let a new fill start beside the one that just took over.
 *
 * An aborted waiter leaves the queue instead of waiting for a transfer that can run for minutes, so
 * a cancelled job does not hold the directory until the fill ahead of it finishes. Call the returned
 * release once in a `finally`.
 */
export function lockStagingFill(key: string, signal?: AbortSignal): Promise<() => void> {
  const state = fillLocks.get(key) ?? { owners: 0, waiters: [] };
  fillLocks.set(key, state);
  return new Promise<() => void>((resolve, reject) => {
    let settled = false;
    const holder = () => {
      let released = false;
      return () => {
        if (released) return;
        released = true;
        state.owners -= 1;
        const next = state.waiters.shift();
        if (next) next.grant();
        else if (fillLocks.get(key) === state) fillLocks.delete(key);
      };
    };
    const grant = () => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", cancel);
      state.owners += 1;
      resolve(holder());
    };
    if (signal?.aborted === true) {
      settled = true;
      reject(new CacheError("CACHE_FETCH_CANCELLED", "The cache fill was cancelled"));
      return;
    }
    const waiter = { grant };
    const cancel = () => {
      if (settled) return;
      settled = true;
      const index = state.waiters.indexOf(waiter);
      if (index >= 0) state.waiters.splice(index, 1);
      reject(new CacheError("CACHE_FETCH_CANCELLED", "The cache fill was cancelled"));
    };
    if (state.owners === 0) { grant(); return; }
    state.waiters.push(waiter);
    signal?.addEventListener("abort", cancel, { once: true });
  });
}

/** Private to one fill: a second writer over the same sparse file is what mixes two runs into one object. */
function privateStagingDirectory(root: string, url: string, totalBytes: number) {
  blindSequence += 1;
  return join(root, `${stagingKey(url, totalBytes)}${BLIND_MARKER}${process.pid}.${blindSequence}`);
}

const samePlan = (left: readonly SegmentRange[], right: readonly SegmentRange[]) => left.length === right.length
  && left.every((part, index) => part.index === right[index]!.index && part.start === right[index]!.start && part.end === right[index]!.end);

/**
 * One in-progress segmented download: a sparse file sized to the object plus a JSON list of the parts
 * already on disk. A different part layout (a peer left the mesh) restarts the parts but keeps the
 * directory, so an interrupted transfer is resumed instead of re-downloaded.
 */
export class SegmentStaging {
  private flushes = 0;
  private draining: Promise<void> | null = null;
  private dirty = false;
  private stateUnwritable = false;

  private constructor(
    private readonly directory: string,
    private state: StagingState,
    private readonly now: () => Date,
  ) {}

  static async open(options: {
    root: string; url: string; totalBytes: number; etag: string | null; parts: readonly SegmentRange[]; resume?: boolean; now?: () => Date;
  }): Promise<SegmentStaging> {
    const now = options.now ?? (() => new Date());
    const resumable = options.resume !== false;
    // A fill that cannot verify a resume must not share the directory either: resetting a sparse file
    // another fill is writing turns a completed object into a mix of both runs.
    const directory = resumable
      ? join(options.root, stagingKey(options.url, options.totalBytes))
      : privateStagingDirectory(options.root, options.url, options.totalBytes);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await SegmentStaging.sweep(options.root, directory, now);
    const dataPath = join(directory, DATA_FILE);
    const existing = await SegmentStaging.readState(directory);
    const info = await stat(dataPath).catch(() => null);
    // Reuse needs a caller that can verify the result: without a digest a blind fill would commit a
    // resume whose bytes nothing can check, so it starts over instead.
    const reusable = resumable && existing !== null && existing.url === options.url && existing.totalBytes === options.totalBytes
      && info?.isFile() && info.size === options.totalBytes && samePlan(existing.parts, options.parts);
    if (reusable) return new SegmentStaging(directory, existing, now);

    await rm(dataPath, { force: true }).catch(() => undefined);
    // The hint must not outlive the bytes it describes: a save that failed for good leaves the old
    // state.json beside a zero-filled file, and the next resumable fill would adopt those part numbers.
    await rm(join(directory, STATE_FILE), { force: true }).catch(() => undefined);
    await SegmentStaging.createSized(dataPath, options.totalBytes);
    const at = now().toISOString();
    const state: StagingState = {
      version: 1, url: options.url, totalBytes: options.totalBytes, etag: options.etag,
      parts: options.parts.map((part) => ({ index: part.index, start: part.start, end: part.end })),
      completed: [], createdAt: at, updatedAt: at,
    };
    const staging = new SegmentStaging(directory, state, now);
    await staging.flush();
    return staging;
  }

  /**
   * A crash leaves at most one directory per object; anything untouched for a day is abandoned. A
   * blind directory is the exception: nothing can ever resume it, so it expires by the hour. The
   * cost is that a process suspended for over an hour loses its own blind directory and restarts
   * the part it was writing.
   */
  private static async sweep(root: string, keep: string, now: () => Date) {
    const at = now().getTime();
    const cutoff = at - NETWORK_SEGMENT_STAGING_TTL_MS;
    const blindCutoff = at - NETWORK_SEGMENT_BLIND_TTL_MS;
    for (const entry of await readdir(root).catch(() => [] as string[])) {
      const directory = join(root, entry);
      if (directory === keep) continue;
      // `stagingKey` is 64 lowercase hex characters, so a resumable name cannot contain the marker.
      const expiry = entry.includes(BLIND_MARKER) ? blindCutoff : cutoff;
      const state = await SegmentStaging.readState(directory);
      const touched = state === null ? null : Date.parse(state.updatedAt);
      if (touched !== null && Number.isFinite(touched) && touched > expiry) continue;
      if (touched === null) {
        const info = await stat(directory).catch(() => null);
        if (info !== null && info.mtimeMs > expiry) continue;
      }
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private static async readState(directory: string): Promise<StagingState | null> {
    try { return StateSchema.parse(JSON.parse(await readFile(join(directory, STATE_FILE), "utf8"))); }
    catch { return null; }
  }

  private static async createSized(path: string, totalBytes: number) {
    const handle = await openFile(path, "w", 0o600);
    try { await handle.truncate(totalBytes); } finally { await handle.close(); }
  }

  get dataPath() { return join(this.directory, DATA_FILE); }
  get completed(): readonly number[] { return this.state.completed; }
  get parts(): readonly SegmentRange[] { return this.state.parts; }
  get resumedBytes() {
    return this.state.parts.filter((part) => this.state.completed.includes(part.index))
      .reduce((sum, part) => sum + (part.end - part.start + 1), 0);
  }

  /**
   * Writes one part at its own offset. The byte count is checked against the range, because a short
   * or long body would otherwise land at the wrong offset and only surface at the final digest.
   */
  async writePart(part: SegmentRange, stream: Readable, idleTimeoutMs = NETWORK_SEGMENT_IDLE_TIMEOUT_MS, onProgress?: (written: number) => void, deadline?: ProgressDeadline | null) {
    const expected = part.end - part.start + 1;
    const handle = await openFile(this.dataPath, "r+");
    let written = 0;
    let reported = 0;
    let idle: NodeJS.Timeout | null = null;
    const arm = () => {
      if (idle !== null) clearTimeout(idle);
      idle = setTimeout(() => stream.destroy(new CacheError("CACHE_SEGMENT_STALLED", "The part stopped sending bytes")), idleTimeoutMs);
      idle.unref?.();
    };
    // The deadline covers the whole job, not this part: a part that trickles while its siblings stall
    // is still no progress. It ends the stream the same way an idle part is destroyed.
    const onStall = () => stream.destroy(deadline!.signal.reason as Error);
    deadline?.signal.addEventListener("abort", onStall, { once: true });
    try {
      arm();
      for await (const chunk of stream) {
        arm();
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        if (written + buffer.length > expected) throw new CacheError("CACHE_SEGMENT_OVERFLOW", "The peer sent more bytes than the range covers");
        await handle.write(buffer, 0, buffer.length, part.start + written);
        written += buffer.length;
        deadline?.observe(buffer.length);
        if (onProgress && written - reported >= PROGRESS_STEP_BYTES) { reported = written; onProgress(written); }
      }
    } catch (error) {
      stream.destroy();
      throw error instanceof CacheError ? error : new CacheError("CACHE_SEGMENT_PART_FAILED", "The part could not be written");
    } finally {
      if (idle !== null) clearTimeout(idle);
      deadline?.signal.removeEventListener("abort", onStall);
      await handle.close().catch(() => undefined);
    }
    if (written !== expected) throw new CacheError("CACHE_SEGMENT_TRUNCATED", "The peer sent fewer bytes than the range covers");
    if (!this.state.completed.includes(part.index)) {
      this.state.completed = [...this.state.completed, part.index].sort((left, right) => left - right);
      await this.flush();
    }
  }

  /** Whole-object hash: the only integrity check that counts, and it covers every part at once. */
  async digest(): Promise<string> {
    const hash = createHash("sha256");
    let seen = 0;
    for await (const chunk of createReadStream(this.dataPath)) {
      seen += (chunk as Buffer).length;
      hash.update(chunk as Buffer);
    }
    if (seen !== this.state.totalBytes) throw new CacheError("CACHE_SEGMENT_TRUNCATED", "The staged object is not the size it claims");
    return hash.digest("hex");
  }

  /** Hands the assembled file to the cache, which renames it into the object store. */
  async take() {
    await rm(join(this.directory, STATE_FILE), { force: true }).catch(() => undefined);
    return this.dataPath;
  }

  async discard() {
    await rm(this.directory, { recursive: true, force: true }).catch(() => undefined);
  }

  /**
   * Parts finish together and each one wants its index on disk, so the saves queue behind a single
   * writer: two renames onto the same name is what turned a state save into EPERM mid-transfer.
   * Resolving does not prove the record reached the disk: once a save fails for good this instance
   * stops trying, so no caller may read this as a durability signal.
   */
  private flush(): Promise<void> {
    if (this.stateUnwritable) return Promise.resolve();
    if (this.draining !== null) {
      this.dirty = true;
      return this.draining;
    }
    this.draining = (async () => {
      try {
        do {
          this.dirty = false;
          await this.writeState();
        } while (this.dirty && !this.stateUnwritable);
      } finally { this.draining = null; }
    })();
    return this.draining;
  }

  /**
   * A part whose bytes are on disk is not thrown away because the resume hint could not be written:
   * a missing hint only costs a re-fetch after a crash, while failing here re-downloads the part on
   * the spot. The digest proves integrity only when the task carries one; a blind fill has no check
   * either way, so keeping the bytes is still the better trade.
   */
  private async writeState() {
    this.state.updatedAt = this.now().toISOString();
    const target = join(this.directory, STATE_FILE);
    // Parts flush concurrently, so the temporary name has to differ per write: a shared one lets one
    // writer rename the other's file away and turns a state save into ENOENT.
    const temporary = `${target}.${process.pid}.${(this.flushes += 1)}.tmp`;
    for (let attempt = 1; attempt <= STATE_WRITE_ATTEMPTS; attempt += 1) {
      try {
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        await writeFile(temporary, JSON.stringify(this.state), { mode: 0o600 });
        await rename(temporary, target);
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code ?? "";
        if (attempt === STATE_WRITE_ATTEMPTS || !TRANSIENT_STATE_ERRORS.has(code)) {
          this.stateUnwritable = true;
          await rm(temporary, { force: true }).catch(() => undefined);
          return;
        }
        await delay(STATE_WRITE_BACKOFF_MS * attempt);
      }
    }
  }
}
