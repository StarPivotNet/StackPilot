import assert from "node:assert/strict";
import test from "node:test";
import {
  API_CLIENT_PREFIX, API_ROOT_SEGMENTS, ApiErrorResponseSchema, CreateScheduleJobRequestSchema, ScheduleExecutionSchema,
  OverviewSummaryPayloadSchema, PathIdSchema, SchedulePayloadSchema, WRITE_METHODS,
  AGENT_PROTOCOL_VERSION, AgentDatabaseSnapshotSchema, AgentHeartbeatSchema, AgentTelemetrySnapshotSchema, HostMonitoringRecordSchema, PhysicalHostIdSchema,
  CreateRemoteTaskRequestSchema, RemoteTaskListResponseSchema, isAgentProtocolCompatible,
  SiteRuntimePayloadSchema,
  ExecuteTerminalSnippetRequestSchema, TerminalSnippetListResponseSchema,
  AgentSiteSnapshotSchema, CertificateRenewalTaskParametersSchema, CreateCertificateRenewalRequestSchema,
  CreateSitePlanRequestSchema, SiteDeploymentManifestSchema, SiteAccessLogRecordSchema,
  CreateSiteRollbackRequestSchema, SiteRollbackPayloadSchema, SiteRollbackTaskParametersSchema, SiteRollbackTaskResultSchema, SitePlanSchema,
  CreateFileUploadRequestSchema, ResumableFileUploadRecordSchema,
  AgentDatabaseBackupPlanPollResponseSchema, AgentDatabaseOperationUpdateSchema, AgentDatabaseQueryUploadSchema, AgentDatabaseScheduledBackupResultsRequestSchema,
  BusinessDatabaseBackupsPayloadSchema, CreateBusinessDatabaseBackupPlanRequestSchema, CreateDatabaseOperationPlanRequestSchema, DatabaseOperationPlanSchema,
  DatabaseInstancesPayloadSchema, DatabaseSlowQueriesPayloadSchema, ExecuteDatabaseOperationPlanRequestSchema,
  CreateApiTokenRequestSchema, LoginRequestSchema, UpdateUserAccessRequestSchema,
  PermissionSchema,
  AuditExportListResponseSchema, CreateAuditExportRequestSchema,
  CreateFirewallRuleRequestSchema, FirewallRulesPayloadSchema,
  FirewallOpenPortsPayloadSchema,
  CreateDirectoryRequestSchema,
  UpdateNodeCapabilitiesRequestSchema, AuditEventsQuerySchema, AuditEventsResponseSchema,
  AgentCapabilitySchema, AgentCapabilitiesSchema,
  AgentFirewallDenySnapshotSchema, FirewallDenyRecordsPayloadSchema,
  NetworkMeshStatusDataSchema, NetworkMeshPlanResponseSchema, NetworkMeshLinkSchema,
  NetworkCacheStatsSchema, NetworkCachePlanResponseSchema,
} from "@stackpilot/contracts";

test("shared API constants preserve the existing HTTP contract", () => {
  assert.equal(API_CLIENT_PREFIX, "/api");
  assert.deepEqual(API_ROOT_SEGMENTS, ["api", "overview"]);
  assert.deepEqual(WRITE_METHODS, ["POST", "PATCH", "DELETE"]);
});

test("firewall contracts accept bounded UFW rules and reject shell-shaped input", () => {
  const collectedAt = new Date().toISOString();
  const rule = { id: "firewall:11111111-1111-4111-8111-111111111111:ipv4", name: "HTTPS", port: "443", protocol: "tcp", source: "Anywhere", destination: "Anywhere", action: "allow", direction: "in", ipVersion: "ipv4", managed: true, version: "a".repeat(64) };
  assert.equal(FirewallRulesPayloadSchema.safeParse({ engine: "ufw", host: "host-a", active: true, collectedAt, collectionStatus: "complete", warnings: [], rules: [rule] }).success, true);
  assert.equal(CreateFirewallRuleRequestSchema.safeParse({ name: "HTTPS", port: 443, protocol: "tcp", source: "0.0.0.0/0", idempotencyKey: crypto.randomUUID() }).success, true);
  assert.equal(CreateFirewallRuleRequestSchema.safeParse({ name: "bad", port: "443; reboot", protocol: "tcp", source: "any", idempotencyKey: crypto.randomUUID(), command: "ufw allow" }).success, false);
  assert.equal(PermissionSchema.safeParse("firewall:read").success, true); assert.equal(PermissionSchema.safeParse("firewall:operate").success, true);
});
test("firewall deny snapshots and records are bounded, unique and typed", () => {
  const collectedAt = new Date().toISOString();
  const event = { id: `fw_${"a".repeat(64)}`, occurredAt: collectedAt, sourceAddress: "198.51.100.24", destinationAddress: "192.0.2.10", destinationPort: 22, protocol: "TCP", interfaceName: "eth0", rule: "UFW BLOCK", reason: "Host firewall rejected this packet" };
  assert.equal(AgentFirewallDenySnapshotSchema.safeParse({ collectedAt, collectionStatus: "complete", warnings: [], events: [event] }).success, true);
  assert.equal(AgentFirewallDenySnapshotSchema.safeParse({ collectedAt, collectionStatus: "complete", warnings: [], events: [event, event] }).success, false);
  assert.equal(AgentFirewallDenySnapshotSchema.safeParse({ collectedAt, collectionStatus: "complete", warnings: [], events: [{ ...event, sourceAddress: "not-an-ip" }] }).success, false);
  const record = { ...event, id: `${crypto.randomUUID()}:${event.id}`, nodeId: crypto.randomUUID(), nodeName: "firewall-node", sourceCollectedAt: collectedAt };
  assert.equal(FirewallDenyRecordsPayloadSchema.safeParse({ collectedAt, collectionStatus: "complete", warnings: [], records: [record] }).success, true);
  assert.equal(PermissionSchema.safeParse("firewall:read").success, true);
});
test("schedule side effects require bounded idempotency keys", () => {
  const request = { name: "backup", cron: "0 4 * * *", command: "true", idempotencyKey: "schedule-create-1" };
  assert.equal(CreateScheduleJobRequestSchema.safeParse(request).success, true);
  assert.equal(CreateScheduleJobRequestSchema.safeParse({ ...request, idempotencyKey: "short" }).success, false);
  assert.equal(CreateScheduleJobRequestSchema.safeParse({ ...request, idempotencyKey: "invalid key" }).success, false);
});

test("schedule execution records are command-versioned and bounded", () => {
  const execution = { id: crypto.randomUUID(), commandDigest: "a".repeat(64), source: "cron", startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), status: "失败", exitCode: 17, durationMs: 5, output: "partial", error: "failed" };
  assert.equal(ScheduleExecutionSchema.safeParse(execution).success, true);
  assert.equal(ScheduleExecutionSchema.safeParse({ ...execution, commandDigest: "old" }).success, false);
  assert.equal(ScheduleExecutionSchema.safeParse({ ...execution, output: "x".repeat(16_001) }).success, false);
});

test("firewall open-port payload stays strict and backend-owned", () => {
  const payload = { collectedAt: new Date().toISOString(), collectionStatus: "complete", backend: "ss", warnings: [], ports: [{ id: `port_${"a".repeat(24)}`, protocol: "TCP", port: 443, address: "0.0.0.0", source: "0.0.0.0/0", exposure: "public", host: "controller-1" }] };
  assert.equal(FirewallOpenPortsPayloadSchema.safeParse(payload).success, true);
  assert.equal(FirewallOpenPortsPayloadSchema.safeParse({ ...payload, ports: [{ ...payload.ports[0], port: 0 }] }).success, false);
  assert.equal(FirewallOpenPortsPayloadSchema.safeParse({ ...payload, ports: [{ ...payload.ports[0], protocol: "SCTP" }] }).success, false);
  assert.equal(FirewallOpenPortsPayloadSchema.safeParse({ ...payload, clientCollectedAt: payload.collectedAt }).success, false);
});

test("audit export contracts are strict, bounded and limited to implemented formats", () => {
  assert.equal(CreateAuditExportRequestSchema.safeParse({ name: "审计快照", format: "csv" }).success, true);
  assert.equal(CreateAuditExportRequestSchema.safeParse({ name: "审计快照", format: "zip" }).success, false);
  assert.equal(CreateAuditExportRequestSchema.safeParse({ name: "审计快照", format: "json", extra: true }).success, false);
  assert.equal(PermissionSchema.safeParse("audit:export").success, true);
  assert.equal(AuditExportListResponseSchema.safeParse({ exports: [], collectedAt: new Date().toISOString() }).success, true);
});

test("audit payload exposes bounded real events and backend freshness", () => {
  const collectedAt = new Date().toISOString();
  const event = {
    sequence: 1, eventId: crypto.randomUUID(), occurredAt: collectedAt, actorType: "user", actorId: "operator",
    source: "controller", targetType: "file", targetId: "/var/www/index.html", action: "file.upload",
    parameters: "{}", outcome: "success", authorization: "allowed:files:write", requestId: crypto.randomUUID(),
    traceId: crypto.randomUUID(), eventHash: "a".repeat(64),
  };
  assert.equal(AuditEventsResponseSchema.safeParse({ events: [event], collectedAt, total: 1, limit: 200, nextCursor: null }).success, true);
  assert.equal(AuditEventsResponseSchema.safeParse({ events: [event], collectedAt, total: 1 }).success, false);
  assert.equal(AuditEventsResponseSchema.safeParse({ events: [{ ...event, eventHash: "invalid" }], collectedAt, total: 1, limit: 200, nextCursor: null }).success, false);
  assert.deepEqual(AuditEventsQuerySchema.parse({ limit: "1000", beforeSequence: "42", result: "failure", actor: " operator ", source: "database", search: " trace " }), { limit: 1_000, beforeSequence: 42, result: "failure", actor: "operator", source: "database", search: "trace" });
  for (const query of [{ unknown: "value" }, { limit: "0" }, { limit: "1001" }, { beforeSequence: "1.5" }, { result: "failed" }, { actor: " " }]) assert.equal(AuditEventsQuerySchema.safeParse(query).success, false);
});

test("node capability updates accept the complete shared Agent capability set", () => {
  const allowedCapabilities = ["system.summary.read", "database.inventory.read", "database.sql.read", "database.backup", "database.operate", "database.install", "database.restore"];
  assert.deepEqual(UpdateNodeCapabilitiesRequestSchema.parse({ allowedCapabilities }).allowedCapabilities, allowedCapabilities);
  assert.equal(UpdateNodeCapabilitiesRequestSchema.safeParse({ allowedCapabilities: ["database.shell"] }).success, false);
  assert.equal(UpdateNodeCapabilitiesRequestSchema.safeParse({ allowedCapabilities: ["database.backup", "database.backup"] }).success, false);
  const meshCapabilities = ["network.mesh.read", "network.mesh.configure", "network.cache.read", "network.transfer"];
  assert.deepEqual(UpdateNodeCapabilitiesRequestSchema.parse({ allowedCapabilities: meshCapabilities }).allowedCapabilities, meshCapabilities);
  const declaredCapabilities = AgentCapabilitySchema.options;
  assert.deepEqual(AgentCapabilitiesSchema.parse(declaredCapabilities), declaredCapabilities);
  assert.equal(AgentCapabilitiesSchema.safeParse([...declaredCapabilities, meshCapabilities[0]]).success, false);
});

test("remote task history accepts collection timestamps from upgraded Controllers", () => {
  assert.equal(RemoteTaskListResponseSchema.safeParse({ tasks: [], collectedAt: new Date().toISOString() }).success, true);
  assert.equal(RemoteTaskListResponseSchema.safeParse({ tasks: [] }).success, true);
});

test("agent telemetry remains optional and strictly validates bounded snapshots", () => {
  const baseHeartbeat = { nodeId: crypto.randomUUID(), agentVersion: "0.1.0", protocolVersion: "1.0", timestamp: new Date().toISOString(), platform: "linux", capabilities: ["system.summary.read"], health: { status: "healthy", uptimeSeconds: 1 } };
  assert.equal(AgentHeartbeatSchema.safeParse(baseHeartbeat).success, true);
  const telemetry = {
    collectedAt: new Date().toISOString(), hostname: "node-1", primaryIp: "192.0.2.1",
    cpu: { usagePercent: 25.5, coreUsagePercents: [20, 31] },
    memory: { totalBytes: 1024, availableBytes: 512 }, loadAverage: [0.2, 0.3, 0.4],
    disks: [{ label: "/dev/sda1", mount: "/", totalBytes: 2048, usedBytes: 1024 }], uptimeSeconds: 60,
  };
  assert.equal(AgentHeartbeatSchema.safeParse({ ...baseHeartbeat, telemetry }).success, true);
  assert.equal(AgentTelemetrySnapshotSchema.safeParse({ ...telemetry, collectedAt: "2026-07-12" }).success, false);
  assert.equal(AgentTelemetrySnapshotSchema.safeParse({ ...telemetry, secret: "forbidden" }).success, false);
  assert.equal(AgentTelemetrySnapshotSchema.safeParse({ ...telemetry, cpu: { ...telemetry.cpu, extra: true } }).success, false);
  assert.equal(AgentTelemetrySnapshotSchema.safeParse({ ...telemetry, disks: Array.from({ length: 257 }, () => telemetry.disks[0]) }).success, false);
  assert.equal(AgentTelemetrySnapshotSchema.safeParse({ ...telemetry, cpu: { usagePercent: 25, coreUsagePercents: Array(513).fill(25) } }).success, false);
  assert.equal(AgentTelemetrySnapshotSchema.safeParse({ ...telemetry, memory: { totalBytes: 100, availableBytes: 101 } }).success, false);
  assert.equal(AgentTelemetrySnapshotSchema.safeParse({ ...telemetry, disks: [{ ...telemetry.disks[0], usedBytes: 4096 }] }).success, false);
  const unsafeAggregate = [{ ...telemetry.disks[0], totalBytes: Number.MAX_SAFE_INTEGER, usedBytes: Number.MAX_SAFE_INTEGER }, { ...telemetry.disks[0], label: "/dev/sdb1", mount: "/data", totalBytes: 1, usedBytes: 1 }];
  assert.equal(AgentTelemetrySnapshotSchema.safeParse({ ...telemetry, disks: unsafeAggregate }).success, false);
});

test("physical host identity is optional and accepts only opaque versioned hashes", () => {
  const heartbeat = { nodeId: crypto.randomUUID(), agentVersion: "0.2.0", protocolVersion: AGENT_PROTOCOL_VERSION, timestamp: new Date().toISOString(), platform: "linux", capabilities: ["system.summary.read"], health: { status: "healthy", uptimeSeconds: 1 } };
  const physicalHostId = `ph_${"a".repeat(64)}`;
  assert.equal(AgentHeartbeatSchema.safeParse(heartbeat).success, true);
  assert.equal(AgentHeartbeatSchema.safeParse({ ...heartbeat, physicalHostId }).success, true);
  assert.equal(PhysicalHostIdSchema.safeParse(physicalHostId).success, true);
  for (const invalid of ["a".repeat(64), `ph_${"A".repeat(64)}`, `ph_${"a".repeat(63)}`, "/etc/machine-id", "host-1"]) {
    assert.equal(AgentHeartbeatSchema.safeParse({ ...heartbeat, physicalHostId: invalid }).success, false, invalid);
  }
});

test("database inventory is optional on legacy heartbeats and rejects duplicate instance ids", () => {
  const snapshot = { collectedAt: new Date().toISOString(), collectionStatus: "complete", warnings: [], instances: [{ id: "postgresql.service", name: "postgresql", engine: "postgresql", version: null, host: "node-a", port: null, status: "running", source: "systemd:postgresql.service", latencyMs: null, storageBytes: null, activeConnections: null, maxConnections: null, slowQueryCount: null, backupStatus: "unavailable", lastBackupAt: null, accessMode: "unknown", owner: null, region: null, autoBackup: null, remoteAccess: null }] };
  assert.equal(AgentDatabaseSnapshotSchema.safeParse(snapshot).success, false);
  const heartbeat = AgentHeartbeatSchema.safeParse({ nodeId: crypto.randomUUID(), agentVersion: "0.2.0", protocolVersion: "1.0", timestamp: new Date().toISOString(), platform: "linux", capabilities: ["databases.inventory.read"], health: { status: "healthy", uptimeSeconds: 1 }, databaseSnapshot: snapshot });
  assert.equal(heartbeat.success, true);
  if (heartbeat.success) assert.deepEqual(heartbeat.data.databaseSnapshot?.instances[0]?.volumes, []);
  assert.equal(AgentHeartbeatSchema.safeParse({ nodeId: crypto.randomUUID(), agentVersion: "0.2.0", protocolVersion: "1.0", timestamp: new Date().toISOString(), platform: "linux", capabilities: ["databases.inventory.read"], health: { status: "healthy", uptimeSeconds: 1 }, databaseSnapshot: { ...snapshot, instances: [snapshot.instances[0], snapshot.instances[0]] } }).success, false);
});

test("database instance payload exposes scoped records with strict freshness fields", () => {
  const collectedAt = new Date().toISOString();
  const instance = {
    id: `database-${"a".repeat(32)}`, nodeId: crypto.randomUUID(), nodeName: "database-node", address: "192.0.2.10",
    collectedAt, freshness: "current", name: "postgresql", engine: "postgresql", version: "16.9", host: "database-node",
    port: 5432, status: "running", source: "systemd:postgresql.service", managed: false, historicalSlowQueriesAvailable: false, latencyMs: null, storageBytes: null,
    activeConnections: null, maxConnections: null, slowQueryCount: null, backupStatus: "unavailable", lastBackupAt: null,
    accessMode: "unknown", owner: null, region: null, autoBackup: null, remoteAccess: null, volumes: [],
  };
  const payload = { collectedAt, collectionStatus: "complete", warnings: [], instances: [instance] };
  assert.equal(DatabaseInstancesPayloadSchema.safeParse(payload).success, true);
  assert.equal(DatabaseInstancesPayloadSchema.safeParse({ ...payload, instances: [{ ...instance, freshness: "unknown" }] }).success, false);
  assert.equal(DatabaseInstancesPayloadSchema.safeParse({ ...payload, clientCollectedAt: collectedAt }).success, false);
});

test("host monitoring contract preserves raw nullable metrics", () => {
  const host = { id: "controller-local", source: "controller", name: "controller", platform: "linux", address: null, environment: "未分类", owner: "未分配", connectionStatus: "local", healthStatus: "unknown", telemetryFreshness: "current", telemetryCollectedAt: null, lastSeenAt: null, cpuPercent: null, memory: null, disk: null, uptimeSeconds: null, backup: null, services: [], version: "0.2.0", latency: null, updateStatus: null };
  assert.equal(HostMonitoringRecordSchema.safeParse(host).success, true);
  assert.equal(HostMonitoringRecordSchema.safeParse({ ...host, memory: { totalBytes: 100, usedBytes: 101, percent: 50 } }).success, false);
  assert.equal(HostMonitoringRecordSchema.safeParse({ ...host, cpuPercent: 101 }).success, false);
});

test("site runtime contract keeps collection provenance and nullable measurements explicit", () => {
  const payload = { collectedAt: new Date().toISOString(), collectionStatus: "partial", warnings: ["one unreadable config"], sites: [{
    id: "nginx-site", nodeId: "node-local", domain: "app.example.com", status: "running", runtime: "反向代理", host: "controller-1",
    upstream: "http://127.0.0.1:3000", source: "Nginx · app.conf", latencyMs: 12,
    trafficBytes: null, collectedAt: new Date().toISOString(), freshness: "current",
    certificate: { status: "unavailable", notBefore: null, expiresAt: null, issuer: null, subjectAlternativeNames: [], fingerprintSha256: null, renewalMode: "unsupported", renewable: false, unavailableReason: "未配置 TLS", certificateId: null },
    renewal: { batchId: null, taskId: null, status: "idle", message: null, updatedAt: null },
  }] };
  assert.equal(SiteRuntimePayloadSchema.safeParse(payload).success, true);
  assert.equal(SiteRuntimePayloadSchema.safeParse({ ...payload, clientCollectedAt: payload.collectedAt }).success, false);
  assert.equal(SiteRuntimePayloadSchema.safeParse({ ...payload, sites: [{ ...payload.sites[0], latencyMs: -1 }] }).success, false);
});

test("certificate renewal contracts reject generic commands, paths and duplicate ids", () => {
  const snapshot = { collectedAt: new Date().toISOString(), collectionStatus: "complete", warnings: [], sites: [{
    id: "site-opaque-1", domain: "app.example.com", status: "running", runtime: "Nginx", host: "node-1", upstream: null,
    source: "Nginx", latencyMs: 3, trafficBytes: null,
    certificate: { status: "critical", notBefore: new Date().toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString(), issuer: "Test CA", subjectAlternativeNames: ["app.example.com"], fingerprintSha256: "A".repeat(64), renewalMode: "automatic", renewable: true, unavailableReason: null, certificateId: "certificate-opaque-1" },
  }] };
  assert.equal(AgentSiteSnapshotSchema.safeParse(snapshot).success, true);
  assert.equal(AgentSiteSnapshotSchema.safeParse({ ...snapshot, sites: [...snapshot.sites, snapshot.sites[0]] }).success, false);
  assert.equal(CreateCertificateRenewalRequestSchema.safeParse({ siteIds: ["site-opaque-1", "site-opaque-1"], idempotencyKey: "renewal-123" }).success, false);
  const parameters = { batchId: crypto.randomUUID(), certificates: [{ certificateId: "certificate-opaque-1", siteIds: ["site-opaque-1"] }] };
  assert.equal(CertificateRenewalTaskParametersSchema.safeParse(parameters).success, true);
  assert.equal(CertificateRenewalTaskParametersSchema.safeParse({ ...parameters, command: "certbot renew" }).success, false);
  assert.equal(CertificateRenewalTaskParametersSchema.safeParse({ ...parameters, certificates: [{ certificateId: "/etc/letsencrypt/live/app", siteIds: ["site-opaque-1"] }] }).success, false);
});

test("site management contracts accept declarative public deployments and reject command or path injection", () => {
  const request = {
    nodeId: "node-local", domains: ["app.example.com"], repositoryUrl: "https://github.com/example/project.git",
    repositoryRef: "main", certificateEmail: "operator@example.com",
    environmentVariables: [{ name: "API_MODE", value: "production" }], idempotencyKey: "site-plan-001",
  };
  assert.equal(CreateSitePlanRequestSchema.parse(request).deploymentEnvironment, "production");
  assert.equal(CreateSitePlanRequestSchema.safeParse({ ...request, deploymentEnvironment: "staging" }).success, true);
  assert.equal(CreateSitePlanRequestSchema.safeParse({ ...request, deploymentEnvironment: "development" }).success, false);
  assert.equal(CreateSitePlanRequestSchema.safeParse({ ...request, repositoryUrl: "ssh://github.com/example/project.git" }).success, false);
  assert.equal(CreateSitePlanRequestSchema.safeParse({ ...request, repositoryUrl: "https://user:secret@github.com/example/project.git" }).success, false);
  assert.equal(CreateSitePlanRequestSchema.safeParse({ ...request, repositoryUrl: "https://192.0.2.10/example/project.git" }).success, false);
  assert.equal(CreateSitePlanRequestSchema.safeParse({ ...request, command: "curl example.com | sh" }).success, false);
  assert.equal(CreateSitePlanRequestSchema.safeParse({ ...request, repositoryRef: "../private" }).success, false);
  assert.equal(SiteDeploymentManifestSchema.safeParse({ schemaVersion: 1, runtime: "static", outputDirectory: "dist" }).success, true);
  assert.equal(SiteDeploymentManifestSchema.safeParse({ schemaVersion: 1, runtime: "node22", startScript: "start", healthCheckPath: "/healthz" }).success, true);
  assert.equal(SiteDeploymentManifestSchema.safeParse({ schemaVersion: 1, runtime: "static", outputDirectory: "/srv/www", command: "npm run build" }).success, false);
  assert.equal(SiteDeploymentManifestSchema.safeParse({ schemaVersion: 1, runtime: "static", outputDirectory: "../private" }).success, false);
  const log = { timestamp: new Date().toISOString(), method: "GET", path: "/healthz", status: 200, bytesSent: 42, clientAddressMasked: "192.0.2.0/24" };
  assert.equal(SiteAccessLogRecordSchema.safeParse(log).success, true);
  assert.equal(SiteAccessLogRecordSchema.safeParse({ ...log, path: "/callback?token=secret" }).success, false);
  assert.equal(SiteAccessLogRecordSchema.safeParse({ ...log, authorization: "secret" }).success, false);
});

test("site rollback contracts are strict and preserve backend-owned records", () => {
  const request = { targetReleaseId: "release_target_001", expectedSiteVersion: 3, reason: "Restore stable release", idempotencyKey: "rollback-request-001" };
  assert.equal(CreateSiteRollbackRequestSchema.safeParse(request).success, true);
  assert.equal(CreateSiteRollbackRequestSchema.safeParse({ ...request, command: "ln -s release" }).success, false);
  const operationId = crypto.randomUUID(); const siteId = "site-rollback-001";
  assert.equal(SiteRollbackTaskParametersSchema.safeParse({ operationId, siteId, targetPlanId: crypto.randomUUID(), targetReleaseId: request.targetReleaseId, expectedVersion: 3 }).success, true);
  assert.equal(SiteRollbackTaskResultSchema.safeParse({ operationId, siteId, releaseId: request.targetReleaseId, version: 4 }).success, true);
  const now = new Date().toISOString();
  const record = { id: "release_target_001", siteId, nodeId: "node-local", domain: "app.example.com", currentReleaseId: "release_current_001", targetReleaseId: request.targetReleaseId, targetPlanId: crypto.randomUUID(), repositoryRef: "main", status: "available", requestedBy: null, reason: null, createdAt: now, updatedAt: now, progressPercent: 0, errorCode: null, siteVersion: 3 };
  assert.equal(SiteRollbackPayloadSchema.safeParse({ collectedAt: now, rollbacks: [record] }).success, true);
  assert.equal(SiteRollbackPayloadSchema.safeParse({ collectedAt: now, rollbacks: [{ ...record, logs: ["invented"] }] }).success, false);
});

test("site plans require an explicit persisted deployment environment", () => {
  const createdAt = "2026-07-15T00:00:00.000Z";
  const plan = {
    planId: "11111111-1111-4111-8111-111111111111", nodeId: "node-contract-01",
    domains: ["app.example.com"], repositoryUrl: "https://github.com/example/project.git", repositoryRef: "main",
    certificateEnvironment: "production", environmentVariableNames: [], operator: null, status: "queued",
    digest: "a".repeat(64), version: 1, preview: null, operationId: "22222222-2222-4222-8222-222222222222",
    createdAt, updatedAt: createdAt, expiresAt: "2026-07-15T00:30:00.000Z",
  };
  assert.equal(SitePlanSchema.safeParse(plan).success, false);
  assert.equal(SitePlanSchema.safeParse({ ...plan, deploymentEnvironment: "staging" }).success, true);
});

test("deployment workbench contract keeps backend freshness and stable identities", async () => {
  const { DeploymentPayloadSchema } = await import("@stackpilot/contracts");
  const collectedAt = new Date().toISOString();
  const deployment = { id: crypto.randomUUID(), planId: crypto.randomUUID(), operationId: crypto.randomUUID(), nodeId: "node-production-01", siteId: "site-production-01", domains: ["app.example.com"], repositoryUrl: "https://github.com/example/project.git", repositoryRef: "main", environment: "production", certificateEnvironment: "production", runtime: "node22", healthCheckPath: "/healthz", status: "succeeded", stage: "complete", progressPercent: 100, errorCode: null, releaseId: "release-example-01", operator: "Operator", createdAt: collectedAt, updatedAt: collectedAt };
  const release = { releaseId: "release-example-01", siteId: "site-production-01", planId: deployment.planId, nodeId: deployment.nodeId, domains: deployment.domains, repositoryRef: "main", environment: "production", status: "active", createdAt: collectedAt, activatedAt: collectedAt };
  assert.equal(DeploymentPayloadSchema.safeParse({ collectedAt, deployments: [deployment], releases: [release] }).success, true);
  assert.equal(DeploymentPayloadSchema.safeParse({ collectedAt, deployments: [deployment, deployment], releases: [] }).success, false);
  assert.equal(DeploymentPayloadSchema.safeParse({ collectedAt, clientCollectedAt: collectedAt, deployments: [], releases: [] }).success, false);
});

test("database slow-query contract preserves nullable historical statistics", () => {
  const collectedAt = new Date().toISOString();
  const payload = { collectedAt, collectionStatus: "complete", warnings: [], thresholdMs: 1_000,
    instances: [{ id: "postgres-orders", name: "orders", engine: "PostgreSQL 16", host: "Controller 本机", port: 5432, activeConnections: 3, slowQueryCount: 1, collectedAt }],
    queries: [{ id: "query-1", instanceId: "postgres-orders", database: "orders", fingerprint: "pg-1", sql: "SELECT ?", durationMs: 1_250, calls: null, p95Ms: null, rowsExamined: null, risk: "low", state: "active", owner: "reader", startedAt: collectedAt, lastSeenAt: collectedAt, sessionId: "91", waitEvent: null }] };
  assert.equal(DatabaseSlowQueriesPayloadSchema.safeParse(payload).success, true);
  assert.equal(DatabaseSlowQueriesPayloadSchema.safeParse({ ...payload, thresholdMs: 0 }).success, false);
  assert.equal(DatabaseSlowQueriesPayloadSchema.safeParse({ ...payload, queries: [{ ...payload.queries[0], sql: "x".repeat(2_001) }] }).success, false);
});

test("database contracts strictly validate inventory, SQL uploads, backups and two-phase operations", () => {
  const collectedAt = new Date().toISOString();
  const instance = { id:"postgres-main",name:"main",engine:"postgresql",version:"16.9",host:"db-1",port:5432,status:"running",source:"postgresql",managed:false,historicalSlowQueriesAvailable:false,latencyMs:3,storageBytes:1024,activeConnections:2,maxConnections:100,slowQueryCount:1,backupStatus:"unavailable",lastBackupAt:null,accessMode:"read-write",owner:null,region:null,autoBackup:false,remoteAccess:true,volumes:[] };
  assert.equal(AgentDatabaseSnapshotSchema.safeParse({collectedAt,collectionStatus:"complete",warnings:[],instances:[instance]}).success,true);
  assert.equal(AgentDatabaseSnapshotSchema.safeParse({collectedAt,collectionStatus:"complete",warnings:[],instances:[instance],password:"forbidden"}).success,false);
  const query={id:"q-1",instanceLocalId:"postgres-main",database:"app",fingerprint:"fp-1",sql:"SELECT * FROM t",durationMs:2000,calls:null,p95Ms:null,rowsExamined:null,risk:"low",state:"active",owner:"app",startedAt:collectedAt,lastSeenAt:collectedAt,sessionId:"12",waitEvent:null,historical:false};
  assert.equal(AgentDatabaseQueryUploadSchema.safeParse({collectedAt,collectionStatus:"complete",warnings:[],sessions:[],queries:[query]}).success,true);
  assert.equal(AgentDatabaseQueryUploadSchema.safeParse({collectedAt,collectionStatus:"complete",warnings:[],sessions:[],queries:[{...query,sql:"x".repeat(2001)}]}).success,false);
  assert.equal(BusinessDatabaseBackupsPayloadSchema.safeParse({collectedAt,collectionStatus:"complete",warnings:[],plans:[],jobs:[],restorePoints:[]}).success,true);
  assert.equal(CreateBusinessDatabaseBackupPlanRequestSchema.safeParse({instanceId:"database-"+"a".repeat(32),name:"bad",cron:"@daily",retentionCount:7,enabled:true}).success,false);
  const nodeId=crypto.randomUUID();
  assert.equal(CreateDatabaseOperationPlanRequestSchema.safeParse({kind:"install",nodeId,engine:"postgresql",name:"app",port:null,initialDatabase:"app",credentialPublicKey:"x".repeat(64)}).success,true);
  assert.equal(CreateDatabaseOperationPlanRequestSchema.safeParse({kind:"create-index",instanceId:"database-"+"a".repeat(32),queryId:"q",table:"users;drop",columns:["email"]}).success,false);
  const plan={id:crypto.randomUUID(),kind:"install",nodeId,instanceId:null,target:"postgresql / app",impact:["public listener"],version:1,expiresAt:new Date(Date.now()+60_000).toISOString(),createdAt:collectedAt,executedAt:null};
  assert.equal(DatabaseOperationPlanSchema.safeParse(plan).success,true);
  assert.equal(ExecuteDatabaseOperationPlanRequestSchema.safeParse({planId:plan.id,version:1,idempotencyKey:"execute-001"}).success,true);
  assert.equal(AgentDatabaseOperationUpdateSchema.safeParse({operationId:crypto.randomUUID(),version:1,status:"failed",errorCode:null,errorMessage:"failed",credentialEnvelope:null,updatedAt:collectedAt}).success,false);
  const backupPlan={id:crypto.randomUUID(),instanceLocalId:"orders",cron:"0 2 * * *",retentionCount:7,enabled:true,version:1,updatedAt:collectedAt};
  assert.equal(AgentDatabaseBackupPlanPollResponseSchema.safeParse({plans:[backupPlan,{...backupPlan}],controllerTime:collectedAt}).success,false);
  const report={reportId:crypto.randomUUID(),planId:backupPlan.id,planVersion:1,instanceLocalId:"orders",scheduledFor:collectedAt,status:"failed",result:null,errorCode:"BACKUP_FAILED",completedAt:collectedAt};
  assert.equal(AgentDatabaseScheduledBackupResultsRequestSchema.safeParse({reports:[report,{...report}]}).success,false);
});

test("identity schemas reject privilege fields and invalid node scopes", () => {
  assert.equal(LoginRequestSchema.safeParse({ username: "admin", password: "password", role: "administrator" }).success, false);
  assert.equal(CreateApiTokenRequestSchema.safeParse({ name: "reader", permissions: ["overview:read"], nodeScope: "all", expiresAt: null }).success, true);
  assert.equal(CreateApiTokenRequestSchema.safeParse({ name: "bad", permissions: ["unknown:permission"], nodeScope: "all", expiresAt: null }).success, false);
  assert.equal(UpdateUserAccessRequestSchema.safeParse({ roleIds: ["operator"], nodeScope: ["not-a-uuid"], disabled: false }).success, false);
  assert.equal(PermissionSchema.safeParse("databases:read").success, true);
  assert.equal(PermissionSchema.safeParse("files:delete").success, true);
  assert.equal(PermissionSchema.safeParse("terminal:read").success, true);
  assert.equal(PermissionSchema.safeParse("terminal:execute").success, true);
});

test("file upload contracts reject paths and inconsistent progress", () => {
  const request = { fileName: "artifact.zip", targetDirectory: "releases/2026", sizeBytes: 10, contentType: "application/zip", idempotencyKey: "upload-001" };
  assert.equal(CreateFileUploadRequestSchema.safeParse(request).success, true);
  for (const targetDirectory of ["/etc", "../etc", "safe/../etc", "safe//etc", "safe\\etc"]) assert.equal(CreateFileUploadRequestSchema.safeParse({ ...request, targetDirectory }).success, false);
  assert.equal(CreateFileUploadRequestSchema.safeParse({ ...request, fileName: "../secret" }).success, false);
  assert.equal(CreateFileUploadRequestSchema.safeParse({ ...request, sizeBytes: 0 }).success, true);
  const record = { id: crypto.randomUUID(), fileName: request.fileName, targetDirectory: request.targetDirectory, targetPath: "releases/2026/artifact.zip", sizeBytes: request.sizeBytes, contentType: request.contentType, receivedBytes: 10, status: "completed", owner: "Admin", sha256: "a".repeat(64), errorMessage: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), completedAt: new Date().toISOString() };
  assert.equal(ResumableFileUploadRecordSchema.safeParse(record).success, true);
  assert.equal(ResumableFileUploadRecordSchema.safeParse({ ...record, receivedBytes: 9 }).success, false);
});

test("agent protocol schemas reject incompatible and generic command tasks", () => {
  assert.equal(AGENT_PROTOCOL_VERSION, "1.1");
  assert.equal(isAgentProtocolCompatible("1.0"), true);
  assert.equal(isAgentProtocolCompatible("1.1"), true);
  assert.equal(isAgentProtocolCompatible("1.9"), false);
  assert.equal(isAgentProtocolCompatible("2.0"), false);
  assert.equal(CreateRemoteTaskRequestSchema.safeParse({ type: "run-shell", parameters: { command: "id" }, expiresInSeconds: 60, idempotencyKey: "generic-command" }).success, false);
  const terminal = (parameters) => ({ type: "terminal.command.execute", parameters, expiresInSeconds: 30, idempotencyKey: "terminal-command-1" });
  for (const parameters of [{ command: "disk-usage" }, { command: "uptime" }, { command: "top-summary" }, { command: "service-status", serviceName: "nginx.service" }]) {
    assert.equal(CreateRemoteTaskRequestSchema.safeParse(terminal(parameters)).success, true);
  }
  for (const parameters of [{ command: "id" }, { command: "uptime", args: ["--version"] }, { command: "service-status", serviceName: "nginx;id" }, { command: "service-status", serviceName: "-H" }, { command: "service-status", serviceName: "nginx.service", shell: true }]) {
    assert.equal(CreateRemoteTaskRequestSchema.safeParse(terminal(parameters)).success, false);
  }
  assert.equal(AgentHeartbeatSchema.safeParse({ nodeId: crypto.randomUUID(), agentVersion: "0.1.0", protocolVersion: "1.0", timestamp: new Date().toISOString(), platform: "linux", capabilities: ["system.summary.read"], health: { status: "healthy", uptimeSeconds: 1 }, token: "forbidden" }).success, false);
});

test("shared schemas validate external request and error contracts at runtime", () => {
  assert.equal(PathIdSchema.safeParse("node-local").success, true);
  assert.equal(PathIdSchema.safeParse("../node").success, false);
  assert.equal(CreateScheduleJobRequestSchema.safeParse({ name: "backup", cron: "0 4 * * *", command: "true", extra: true }).success, false);
  assert.equal(SchedulePayloadSchema.safeParse({ jobs: [], scannedAt: new Date().toISOString(), writeEnabled: false }).success, true);
  assert.equal(SchedulePayloadSchema.safeParse({ jobs: [], scannedAt: new Date().toISOString() }).success, false);
  const execution = { id: crypto.randomUUID(), commandDigest: "a".repeat(64), source: "cron", startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), status: "成功", exitCode: 0, durationMs: 5, output: "done", error: "" };
  assert.equal(SchedulePayloadSchema.safeParse({ jobs: [{ id: "backup", name: "backup", cron: "0 4 * * *", command: "true", enabled: true, nextRun: "2026-07-16T04:00:00.000Z", nextRunAt: "2026-07-16T04:00:00.000Z", lastRun: execution.startedAt, result: "成功", lastExecution: execution }], scannedAt: new Date().toISOString(), writeEnabled: false }).success, true);
  assert.equal(SchedulePayloadSchema.safeParse({ jobs: [{ id: "backup", name: "backup", cron: "0 4 * * *", command: "true", enabled: false, nextRun: "停用", nextRunAt: "2026-07-16T04:00:00.000Z", lastRun: "未运行", result: "未运行", lastExecution: null }], scannedAt: new Date().toISOString(), writeEnabled: false }).success, false);
  assert.equal(SchedulePayloadSchema.safeParse({ jobs: [{ id: "backup", name: "backup", cron: "0 4 * * *", command: "true", enabled: true, nextRun: "时间暂不可用", lastRun: "未运行", result: "未运行", lastExecution: null }], scannedAt: new Date().toISOString(), writeEnabled: false }).success, false);
  assert.equal(ApiErrorResponseSchema.safeParse({ code: "BAD_REQUEST", error: "invalid", requestId: "request-1" }).success, true);
  assert.equal(ApiErrorResponseSchema.safeParse({ code: "REAUTHENTICATION_FAILED", error: "重新认证失败", requestId: "request-2" }).success, true);
  assert.equal(OverviewSummaryPayloadSchema.safeParse({}).success, false);
});

test("terminal snippet contracts reject browser-supplied commands", () => {
  const now = new Date().toISOString();
  assert.equal(TerminalSnippetListResponseSchema.safeParse({ collectedAt: now, snippets: [{ id: "system-summary", version: 1, title: "Summary", command: "df -h", category: "resource", risk: "read", description: "Read resources", favorite: false, lastUsedAt: null, executable: true, requiredCapability: "system.summary.read" }] }).success, true);
  const request = { nodeId: crypto.randomUUID(), snippetVersion: 1, idempotencyKey: "terminal-contract-1" };
  assert.equal(ExecuteTerminalSnippetRequestSchema.safeParse(request).success, true);
  assert.equal(ExecuteTerminalSnippetRequestSchema.safeParse({ ...request, command: "id" }).success, false);
});

test("mesh status contracts reject non-overlay peers and command-shaped parameters", () => {
  const key = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
  const now = new Date().toISOString();
  const peer = { publicKey: key, overlayAddress: "100.64.0.2", endpoint: "203.0.113.7:51820", latestHandshakeAt: now, handshakeAgeSeconds: 5, receivedBytes: 1, sentBytes: 2 };
  const data = { collectedAt: now, collectionStatus: "complete", warnings: [], interface: { name: "wg0", present: true, listenPort: 51820, mtu: 1420, publicKey: key, peerCount: 1 }, peers: [peer], firewall: { enforced: true, dataPlanePort: 18_080 } };
  assert.equal(NetworkMeshStatusDataSchema.safeParse(data).success, true);
  assert.equal(NetworkMeshStatusDataSchema.safeParse({ ...data, peers: [{ ...peer, overlayAddress: "10.8.0.2" }] }).success, false);
  assert.equal(NetworkMeshStatusDataSchema.safeParse({ ...data, peers: [{ ...peer, publicKey: "short" }] }).success, false);
  assert.equal(NetworkMeshStatusDataSchema.safeParse({ ...data, interface: { ...data.interface, listenPort: 0 } }).success, false);
  assert.equal(NetworkMeshStatusDataSchema.safeParse({ ...data, collectionStatus: "stale" }).success, false);
  // A helper upgraded ahead of the Agent omits `firewall`; the Agent then reports null.
  assert.equal(NetworkMeshStatusDataSchema.safeParse({ ...data, firewall: undefined }).success, true);
  assert.equal(NetworkMeshStatusDataSchema.safeParse({ ...data, firewall: null }).success, true);
  assert.equal(NetworkMeshStatusDataSchema.safeParse({ ...data, firewall: { enforced: true, dataPlanePort: 0 } }).success, false);
  const request = { type: "network.mesh.status.read", parameters: {}, expiresInSeconds: 30, idempotencyKey: "mesh-status-1" };
  assert.equal(CreateRemoteTaskRequestSchema.safeParse(request).success, true);
  assert.equal(CreateRemoteTaskRequestSchema.safeParse({ ...request, parameters: { path: "/etc/wireguard/wg0.conf" } }).success, false);
  assert.equal(CreateRemoteTaskRequestSchema.safeParse({ ...request, parameters: { command: "wg show" } }).success, false);
});

test("cache contracts keep the fill request narrow and the plan honest about unreported nodes", () => {
  const updatedAt = new Date().toISOString();
  const stats = { collectedAt: updatedAt, capacityBytes: 5 * 1024 ** 3, usedBytes: 1024 ** 3, entryCount: 3, hits: 4, misses: 2, evictions: 1, diskFreeBytes: 8 * 1024 ** 3 };
  assert.equal(NetworkCacheStatsSchema.safeParse(stats).success, true);
  assert.equal(NetworkCacheStatsSchema.safeParse({ ...stats, diskFreeBytes: null }).success, true);
  assert.equal(NetworkCacheStatsSchema.safeParse({ ...stats, usedBytes: -1 }).success, false);
  assert.equal(NetworkCacheStatsSchema.safeParse({ ...stats, collectedAt: "yesterday" }).success, false);
  const node = { nodeId: "11111111-1111-4111-8111-111111111111", nodeName: "edge-a", status: "ready", stats };
  const plan = { updatedAt, nodes: [node, { ...node, nodeName: "edge-b", status: "pending", stats: null }], warnings: [] };
  assert.equal(NetworkCachePlanResponseSchema.safeParse(plan).success, true);
  assert.equal(NetworkCachePlanResponseSchema.safeParse({ ...plan, nodes: [{ ...node, status: "warming" }] }).success, false);
  assert.equal(NetworkCachePlanResponseSchema.safeParse({ ...plan, nodes: [{ ...node, stats: null }] }).success, true);
  const request = { type: "network.cache.fetch", parameters: { url: "https://example.com/layer.tgz" }, idempotencyKey: "cache-fill-1" };
  assert.equal(CreateRemoteTaskRequestSchema.parse(request).expiresInSeconds, 900);
  for (const parameters of [{ url: "http://example.com/a" }, { url: "https://example.com/a", destination: "/opt/a" }, { url: "https://example.com/a", digest: "abc" }]) {
    assert.equal(CreateRemoteTaskRequestSchema.safeParse({ ...request, parameters }).success, false, JSON.stringify(parameters));
  }
});

test("a plan or link from an older peer still parses without the interface up field", () => {
  const updatedAt = new Date().toISOString();
  const node = {
    nodeId: "11111111-1111-4111-8111-111111111111", nodeName: "edge-a", status: "ready",
    overlayAddress: "100.64.1.4", publicKey: null, configuredRevision: 1,
    handshake: { collectedAt: updatedAt, ageSeconds: 5, peerCount: 1, activePeerCount: 1 },
    firewallEnforced: true, dataPlanePort: 18_080,
  };
  const plan = { revision: 1, overlayCidr: "100.64.0.0/10", listenPort: 51_820, updatedAt, nodes: [node], warnings: [] };
  // A Web build that leads its Controller must degrade, not fail the whole page on a ZodError.
  assert.equal(NetworkMeshPlanResponseSchema.safeParse(plan).success, true);
  assert.equal(NetworkMeshPlanResponseSchema.safeParse({ ...plan, nodes: [{ ...node, interfaceUp: null }] }).success, true);
  assert.equal(NetworkMeshPlanResponseSchema.safeParse({ ...plan, nodes: [{ ...node, interfaceUp: false }] }).success, true);
  assert.equal(NetworkMeshPlanResponseSchema.safeParse({ ...plan, nodes: [{ ...node, interfaceUp: "up" }] }).success, false);
  const link = { collectedAt: updatedAt, peerCount: 1, activePeerCount: 1, latestHandshakeAt: updatedAt };
  assert.equal(NetworkMeshLinkSchema.safeParse(link).success, true);
  assert.equal(NetworkMeshLinkSchema.safeParse({ ...link, interfaceUp: false }).success, true);
});

test("file contracts reject unsafe names and non-virtual paths",()=>{
  assert.equal(CreateDirectoryRequestSchema.safeParse({parentPath:"/var/www",name:"site"}).success,true);
  assert.equal(CreateDirectoryRequestSchema.safeParse({parentPath:"../www",name:"site"}).success,false);
  for(const name of [".","..","nested/name","nested\\name","bad\0name"])assert.equal(CreateDirectoryRequestSchema.safeParse({parentPath:"/",name}).success,false,name);
  assert.equal(CreateDirectoryRequestSchema.safeParse({parentPath:"/var/www",name:"site",mode:"0777"}).success,false);
});
