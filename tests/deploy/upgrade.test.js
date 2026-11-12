import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { migrateDatabase } from "../../apps/controller/dist/database/migrator.js";
import { openDatabase } from "../../apps/controller/dist/database/database.js";

const applicationVersion = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8")).version;

const legacyAuditExportMigration = `CREATE TABLE audit_exports (
  export_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  format TEXT NOT NULL CHECK(format IN ('csv','json')),
  status TEXT NOT NULL CHECK(status IN ('ready','failed')),
  row_count INTEGER NOT NULL CHECK(row_count >= 0),
  size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0),
  storage_name TEXT UNIQUE,
  sha256 TEXT,
  creator_user_id TEXT NOT NULL,
  creator_display_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  expires_at TEXT NOT NULL,
  trace_id TEXT NOT NULL UNIQUE,
  error_code TEXT,
  source_max_sequence INTEGER NOT NULL CHECK(source_max_sequence >= 0)
);
CREATE INDEX audit_exports_created_idx ON audit_exports(created_at DESC);
CREATE INDEX audit_exports_expires_idx ON audit_exports(expires_at);
UPDATE release_metadata SET schema_version = 9, upgraded_at = CURRENT_TIMESTAMP WHERE singleton = 1;`;

const migrations = new URL("../../apps/controller/src/database/migrations/", import.meta.url);
const migrationFiles = [
  [1, "identity", "001_identity.sql"],
  [2, "release", "002_release_metadata.sql"],
  [3, "file-uploads", "003_file_uploads.sql"],
  [4, "terminal-snippets", "004_terminal_snippets.sql"],
  [5, "file-trash", "005_file_trash.sql"],
  [6, "database-operations", "006_databases.sql"],
];

async function loadMigrations(entries = migrationFiles) {
  return Promise.all(entries.map(async ([version, name, file]) => ({
    version,
    name,
    sql: await readFile(new URL(file, migrations), "utf8"),
  })));
}

test("schema 1 upgrades to schema 11 without losing identity data", async () => {
  const dir = await mkdtemp(join(tmpdir(), "stackpilot-upgrade-"));
  const path = join(dir, "stackpilot.db");
  try {
    const db = new Database(path);
    migrateDatabase(db, await loadMigrations(migrationFiles.slice(0, 1)));
    const now = new Date().toISOString();
    db.prepare("INSERT INTO users(id,username,password_hash,display_name,password_changed_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?)")
      .run("11111111-1111-4111-8111-111111111111", "upgrade-user", "hash", "Upgrade User", now, now, now);
    db.close();

    const upgraded = openDatabase(path);
    assert.equal(upgraded.prepare("SELECT username FROM users").get().username, "upgrade-user");
    assert.equal(upgraded.prepare("SELECT max(version) AS version FROM schema_migrations").get().version, 11);
    assert.deepEqual(upgraded.prepare("SELECT application_version, schema_version FROM release_metadata").get(), {
      application_version: applicationVersion,
      schema_version: 11,
    });
    for (const table of ["file_uploads", "terminal_snippet_preferences", "file_trash_entries", "database_instances", "database_operations", "site_plans", "site_operations", "audit_exports"]) {
      assert.ok(upgraded.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table));
    }
    upgraded.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("schema 5 file-trash data survives database and site migrations", async () => {
  const dir = await mkdtemp(join(tmpdir(), "stackpilot-schema5-upgrade-"));
  const path = join(dir, "stackpilot.db");
  try {
    const db = new Database(path);
    migrateDatabase(db, await loadMigrations(migrationFiles.slice(0, 5)));
    const now = new Date().toISOString();
    db.prepare("INSERT INTO users(id,username,password_hash,display_name,password_changed_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?)")
      .run("22222222-2222-4222-8222-222222222222", "schema5-user", "hash", "Schema 5 User", now, now, now);
    db.prepare("INSERT INTO file_trash_entries(entry_id,name,kind,root_path,original_path,quarantine_path,size_bytes,deleted_at,expires_at,owner,reason,state) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
      .run("33333333-3333-4333-8333-333333333333", "example.txt", "file", "/srv", "/srv/example.txt", "/srv/.stackpilot-trash/example.txt", 128, now, new Date(Date.now() + 86_400_000).toISOString(), "schema5-user", "test", "trashed");
    db.close();

    const upgraded = openDatabase(path);
    assert.equal(upgraded.prepare("SELECT max(version) AS version FROM schema_migrations").get().version, 11);
    assert.equal(upgraded.prepare("SELECT username FROM users WHERE id=?").get("22222222-2222-4222-8222-222222222222").username, "schema5-user");
    assert.equal(upgraded.prepare("SELECT original_path FROM file_trash_entries WHERE entry_id=?").get("33333333-3333-4333-8333-333333333333").original_path, "/srv/example.txt");
    assert.ok(upgraded.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='database_instances'").get());
    assert.ok(upgraded.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='managed_sites'").get());
    upgraded.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("schema 6 database state upgrades additively to schema 11", async () => {
  const dir = await mkdtemp(join(tmpdir(), "stackpilot-schema6-upgrade-"));
  const path = join(dir, "stackpilot.db");
  try {
    const db = new Database(path);
    migrateDatabase(db, await loadMigrations());
    assert.equal(db.prepare("SELECT max(version) AS version FROM schema_migrations").get().version, 6);
    db.close();
    const upgraded = openDatabase(path);
    assert.equal(upgraded.prepare("SELECT max(version) AS version FROM schema_migrations").get().version, 11);
    assert.ok(upgraded.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='database_operations'").get());
    assert.ok(upgraded.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='site_operations'").get());
    upgraded.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("legacy site-management schema 6 is normalized without losing site data", async () => {
  const dir = await mkdtemp(join(tmpdir(), "stackpilot-legacy-site-schema6-upgrade-"));
  const path = join(dir, "stackpilot.db");
  try {
    const baseMigrations = await loadMigrations(migrationFiles.slice(0, 5));
    const siteSql = await readFile(new URL("007_site_management.sql", migrations), "utf8");
    const legacySiteSql = siteSql.replaceAll(" IF NOT EXISTS", "").replace("schema_version = 7", "schema_version = 6");
    assert.notEqual(legacySiteSql, siteSql);

    const db = new Database(path);
    migrateDatabase(db, [...baseMigrations, { version: 6, name: "site-management", sql: legacySiteSql }]);
    const now = new Date().toISOString();
    db.prepare("INSERT INTO managed_sites(site_id,node_id,domain_digest,desired_state,protected,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)")
      .run("legacy-site", "legacy-node", "legacy-domain-digest", "running", 0, 1, now, now);
    db.close();

    const upgraded = openDatabase(path);
    assert.equal(upgraded.prepare("SELECT desired_state FROM managed_sites WHERE site_id=?").get("legacy-site").desired_state, "running");
    assert.ok(upgraded.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='database_operations'").get());
    assert.deepEqual(upgraded.prepare("SELECT version,name FROM schema_migrations WHERE version >= 6 ORDER BY version").all(), [
      { version: 6, name: "database-operations" },
      { version: 7, name: "site-management" },
      { version: 8, name: "deployment-environment" },
      { version: 9, name: "audit-pagination" },
      { version: 10, name: "audit-exports" },
      { version: 11, name: "managed-ssh" },
    ]);
    assert.deepEqual(upgraded.prepare("SELECT application_version, schema_version FROM release_metadata").get(), {
      application_version: applicationVersion,
      schema_version: 11,
    });
    upgraded.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("failed migration rolls back schema and preserves data", () => {
  const db = new Database(":memory:");
  migrateDatabase(db, [{ version: 1, name: "base", sql: "CREATE TABLE preserved(value TEXT); INSERT INTO preserved VALUES('before');" }]);
  assert.throws(() => migrateDatabase(db, [{ version: 2, name: "broken", sql: "ALTER TABLE preserved ADD COLUMN next TEXT; INSERT INTO missing_table VALUES(1);" }]));
  assert.equal(db.prepare("SELECT value FROM preserved").get().value, "before");
  assert.equal(db.prepare("SELECT max(version) AS version FROM schema_migrations").get().version, 1);
  assert.deepEqual(db.prepare("PRAGMA table_info(preserved)").all().map((row) => row.name), ["value"]);
  db.close();
});

test("schema 7 plans preserve inferred staging while gaining explicit environments and deployment history index", async () => {
  const dir = await mkdtemp(join(tmpdir(), "stackpilot-schema7-upgrade-"));
  const path = join(dir, "stackpilot.db");
  try {
    const siteSql = await readFile(new URL("007_site_management.sql", migrations), "utf8");
    const db = new Database(path);
    migrateDatabase(db, [...await loadMigrations(), { version: 7, name: "site-management", sql: siteSql }]);
    const now = new Date().toISOString();
    const payload = { planId: "11111111-1111-4111-8111-111111111111", nodeId: "node-legacy-01", domains: ["legacy.example.com"], repositoryUrl: "https://github.com/example/legacy.git", repositoryRef: "staging", certificateEnvironment: "production", environmentVariableNames: [], operator: null, status: "queued", digest: "a".repeat(64), version: 1, preview: null, operationId: "22222222-2222-4222-8222-222222222222", createdAt: now, updatedAt: now, expiresAt: new Date(Date.now() + 60_000).toISOString() };
    db.prepare("INSERT INTO site_plans(plan_id,node_id,payload,status,digest,idempotency_digest,version,created_at,updated_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
      .run(payload.planId, payload.nodeId, JSON.stringify(payload), payload.status, payload.digest, "legacy-plan-key", payload.version, now, now, payload.expiresAt);
    const stagingPayload = { ...payload, planId: "33333333-3333-4333-8333-333333333333", operationId: "44444444-4444-4444-8444-444444444444", deploymentEnvironment: "staging" };
    db.prepare("INSERT INTO site_plans(plan_id,node_id,payload,status,digest,idempotency_digest,version,created_at,updated_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
      .run(stagingPayload.planId, stagingPayload.nodeId, JSON.stringify(stagingPayload), stagingPayload.status, stagingPayload.digest, "legacy-staging-key", stagingPayload.version, now, now, stagingPayload.expiresAt);
    db.close();

    const upgraded = openDatabase(path);
    const row = upgraded.prepare("SELECT deployment_environment,payload FROM site_plans WHERE plan_id=?").get(payload.planId);
    assert.equal(row.deployment_environment, "staging");
    assert.equal(JSON.parse(row.payload).deploymentEnvironment, "staging");
    const stagingRow = upgraded.prepare("SELECT deployment_environment,payload FROM site_plans WHERE plan_id=?").get(stagingPayload.planId);
    assert.equal(stagingRow.deployment_environment, "staging");
    assert.equal(JSON.parse(stagingRow.payload).deploymentEnvironment, "staging");
    assert.ok(upgraded.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='site_operations_plan_type_created_idx'").get());
    const queryPlan = upgraded.prepare(`EXPLAIN QUERY PLAN SELECT 1 FROM site_operations operations WHERE operations.operation_type IN ('prepare','activate') AND NOT EXISTS (
      SELECT 1 FROM site_operations newer WHERE newer.plan_id=operations.plan_id AND newer.operation_type IN ('prepare','activate')
        AND (newer.created_at>operations.created_at OR (newer.created_at=operations.created_at AND newer.operation_id>operations.operation_id))
    )`).all().map((entry) => entry.detail).join("\n");
    assert.match(queryPlan, /site_operations_plan_type_created_idx/);
    upgraded.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("schema 8 audit events gain indexed node ownership without changing event data", async () => {
  const dir = await mkdtemp(join(tmpdir(), "stackpilot-schema8-audit-upgrade-"));
  const path = join(dir, "stackpilot.db");
  try {
    const entries = [
      ...migrationFiles,
      [7, "site-management", "007_site_management.sql"],
      [8, "deployment-environment", "008_deployment_environment.sql"],
    ];
    const db = new Database(path);
    migrateDatabase(db, await loadMigrations(entries));
    const now = new Date().toISOString();
    db.prepare("INSERT INTO remote_tasks(task_id,node_id,payload,status,updated_at) VALUES(?,?,?,?,?)").run("task-1", "node-remote", "{}", "queued", now);
    const insert = db.prepare("INSERT INTO audit_events(event_id,occurred_at,actor_type,actor_id,source,target_type,target_id,action,parameters,outcome,authorization,request_id,trace_id,previous_hash,event_hash) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
    const rows = [
      ["event-node", "user", "operator", "node", "node-target", "{}", "hash-node"],
      ["event-agent", "agent", "agent:node-agent", null, null, "{}", "hash-agent"],
      ["event-parameters", "user", "operator", "database-operation", "operation-1", JSON.stringify({ nodeId: "node-parameters" }), "hash-parameters"],
      ["event-remote", "user", "operator", "remote-task", "task-1", "{}", "hash-remote"],
    ];
    for (const [eventId, actorType, actorId, targetType, targetId, parameters, hash] of rows) insert.run(eventId, now, actorType, actorId, "controller", targetType, targetId, "audit.test", parameters, "success", "allowed", `${eventId}-request`, `${eventId}-trace`, "0".repeat(64), hash.padEnd(64, "0"));
    const before = db.prepare("SELECT event_id,event_hash,parameters FROM audit_events ORDER BY sequence").all();
    db.close();

    const upgraded = openDatabase(path);
    assert.equal(upgraded.prepare("SELECT max(version) AS version FROM schema_migrations").get().version, 11);
    assert.deepEqual(upgraded.prepare("SELECT event_id,event_hash,parameters FROM audit_events ORDER BY sequence").all(), before);
    assert.deepEqual(upgraded.prepare("SELECT event_id,node_id FROM audit_events ORDER BY sequence").all(), [
      { event_id: "event-node", node_id: "node-target" },
      { event_id: "event-agent", node_id: "node-agent" },
      { event_id: "event-parameters", node_id: "node-parameters" },
      { event_id: "event-remote", node_id: "node-remote" },
    ]);
    const plan = upgraded.prepare("EXPLAIN QUERY PLAN SELECT sequence FROM audit_events WHERE node_id IN (?) ORDER BY sequence DESC LIMIT 201").all("node-target").map((row) => row.detail).join("\n");
    assert.match(plan, /audit_events_node_sequence_idx/);
    assert.throws(() => upgraded.prepare("UPDATE audit_events SET node_id='changed'").run(), /append-only/);
    assert.throws(() => upgraded.prepare("DELETE FROM audit_events").run(), /append-only/);
    upgraded.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("legacy schema 9 audit exports gain pagination metadata and advance to schema 11", async () => {
  const dir = await mkdtemp(join(tmpdir(), "stackpilot-schema9-export-upgrade-"));
  const path = join(dir, "stackpilot.db");
  try {
    const entries = [
      ...migrationFiles,
      [7, "site-management", "007_site_management.sql"],
      [8, "deployment-environment", "008_deployment_environment.sql"],
    ];
    const db = new Database(path);
    migrateDatabase(db, await loadMigrations(entries));
    migrateDatabase(db, [{ version: 9, name: "audit-exports", sql: legacyAuditExportMigration }]);
    const legacyRecord = {
      exportId: "99999999-9999-4999-8999-999999999999", name: "legacy snapshot", format: "json", status: "failed",
      rowCount: 0, sizeBytes: 0, storageName: null, sha256: null, creatorUserId: "legacy-user", creatorDisplayName: "Legacy User",
      createdAt: "2026-07-15T00:00:00.000Z", completedAt: "2026-07-15T00:00:01.000Z", expiresAt: "2026-07-22T00:00:00.000Z",
      traceId: "88888888-8888-4888-8888-888888888888", errorCode: "GENERATION_FAILED", sourceMaxSequence: 0,
    };
    db.prepare(`INSERT INTO audit_exports(
      export_id,name,format,status,row_count,size_bytes,storage_name,sha256,creator_user_id,creator_display_name,
      created_at,completed_at,expires_at,trace_id,error_code,source_max_sequence
    ) VALUES(@exportId,@name,@format,@status,@rowCount,@sizeBytes,@storageName,@sha256,@creatorUserId,@creatorDisplayName,
      @createdAt,@completedAt,@expiresAt,@traceId,@errorCode,@sourceMaxSequence)`).run(legacyRecord);
    db.close();

    const upgraded = openDatabase(path);
    assert.deepEqual(upgraded.prepare("SELECT version,name FROM schema_migrations WHERE version >= 9 ORDER BY version").all(), [
      { version: 9, name: "audit-pagination" },
      { version: 10, name: "audit-exports" },
      { version: 11, name: "managed-ssh" },
    ]);
    assert.ok(upgraded.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='audit_exports'").get());
    assert.ok(upgraded.prepare("SELECT name FROM pragma_table_info('audit_events') WHERE name='node_id'").get());
    assert.ok(upgraded.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='audit_events_node_sequence_idx'").get());
    assert.deepEqual(upgraded.prepare(`SELECT
      export_id AS exportId,name,format,status,row_count AS rowCount,size_bytes AS sizeBytes,storage_name AS storageName,
      sha256,creator_user_id AS creatorUserId,creator_display_name AS creatorDisplayName,created_at AS createdAt,
      completed_at AS completedAt,expires_at AS expiresAt,trace_id AS traceId,error_code AS errorCode,source_max_sequence AS sourceMaxSequence
      FROM audit_exports WHERE export_id=?`).get(legacyRecord.exportId), legacyRecord);
    upgraded.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("production schema 9 audit pagination upgrades to schema 11 across restarts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "stackpilot-production-schema9-upgrade-"));
  const path = join(dir, "stackpilot.db");
  try {
    const entries = [
      ...migrationFiles,
      [7, "site-management", "007_site_management.sql"],
      [8, "deployment-environment", "008_deployment_environment.sql"],
      [9, "audit-pagination", "009_audit_pagination.sql"],
    ];
    const productionSchema9 = new Database(path);
    migrateDatabase(productionSchema9, await loadMigrations(entries));
    assert.deepEqual(productionSchema9.prepare("SELECT version,name FROM schema_migrations WHERE version=9").get(), { version: 9, name: "audit-pagination" });
    assert.equal(productionSchema9.prepare("SELECT max(version) AS version FROM schema_migrations").get().version, 9);
    productionSchema9.close();

    const upgraded = openDatabase(path);
    assert.deepEqual(upgraded.prepare("SELECT version,name FROM schema_migrations WHERE version>=9 ORDER BY version").all(), [
      { version: 9, name: "audit-pagination" },
      { version: 10, name: "audit-exports" },
      { version: 11, name: "managed-ssh" },
    ]);
    assert.ok(upgraded.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='audit_exports'").get());
    upgraded.close();

    const reopened = openDatabase(path);
    assert.deepEqual(reopened.prepare("SELECT version,name FROM schema_migrations WHERE version>=9 ORDER BY version").all(), [
      { version: 9, name: "audit-pagination" },
      { version: 10, name: "audit-exports" },
      { version: 11, name: "managed-ssh" },
    ]);
    reopened.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("future schema is rejected before migrations change the database", () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TEXT NOT NULL); INSERT INTO schema_migrations VALUES(11,'future','2026-07-14T00:00:00.000Z'); CREATE TABLE preserved(value TEXT); INSERT INTO preserved VALUES('before')");
  assert.throws(() => migrateDatabase(db, [{ version: 10, name: "supported", sql: "CREATE TABLE must_not_exist(id TEXT)" }]), /schema.*支持版本 10/);
  assert.equal(db.prepare("SELECT value FROM preserved").get().value, "before");
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='must_not_exist'").get(), undefined);
  db.close();
});
