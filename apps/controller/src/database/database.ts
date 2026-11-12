import Database from "better-sqlite3";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { migrateDatabase } from "./migrator.js";

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const migrationDirectory = resolve(moduleDirectory, "migrations");
const applicationVersion = (JSON.parse(readFileSync(resolve(moduleDirectory, "../../package.json"), "utf8")) as { version: string }).version;

export function openDatabase(path: string): Database.Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const database = new Database(path);
  database.pragma("foreign_keys = ON");
  database.pragma("busy_timeout = 5000");
  if (path !== ":memory:") database.pragma("journal_mode = WAL");
  try {
    migrateDatabase(database, [
      { version: 1, name: "identity-rbac-agent-audit", sql: readFileSync(resolve(migrationDirectory,"001_identity.sql"), "utf8") },
      { version: 2, name: "release-metadata", sql: readFileSync(resolve(migrationDirectory,"002_release_metadata.sql"), "utf8") },
      { version: 3, name: "file-uploads", sql: readFileSync(resolve(migrationDirectory,"003_file_uploads.sql"), "utf8") },
      { version: 4, name: "terminal-snippets", sql: readFileSync(resolve(migrationDirectory,"004_terminal_snippets.sql"), "utf8") },
      { version: 5, name: "file-trash", sql: readFileSync(resolve(migrationDirectory,"005_file_trash.sql"), "utf8") },
      { version: 6, name: "database-operations", sql: readFileSync(resolve(migrationDirectory,"006_databases.sql"), "utf8"), replaces: ["site-management"] },
      { version: 7, name: "site-management", sql: readFileSync(resolve(migrationDirectory,"007_site_management.sql"), "utf8") },
      { version: 8, name: "deployment-environment", sql: readFileSync(resolve(migrationDirectory,"008_deployment_environment.sql"), "utf8") },
      { version: 9, name: "audit-pagination", sql: readFileSync(resolve(migrationDirectory,"009_audit_pagination.sql"), "utf8"), replaces: ["audit-exports"] },
      { version: 10, name: "audit-exports", sql: readFileSync(resolve(migrationDirectory,"010_audit_exports.sql"), "utf8") },
      { version: 11, name: "managed-ssh", sql: readFileSync(resolve(migrationDirectory,"011_ssh.sql"), "utf8") },
      { version: 12, name: "ssh-helper-identity", sql: readFileSync(resolve(migrationDirectory,"012_ssh_helpers.sql"), "utf8") },
    ]);
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
