import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat, statfs, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Transform, type Readable } from "node:stream";
import { NETWORK_CACHE_MAX_ENTRIES, NetworkCacheDigestSchema, type NetworkCacheStats } from "@stackpilot/contracts";
import { z } from "zod";
import { CacheError } from "./errors.js";

type CacheEntry = { digest: string; sizeBytes: number; url: string; fetchedAt: string; lastUsedAt: string };
type CacheIndex = { version: 1; hits: number; misses: number; evictions: number; entries: CacheEntry[] };

export type CacheLookup = { digest: string; sizeBytes: number; fetchedAt: string };
/** Presence and size only: consume the bytes through `readVerified`, which re-checks the hash while streaming. */
export type CacheLease = { digest: string; sizeBytes: number; url: string; fetchedAt: string; body: Readable };
export type CacheCommit = { digest: string; url: string; sizeBytes: number };
export type CacheOptions = {
  root: string;
  capacityBytes: number;
  /** Free space kept on the volume; a commit that would eat into it evicts first, then refuses. */
  reserveBytes?: number;
  now?: () => Date;
};

const INDEX_FILE = "index.json";
const OBJECTS_DIR = "objects";
const TEMP_DIR = "tmp";
/** Resumable segmented downloads live here: unlike `tmp`, this directory survives a restart. */
const STAGING_DIR = "staging";
const DEFAULT_RESERVE_BYTES = 512 * 1024 ** 2;

const BytesSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const EntrySchema = z.object({
  digest: NetworkCacheDigestSchema,
  sizeBytes: BytesSchema,
  url: z.string().min(1).max(2048),
  fetchedAt: z.string().datetime(),
  lastUsedAt: z.string().datetime(),
}).strict();
const IndexSchema = z.object({
  version: z.literal(1),
  hits: BytesSchema, misses: BytesSchema, evictions: BytesSchema,
  entries: z.array(EntrySchema).max(NETWORK_CACHE_MAX_ENTRIES),
}).strict();

const emptyIndex = (): CacheIndex => ({ version: 1, hits: 0, misses: 0, evictions: 0, entries: [] });

/**
 * Content-addressed store under one directory: `objects/<sha prefix>/<sha256>` plus a JSON index.
 * Every mutation runs through one queue so concurrent task executions cannot interleave evictions.
 */
export class ContentCache {
  private index: CacheIndex = emptyIndex();
  private queue: Promise<unknown> = Promise.resolve();
  private readonly root: string;
  private readonly capacityBytes: number;
  private readonly reserveBytes: number;
  private readonly now: () => Date;

  private constructor(options: CacheOptions) {
    this.root = options.root;
    this.capacityBytes = Math.max(0, Math.floor(options.capacityBytes));
    this.reserveBytes = Math.max(0, Math.floor(options.reserveBytes ?? DEFAULT_RESERVE_BYTES));
    this.now = options.now ?? (() => new Date());
  }

  static async open(options: CacheOptions) {
    const cache = new ContentCache(options);
    await mkdir(join(cache.root, OBJECTS_DIR), { recursive: true, mode: 0o700 });
    // A part file can only outlive a process that was killed mid-transfer, and that transfer is gone.
    await rm(join(cache.root, TEMP_DIR), { recursive: true, force: true }).catch(() => undefined);
    await mkdir(join(cache.root, TEMP_DIR), { recursive: true, mode: 0o700 });
    await cache.load();
    return cache;
  }

  private get indexPath() { return join(this.root, INDEX_FILE); }
  get stagingRoot() { return join(this.root, STAGING_DIR); }
  get capacity() { return this.capacityBytes; }

  /**
   * Staged parts are not in the index, so only the volume has to hold them until the commit.
   * Checked before the first byte lands instead of failing after a multi-gigabyte download.
   */
  async canStage(bytes: number) {
    if (bytes > this.capacityBytes) return false;
    const free = await this.diskFreeBytes();
    return free === null || free - bytes >= this.reserveBytes;
  }

  private objectPath(digest: string) { return join(this.root, OBJECTS_DIR, digest.slice(0, 2), digest); }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.then(() => undefined, () => undefined);
    return next;
  }

  /** A wiped or hand-edited directory must not poison the index: unreadable state starts empty. */
  private async load() {
    try { this.index = IndexSchema.parse(JSON.parse(await readFile(this.indexPath, "utf8"))); }
    catch { this.index = emptyIndex(); }
    const kept: CacheEntry[] = [];
    for (const entry of this.index.entries) {
      const info = await stat(this.objectPath(entry.digest)).catch(() => null);
      if (info?.isFile() && info.size === entry.sizeBytes) { kept.push(entry); continue; }
      await rm(this.objectPath(entry.digest), { force: true }).catch(() => undefined);
    }
    if (kept.length !== this.index.entries.length) { this.index.entries = kept; await this.flush(); }
    await this.sweep();
  }

  /** Objects the index no longer references (lost or truncated index) would otherwise live on forever. */
  private async sweep() {
    const kept = new Set(this.index.entries.map((entry) => entry.digest));
    const directories = await readdir(join(this.root, OBJECTS_DIR)).catch(() => [] as string[]);
    for (const directory of directories) {
      const path = join(this.root, OBJECTS_DIR, directory);
      const files = await readdir(path).catch(() => [] as string[]);
      for (const file of files) if (!kept.has(file)) await rm(join(path, file), { force: true }).catch(() => undefined);
      if ((await readdir(path).catch(() => [] as string[])).length === 0) await rm(path, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async stats(): Promise<NetworkCacheStats> {
    return {
      collectedAt: this.now().toISOString(),
      capacityBytes: this.capacityBytes,
      usedBytes: this.index.entries.reduce((sum, entry) => sum + entry.sizeBytes, 0),
      entryCount: this.index.entries.length,
      hits: this.index.hits,
      misses: this.index.misses,
      evictions: this.index.evictions,
      diskFreeBytes: await this.diskFreeBytes(),
    };
  }

  async diskFreeBytes(): Promise<number | null> {
    try {
      const info = await statfs(this.root);
      const free = info.bavail * info.bsize;
      return Number.isSafeInteger(free) && free >= 0 ? free : null;
    } catch { return null; }
  }

  /** A hit is only a hit when the object is still on disk at its recorded size. */
  async lookup(digest: string) {
    return this.serialize(() => this.hit(this.index.entries.find((entry) => entry.digest === digest)));
  }

  /** Second chance for a URL whose digest the caller did not know when it asked. */
  async findByUrl(url: string) {
    return this.serialize(() => {
      const newest = this.index.entries
        .filter((entry) => entry.url === url)
        .reduce<CacheEntry | null>((best, entry) => (!best || Date.parse(entry.fetchedAt) > Date.parse(best.fetchedAt) ? entry : best), null);
      return this.hit(newest);
    });
  }

  private async hit(entry: CacheEntry | null | undefined): Promise<CacheLookup | null> {
    if (!entry) return null;
    const info = await stat(this.objectPath(entry.digest)).catch(() => null);
    if (!info?.isFile() || info.size !== entry.sizeBytes) {
      await this.drop(entry.digest);
      return null;
    }
    entry.lastUsedAt = this.now().toISOString();
    this.index.hits += 1;
    await this.flush();
    return { digest: entry.digest, sizeBytes: entry.sizeBytes, fetchedAt: entry.fetchedAt };
  }

  private async drop(digest: string) {
    this.index.entries = this.index.entries.filter((item) => item.digest !== digest);
    await rm(this.objectPath(digest), { force: true }).catch(() => undefined);
    await this.flush();
  }

  /**
   * The only safe way to consume cached bytes: the stream hashes what it emits and fails with
   * `CACHE_OBJECT_CORRUPTED` when the object no longer matches its digest, dropping the entry.
   */
  async readVerified(digest: string): Promise<CacheLease> {
    const entry = await this.serialize(async () => {
      const found = this.index.entries.find((item) => item.digest === digest);
      const info = found ? await stat(this.objectPath(found.digest)).catch(() => null) : null;
      if (!found || !info?.isFile() || info.size !== found.sizeBytes) { await this.drop(digest); return null; }
      return { ...found };
    });
    if (!entry) throw new CacheError("CACHE_OBJECT_MISSING", "The cached object is not available");
    const hash = createHash("sha256");
    let seen = 0;
    const body = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        seen += chunk.length;
        hash.update(chunk);
        callback(null, chunk);
      },
      flush(callback) {
        if (seen === entry.sizeBytes && hash.digest("hex") === entry.digest) { callback(); return; }
        callback(new CacheError("CACHE_OBJECT_CORRUPTED", "The cached object does not match its digest"));
      },
    });
    body.once("error", () => { void this.serialize(() => this.drop(entry.digest)).catch(() => undefined); });
    createReadStream(this.objectPath(entry.digest)).on("error", (error) => body.destroy(error)).pipe(body);
    return { digest: entry.digest, sizeBytes: entry.sizeBytes, url: entry.url, fetchedAt: entry.fetchedAt, body };
  }

  /** Streaming writes land here first; a crash leaves a stray part file, never a half object. */
  reservePath() { return join(this.root, TEMP_DIR, `${randomUUID()}.part`); }

  async recordMiss() {
    return this.serialize(async () => { this.index.misses += 1; await this.flush(); });
  }

  async commit(tempPath: string, input: CacheCommit): Promise<CacheEntry> {
    return this.commitInternal(tempPath, input, true);
  }

  /** A staged object already occupies the volume, so only the capacity bound and LRU still apply. */
  async commitStaged(tempPath: string, input: CacheCommit): Promise<CacheEntry> {
    return this.commitInternal(tempPath, input, false);
  }

  private async commitInternal(tempPath: string, input: CacheCommit, checkDisk: boolean): Promise<CacheEntry> {
    return this.serialize(async () => {
      const info = await stat(tempPath).catch(() => null);
      if (!info?.isFile() || info.size !== input.sizeBytes) {
        await rm(tempPath, { force: true }).catch(() => undefined);
        throw new CacheError("CACHE_TEMP_INVALID", "The staged object does not match its recorded size");
      }
      await this.makeRoom(input.sizeBytes, checkDisk);
      const target = this.objectPath(input.digest);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await rename(tempPath, target);
      const at = this.now().toISOString();
      const entry: CacheEntry = { digest: input.digest, sizeBytes: input.sizeBytes, url: input.url, fetchedAt: at, lastUsedAt: at };
      this.index.entries = [...this.index.entries.filter((item) => item.digest !== input.digest), entry];
      while (this.index.entries.length > NETWORK_CACHE_MAX_ENTRIES) await this.evictOne();
      await this.flush();
      return entry;
    });
  }

  private async evictOne() {
    this.index.entries.sort((left, right) => Date.parse(left.lastUsedAt) - Date.parse(right.lastUsedAt));
    const victim = this.index.entries.shift();
    if (!victim) return 0;
    await rm(this.objectPath(victim.digest), { force: true }).catch(() => undefined);
    this.index.evictions += 1;
    return victim.sizeBytes;
  }

  /** LRU first, then the free-space reserve; a store that cannot fit refuses instead of filling the disk. */
  private async makeRoom(bytes: number, checkDisk = true) {
    this.index.entries.sort((left, right) => Date.parse(left.lastUsedAt) - Date.parse(right.lastUsedAt));
    let used = this.index.entries.reduce((sum, entry) => sum + entry.sizeBytes, 0);
    let free = await this.diskFreeBytes();
    const fits = () => used + bytes <= this.capacityBytes && (!checkDisk || free === null || free - bytes >= this.reserveBytes);
    while (this.index.entries.length > 0 && !fits()) {
      used -= await this.evictOne();
      free = await this.diskFreeBytes();
    }
    if (!fits()) throw new CacheError("CACHE_DISK_LOW", "The cache volume cannot hold the new object above its reserve");
  }

  private async flush() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const temporary = `${this.indexPath}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(this.index), { mode: 0o600 });
    await rename(temporary, this.indexPath);
  }
}
