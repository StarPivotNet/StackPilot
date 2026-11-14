import Database from "better-sqlite3";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { migrateDatabase } from "./migrator.js";

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const migrationDirectory = resolve(moduleDirectory, "migrations");
const applicationVersion = (JSON.parse(readFileSync(resolve(moduleDirectory, "../../package.json"), "utf8")) as { version: string }).version;

type MigrationFile = { version: number; name: string; file: string; replaces?: string[] };
/** Listed without reading the SQL, so the highest known schema is importable without file IO. */
const MIGRATION_FILES: readonly MigrationFile[] = [
  { version: 1, name: "identity-rbac-agent-audit", file: "001_identity.sql" },
  { version: 2, name: "release-metadata", file: "002_release_metadata.sql" },
  { version: 3, name: "file-uploads", file: "003_file_uploads.sql" },
  { version: 4, name: "terminal-snippets", file: "004_terminal_snippets.sql" },
  { version: 5, name: "file-trash", file: "005_file_trash.sql" },
  { version: 6, name: "database-operations", file: "006_databases.sql", replaces: ["site-management"] },
  { version: 7, name: "site-management", file: "007_site_management.sql" },
  { version: 8, name: "deployment-environment", file: "008_deployment_environment.sql" },
  { version: 9, name: "audit-pagination", file: "009_audit_pagination.sql", replaces: ["audit-exports"] },
  { version: 10, name: "audit-exports", file: "010_audit_exports.sql" },
  { version: 11, name: "managed-ssh", file: "011_ssh.sql" },
  { version: 12, name: "ssh-helper-identity", file: "012_ssh_helpers.sql" },
  { version: 13, name: "mesh-observability", file: "013_mesh_observability.sql" },
];

/** Highest schema this build writes; a database or backup at any version up to it can be read. */
export const LATEST_SCHEMA_VERSION = MIGRATION_FILES[MIGRATION_FILES.length - 1]!.version;

export function openDatabase(path: string): Database.Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const database = new Database(path);
  database.pragma("foreign_keys = ON");
  database.pragma("busy_timeout = 5000");
  if (path !== ":memory:") database.pragma("journal_mode = WAL");
  try {
    migrateDatabase(database, MIGRATION_FILES.map((migration) => ({
      version: migration.version, name: migration.name, sql: readFileSync(resolve(migrationDirectory, migration.file), "utf8"),
      ...(migration.replaces ? { replaces: migration.replaces } : {}),
    })));
    const schemaVersion = (database.prepare("SELECT max(version) AS version FROM schema_migrations").get() as { version: number }).version;
    database.prepare(`UPDATE release_metadata
      SET application_version = ?, schema_version = ?, upgraded_at = CURRENT_TIMESTAMP
      WHERE singleton = 1 AND (application_version <> ? OR schema_version <> ?)`)
      .run(applicationVersion, schemaVersion, applicationVersion, schemaVersion);
  } catch (error) {
    database.close();
    throw error;
  }
  return database;
}
