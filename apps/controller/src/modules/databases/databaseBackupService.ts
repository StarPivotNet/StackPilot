import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, extname, isAbsolute, join, resolve } from "node:path";
import type { DatabaseBackupRecord, DatabaseBackupsPayload } from "@stackpilot/contracts";
import type Database from "better-sqlite3";
import type { ControllerConfig } from "../../config/environment.js";
import { LATEST_SCHEMA_VERSION } from "../../database/database.js";
import { ServiceError } from "../serviceError.js";

/** A backup from any schema this build knows can be drilled; a newer one cannot be read safely. */
const SUPPORTED_SCHEMA_VERSIONS = new Set(Array.from({ length: LATEST_SCHEMA_VERSION }, (_, index) => index + 1));
const BACKUP_EXTENSIONS = new Set([".db", ".sqlite", ".sqlite3"]);
const MAX_BACKUPS = 200;

type DrillMetadata = { status: "succeeded"; completedAt: string };

function pathId(path: string) {
  return createHash("sha256").update(path).digest("hex");
}

async function sha256(path: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function schemaVersion(database: Database.Database) {
  const row = database.prepare("SELECT max(version) AS version FROM schema_migrations").get() as { version: number | null };
  const version = row.version ?? 0;
  if (!SUPPORTED_SCHEMA_VERSIONS.has(version)) throw new ServiceError(400, "BAD_REQUEST", "数据库 schema 版本不在支持范围");
  return version;
}

function assertIntegrity(database: Database.Database) {
  if (database.pragma("integrity_check", { simple: true }) !== "ok") {
    throw new ServiceError(400, "BAD_REQUEST", "数据库完整性校验失败");
  }
  return schemaVersion(database);
}

export class DatabaseBackupService {
  private readonly roots: string[];
  private readonly targetRoot: string;
  private readonly completedRequests = new Map<string, DatabaseBackupRecord>();
  private backupInFlight: Promise<DatabaseBackupRecord> | null = null;

  constructor(
    private readonly database: Database.Database | null,
    private readonly databasePath: string,
    config: ControllerConfig,
    repoRoot: string,
  ) {
    const configured = config.backupDirs?.split(delimiter).map((item) => item.trim()).filter(Boolean) ?? [];
    this.roots = (configured.length ? configured : [join(dirname(databasePath), "backups")])
      .map((item) => isAbsolute(item) ? item : resolve(repoRoot, item));
    this.targetRoot = this.roots[0]!;
  }

  async snapshot(): Promise<DatabaseBackupsPayload> {
    const database = this.requireDatabase();
    const pageCount = Number(database.pragma("page_count", { simple: true }));
    const pageSize = Number(database.pragma("page_size", { simple: true }));
    const backups = await this.listBackups();
    const existingRoots = await Promise.all(this.roots.map(async (root) => (await stat(root).catch(() => null))?.isDirectory() ? root : null));
    return {
      collectedAt: new Date().toISOString(),
      source: {
        id: "controller-sqlite",
        name: "StackPilot Controller",
        engine: "SQLite",
        schemaVersion: schemaVersion(database),
        sizeBytes: Math.max(0, pageCount * pageSize),
        target: basename(this.targetRoot) || "backups",
      },
      backups,
      warnings: existingRoots.some(Boolean) ? [] : ["备份目录尚未创建，首次在线备份时会自动创建"],
    };
  }

  async create(idempotencyKey: string): Promise<DatabaseBackupRecord> {
    const completed = this.completedRequests.get(idempotencyKey);
    if (completed) return completed;
    if (this.backupInFlight) throw new ServiceError(429, "TOO_MANY_REQUESTS", "已有在线备份正在执行");
    const request = this.createOnlineBackup();
    this.backupInFlight = request;
    try {
      const backup = await request;
      this.completedRequests.set(idempotencyKey, backup);
      if (this.completedRequests.size > 100) this.completedRequests.delete(this.completedRequests.keys().next().value!);
      return backup;
    } finally {
      if (this.backupInFlight === request) this.backupInFlight = null;
    }
  }

  async verify(id: string): Promise<DatabaseBackupRecord> {
    const path = await this.pathFor(id);
    await this.validateBackup(path);
    const digest = await sha256(path);
    await writeFile(`${path}.sha256`, `${digest}  ${basename(path)}\n`, { mode: 0o600 });
    return this.recordFor(path, this.rootFor(path));
  }

  async drill(id: string): Promise<DatabaseBackupRecord> {
    const path = await this.pathFor(id);
    const temporaryRoot = await mkdtemp(join(tmpdir(), "stackpilot-restore-drill-"));
    try {
      const isolated = join(temporaryRoot, "restore.sqlite3");
      await copyFile(path, isolated);
      await this.validateBackup(isolated);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
    const metadata: DrillMetadata = { status: "succeeded", completedAt: new Date().toISOString() };
    await writeFile(`${path}.drill.json`, `${JSON.stringify(metadata)}\n`, { mode: 0o600 });
    return this.recordFor(path, this.rootFor(path));
  }

  private requireDatabase() {
    if (!this.database) throw new ServiceError(503, "NOT_READY", "Controller 数据库尚未就绪");
    return this.database;
  }

  private async createOnlineBackup() {
    const database = this.requireDatabase();
    assertIntegrity(database);
    await mkdir(this.targetRoot, { recursive: true, mode: 0o700 });
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
    const path = join(this.targetRoot, `stackpilot-${stamp}-${randomUUID().slice(0, 8)}.sqlite3`);
    await database.backup(path);
    await this.validateBackup(path);
    return this.recordFor(path, this.targetRoot);
  }

  private async validateBackup(path: string) {
    let candidate: Database.Database | null = null;
    try {
      const DatabaseConstructor = (await import("better-sqlite3")).default;
      candidate = new DatabaseConstructor(path, { readonly: true, fileMustExist: true });
      assertIntegrity(candidate);
    } catch (error) {
      if (error instanceof ServiceError) throw error;
      throw new ServiceError(400, "BAD_REQUEST", "备份文件无法作为受支持的 SQLite 数据库读取");
    } finally {
      candidate?.close();
    }
  }

  private async listBackups() {
    const paths: Array<{ path: string; root: string }> = [];
    for (const root of this.roots) {
      const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
      for (const entry of entries.slice(0, MAX_BACKUPS * 2)) {
        if (!entry.isFile() || !BACKUP_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;
        const path = join(root, entry.name);
        const info = await lstat(path).catch(() => null);
        if (info?.isFile() && !info.isSymbolicLink()) paths.push({ path, root });
      }
    }
    const records = await Promise.all(paths.map(({ path, root }) => this.recordFor(path, root)));
    return records.sort((left, right) => right.createdAt.localeCompare(left.createdAt)).slice(0, MAX_BACKUPS);
  }

  private async recordFor(path: string, root: string): Promise<DatabaseBackupRecord> {
    const info = await stat(path);
    const checksum = await readFile(`${path}.sha256`, "utf8").catch(() => "");
    const checksumInfo = await stat(`${path}.sha256`).catch(() => null);
    const drill = await readFile(`${path}.drill.json`, "utf8").then((value) => JSON.parse(value) as DrillMetadata).catch(() => null);
    const checksumCurrent = checksumInfo !== null
      && checksumInfo.mtimeMs >= info.mtimeMs
      && new RegExp(`^[a-f0-9]{64}  ${basename(path).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n?$`).test(checksum);
    return {
      id: pathId(path),
      fileName: basename(path),
      storage: `本地 / ${basename(root) || "backups"}`,
      createdAt: info.mtime.toISOString(),
      sizeBytes: info.size,
      checksumStatus: checksumCurrent ? "verified" : "pending",
      drillStatus: drill?.status === "succeeded" ? "succeeded" : "not_started",
      drilledAt: drill?.status === "succeeded" && !Number.isNaN(Date.parse(drill.completedAt)) ? drill.completedAt : null,
    };
  }

  private rootFor(path: string) {
    const root = this.roots.find((candidate) => dirname(path) === candidate);
    if (!root) throw new ServiceError(404, "NOT_FOUND", "备份不存在");
    return root;
  }

  private async pathFor(id: string) {
    const backups = await this.listBackups();
    const backup = backups.find((item) => item.id === id);
    if (!backup) throw new ServiceError(404, "NOT_FOUND", "备份不存在");
    for (const root of this.roots) {
      const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
      const match = entries.find((entry) => entry.isFile() && pathId(join(root, entry.name)) === id);
      if (match) return join(root, match.name);
    }
    throw new ServiceError(404, "NOT_FOUND", "备份不存在");
  }
}
