import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import test from "node:test";
import { NginxSiteCollector } from "../../apps/controller/dist/platform/siteCollector.js";
import { SiteMonitoringService } from "../../apps/controller/dist/modules/sites/siteMonitoringService.js";
import { publicSiteId } from "../../apps/controller/dist/modules/sites/siteMonitoringService.js";
import { CertificateRenewalService } from "../../apps/controller/dist/modules/sites/certificateRenewalService.js";
import { SiteManagementService } from "../../apps/controller/dist/modules/sites/siteManagementService.js";
import { MemorySiteManagementRepository } from "../../apps/controller/dist/modules/sites/siteManagementRepository.js";
import { createControllerServices } from "../../apps/controller/dist/app.js";
import { createStackPilotServer } from "../../apps/controller/dist/server.js";
import { loadControllerConfig } from "../../apps/controller/dist/config/environment.js";
import { openDatabase } from "../../apps/controller/dist/database/database.js";
import { IdentityService } from "../../apps/controller/dist/identity/identityService.js";
import { MemoryAgentControlRepository } from "../../apps/controller/dist/repositories/agentControlRepository.js";
import { FakePlatformAdapter } from "./support/fakePlatform.js";

const collectedAt = "2026-07-13T00:00:00.000Z";
const probe = async (_domain, listeners) => ({
  status: listeners.some((listener) => listener.secure) ? "running" : "warning",
  latencyMs: 12,
  certificate: listeners.some((listener) => listener.secure)
    ? { status: "valid", notBefore: "2026-01-01T00:00:00.000Z", expiresAt: "2026-09-01T00:00:00.000Z", issuer: "Test CA", subjectAlternativeNames: [], fingerprintSha256: null, renewalMode: "unsupported", renewable: false, unavailableReason: "helper unavailable", certificateId: null }
    : { status: "unavailable", notBefore: null, expiresAt: null, issuer: null, subjectAlternativeNames: [], fingerprintSha256: null, renewalMode: "unsupported", renewable: false, unavailableReason: "no tls", certificateId: null },
});

test("Nginx site collector discovers, merges and probes real virtual hosts without fixtures", async () => {
  const root = await mkdtemp(join(tmpdir(), "stackpilot-sites-"));
  try {
    await writeFile(join(root, "sites.conf"), `
      server { listen 80; server_name app.example.com; proxy_pass http://127.0.0.1:3000/private?token=hidden; }
      server { listen 443 ssl; server_name app.example.com docs.example.com; root /srv/www; }
      server { listen 80; server_name dynamic.example.com; proxy_pass http://$backend/private; }
      server { listen 80; server_name dashboard.example.com; root /var/www/acme; }
      server { listen 443 ssl; server_name dashboard.example.com; proxy_pass http://127.0.0.1:9191; }
      server { listen 80; server_name _ $host ~^regex; }
    `);
    await writeFile(join(root, "stale.conf.bak"), "server { listen 80; server_name stale.example.com; }");
    const payload = await new NginxSiteCollector([root], probe, "controller-1").collectSites();
    assert.equal(payload.collectionStatus, "complete");
    assert.deepEqual(payload.sites.map((site) => site.domain), ["app.example.com", "dashboard.example.com", "docs.example.com", "dynamic.example.com"]);
    assert.equal(payload.sites[0].status, "running");
    assert.equal(payload.sites[0].upstream, "http://127.0.0.1:3000/private");
    assert.equal(payload.sites[0].certificate.issuer, "Test CA");
    assert.equal(payload.sites[1].runtime, "反向代理");
    assert.equal(payload.sites[1].upstream, "http://127.0.0.1:9191");
    assert.equal(payload.sites[2].runtime, "Nginx 静态");
    assert.equal(payload.sites[2].host, "controller-1");
    assert.equal(payload.sites[2].trafficBytes, null);
    assert.equal(payload.sites[3].upstream, "动态上游");
    assert.equal(payload.sites.some((site) => site.domain === "stale.example.com"), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Nginx site collector reports unavailable sources instead of demo sites", async () => {
  const payload = await new NginxSiteCollector([join(tmpdir(), "stackpilot-missing-sites")], probe).collectSites();
  assert.equal(payload.collectionStatus, "unavailable");
  assert.deepEqual(payload.sites, []);
  assert.equal(payload.warnings.length, 1);
});

test("Controller local collector exposes a renewable opaque Certbot identity only when helper is ready", async () => {
  const root = await mkdtemp(join(tmpdir(), "stackpilot-local-cert-"));
  try {
    await writeFile(join(root, "site.conf"), `
      server { listen 80; server_name local.example.com; }
      server { listen 443 ssl; server_name local.example.com; ssl_certificate /etc/letsencrypt/live/local.example.com/fullchain.pem; }
    `);
    const certificate = { ...(await probe("local.example.com", [{ port: 443, secure: true }])).certificate, renewalMode: "automatic", renewable: true, unavailableReason: null, certificateId: `cert_${"a".repeat(32)}` };
    const sourceId = `source_${(await import("node:crypto")).createHash("sha256").update("public-certificate:/etc/letsencrypt/live/local.example.com/fullchain.pem").digest("hex").slice(0, 32)}`;
    const payload = await new NginxSiteCollector([root], probe, "controller", async () => new Map([[sourceId, certificate]])).collectSites();
    assert.equal(payload.sites[0].certificate.renewable, true);
    assert.match(payload.sites[0].certificate.certificateId, /^cert_[a-f0-9]{32}$/);
    assert.doesNotMatch(JSON.stringify(payload), /\/etc\/letsencrypt|fullchain\.pem/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("site monitoring service coalesces and caches collection", async () => {
  let calls = 0;
  const collector = { collectSites: async () => { calls += 1; return { collectedAt, collectionStatus: "complete", warnings: [], sites: [] }; } };
  const service = new SiteMonitoringService(collector, 10_000);
  await Promise.all([service.getSites(), service.getSites()]);
  await service.getSites();
  assert.equal(calls, 1);
});

test("site monitoring startup refreshes in the background while GET reads the saved snapshot", async () => {
  let calls = 0;
  const collector = { collectSites: async () => ({ collectedAt: new Date().toISOString(), collectionStatus: "complete", warnings: [], sites: [{
    id: "local-site", nodeId: "node-local", domain: `site-${++calls}.example.com`, status: "running", runtime: "Nginx", host: "controller", upstream: null,
    source: "Nginx", latencyMs: 1, trafficBytes: null, collectedAt: new Date().toISOString(), freshness: "current",
    certificate: { status: "unavailable", notBefore: null, expiresAt: null, issuer: null, subjectAlternativeNames: [], fingerprintSha256: null, renewalMode: "unsupported", renewable: false, unavailableReason: "no TLS", certificateId: null },
    renewal: { batchId: null, taskId: null, status: "idle", message: null, updatedAt: null },
  }] }) };
  const service = new SiteMonitoringService(collector, 30);
  await service.startup();
  await Promise.all([service.getSites(), service.getSites(), service.getSites()]);
  assert.equal(calls, 1);
  await new Promise((resolve) => setTimeout(resolve, 45));
  assert.equal(calls, 2);
  assert.equal((await service.getSites()).sites[0].domain, "site-2.example.com");
  assert.equal(calls, 2);
  service.shutdown();
});

function remoteNode(nodeId, collected = new Date().toISOString()) {
  return {
    nodeId, nodeName: "remote", status: "online", agentVersion: "0.2.0", protocolVersion: "1.0", platform: "linux",
    declaredCapabilities: ["sites.inventory.read", "sites.certificates.renew"], allowedCapabilities: ["sites.inventory.read", "sites.certificates.renew"],
    enrolledAt: collected, lastSeenAt: collected, revokedAt: null,
    siteSnapshot: { collectedAt: collected, collectionStatus: "complete", warnings: [], sites: [{
      id: "agent-site-1", domain: "remote.example.com", status: "running", runtime: "Nginx", host: "remote", upstream: null,
      source: "Nginx", latencyMs: 10, trafficBytes: null,
      certificate: { status: "expiring", notBefore: "2026-01-01T00:00:00.000Z", expiresAt: new Date(Date.now() + 10 * 86_400_000).toISOString(), issuer: "Test CA", subjectAlternativeNames: ["remote.example.com"], fingerprintSha256: null, renewalMode: "automatic", renewable: true, unavailableReason: null, certificateId: "cert-agent-1" },
    }] },
  };
}

test("site monitoring aggregates authorized Agent snapshots and computes freshness and risk server-side", async () => {
  const repository = new MemoryAgentControlRepository();
  const allowed = "11111111-1111-4111-8111-111111111111";
  const hidden = "22222222-2222-4222-8222-222222222222";
  await repository.update((state) => state.nodes.push(remoteNode(allowed), remoteNode(hidden)));
  const service = new SiteMonitoringService({ collectSites: async () => ({ collectedAt: new Date().toISOString(), collectionStatus: "complete", warnings: [], sites: [] }) }, repository);
  const payload = await service.getSites({ nodeScope: [allowed] });
  assert.equal(payload.sites.length, 1);
  assert.equal(payload.sites[0].nodeId, allowed);
  assert.equal(payload.sites[0].id, publicSiteId(allowed, "agent-site-1"));
  assert.equal(payload.sites[0].certificate.status, "expiring");
  assert.equal(payload.sites[0].freshness, "current");
});

test("site monitoring removes local mirrors while retaining the Agent identity for managed sites", async () => {
  const repository = new MemoryAgentControlRepository();
  const sameHost = remoteNode("11111111-1111-4111-8111-111111111111");
  sameHost.siteSnapshot.sites[0].host = " CONTROLLER-1 ";
  sameHost.siteSnapshot.sites[0].domain = " Remote.Example.com ";
  sameHost.siteSnapshot.sites[0].status = "unknown";
  sameHost.siteSnapshot.sites[0].latencyMs = null;
  const otherHost = remoteNode("22222222-2222-4222-8222-222222222222");
  otherHost.siteSnapshot.sites[0].host = "controller-2";
  await repository.update((state) => state.nodes.push(sameHost, otherHost));
  const localSite = {
    ...sameHost.siteSnapshot.sites[0], id: "nginx-local", nodeId: "node-local", host: "controller-1",
    status: "running", latencyMs: 7, collectedAt: new Date().toISOString(), freshness: "current",
    renewal: { batchId: null, taskId: null, status: "idle", message: null, updatedAt: null },
  };
  const service = new SiteMonitoringService({ collectSites: async () => ({
    collectedAt: new Date().toISOString(), collectionStatus: "complete", warnings: [], sites: [localSite],
  }) }, repository);

  const payload = await service.getSites({ nodeScope: "all" });
  assert.deepEqual(payload.sites.map((site) => [site.nodeId, site.host.trim(), site.domain.trim()]), [
    [sameHost.nodeId, "CONTROLLER-1", "Remote.Example.com"],
    [otherHost.nodeId, "controller-2", "remote.example.com"],
  ]);
  const managedSiteId = publicSiteId(sameHost.nodeId, sameHost.siteSnapshot.sites[0].id);
  const managedRepository = new MemorySiteManagementRepository();
  managedRepository.saveManagedSite({
    siteId: managedSiteId, nodeId: sameHost.nodeId, domainDigest: "unused", desiredState: "running",
    protected: false, version: 2, activeReleaseId: "release-1", createdAt: collectedAt, updatedAt: collectedAt,
  });
  const management = new SiteManagementService(managedRepository, service, {});
  const managed = (await management.getSites({ nodeScope: "all" })).sites.find((site) => site.id === managedSiteId);
  assert.equal(managed?.nodeId, sameHost.nodeId);
  assert.equal(managed?.manageability, "managed");
  assert.equal(managed?.version, 2);
  assert.equal(managed?.status, "running");
  assert.equal(managed?.latencyMs, 7);
  assert.equal(managed?.certificate.certificateId, "cert-agent-1");
});

test("certificate renewal batches are atomic, idempotent, deduplicated and non-retryable", async () => {
  const repository = new MemoryAgentControlRepository();
  const nodeId = "11111111-1111-4111-8111-111111111111";
  await repository.update((state) => state.nodes.push(remoteNode(nodeId)));
  const service = new CertificateRenewalService(repository);
  const input = { siteIds: [publicSiteId(nodeId, "agent-site-1")], idempotencyKey: "renewal-request-1" };
  const first = await service.create(input, { nodeScope: [nodeId] }, "user:test", crypto.randomUUID());
  const repeated = await service.create(input, { nodeScope: [nodeId] }, "user:test", crypto.randomUUID());
  assert.equal(repeated.batchId, first.batchId);
  await assert.rejects(() => service.create({ siteIds: [publicSiteId(nodeId, "agent-site-other")], idempotencyKey: input.idempotencyKey }, { nodeScope: [nodeId] }, "user:test", crypto.randomUUID()), /幂等键/);
  let state = await repository.read();
  assert.equal(state.tasks.length, 1);
  assert.equal(state.tasks[0].maxAttempts, 1);
  assert.equal(state.tasks[0].retryable, false);
  await assert.rejects(() => service.create({ ...input, idempotencyKey: "renewal-request-2" }, { nodeScope: [nodeId] }, "user:test", crypto.randomUUID()), /进行中/);
  assert.equal((await repository.read()).tasks.length, 1);
  await repository.update((next) => { next.tasks[0].status = "succeeded"; next.tasks[0].updatedAt = new Date().toISOString(); next.tasks[0].result = { message: "renewed", truncated: false }; });
  assert.equal((await service.get(first.batchId, { nodeScope: [nodeId] })).status, "succeeded");
  await assert.rejects(() => service.get(first.batchId, { nodeScope: [] }), /授权范围/);
  state = await repository.read();
  assert.doesNotMatch(JSON.stringify(state.audits), /private|ssl_certificate|BEGIN/);
});

test("unknown certificate renewal results remain locked and running renewals cannot be cancelled", async () => {
  const repository = new MemoryAgentControlRepository();
  const nodeId = "11111111-1111-4111-8111-111111111111";
  await repository.update((state) => state.nodes.push(remoteNode(nodeId)));
  const renewals = new CertificateRenewalService(repository);
  const first = await renewals.create({ siteIds: [publicSiteId(nodeId, "agent-site-1")], idempotencyKey: "unknown-renewal-1" }, { nodeScope: [nodeId] }, "user:test", crypto.randomUUID());
  const { RemoteTaskService } = await import("../../apps/controller/dist/modules/remote-tasks/remoteTaskService.js");
  const tasks = new RemoteTaskService(repository);
  const [dispatched] = await tasks.poll(nodeId, crypto.randomUUID());
  await tasks.update(nodeId, { taskId: dispatched.taskId, attempt: 1, status: "running", timestamp: new Date().toISOString() }, crypto.randomUUID());
  await assert.rejects(() => tasks.cancel(dispatched.taskId, "user:test", "stop", crypto.randomUUID()), /不能取消/);
  await tasks.update(nodeId, { taskId: dispatched.taskId, attempt: 1, status: "failed", timestamp: new Date().toISOString(), errorCode: "RESULT_UNKNOWN", result: { message: "unknown", truncated: false } }, crypto.randomUUID());
  assert.equal((await renewals.get(first.batchId, { nodeScope: [nodeId] })).status, "failed");
  await assert.rejects(() => renewals.create({ siteIds: [publicSiteId(nodeId, "agent-site-1")], idempotencyKey: "unknown-renewal-2" }, { nodeScope: [nodeId] }, "user:test", crypto.randomUUID()), /进行中/);
  await tasks.update(nodeId, { taskId: dispatched.taskId, attempt: 1, status: "succeeded", timestamp: new Date().toISOString(), result: { message: "late confirmation", truncated: false } }, crypto.randomUUID());
  assert.equal((await renewals.get(first.batchId, { nodeScope: [nodeId] })).status, "succeeded");
});

test("legacy Agent cancellation of a started renewal is retained as an unknown result", async () => {
  const repository = new MemoryAgentControlRepository();
  const nodeId = "11111111-1111-4111-8111-111111111111";
  await repository.update((state) => state.nodes.push(remoteNode(nodeId)));
  const renewals = new CertificateRenewalService(repository);
  await renewals.create({ siteIds: [publicSiteId(nodeId, "agent-site-1")], idempotencyKey: "legacy-cancel-renewal" }, { nodeScope: [nodeId] }, "user:test", crypto.randomUUID());
  const { RemoteTaskService } = await import("../../apps/controller/dist/modules/remote-tasks/remoteTaskService.js");
  const tasks = new RemoteTaskService(repository);
  const [dispatched] = await tasks.poll(nodeId, crypto.randomUUID());
  await tasks.update(nodeId, { taskId: dispatched.taskId, attempt: 1, status: "cancelled", timestamp: new Date().toISOString(), errorCode: "TASK_CANCELLED_OR_TIMEOUT", result: { message: "old Agent cancelled", truncated: false } }, crypto.randomUUID());
  const task = (await repository.read()).tasks[0];
  assert.equal(task.status, "failed");
  assert.equal(task.errorCode, "RESULT_UNKNOWN");
});

test("remote certificate renewals dispatch only one Certbot task per node at a time", async () => {
  const repository = new MemoryAgentControlRepository();
  const nodeId = "11111111-1111-4111-8111-111111111111";
  const node = remoteNode(nodeId); const second = structuredClone(node.siteSnapshot.sites[0]);
  second.id = "agent-site-2"; second.domain = "second.example.com"; second.certificate.certificateId = "cert-agent-2";
  node.siteSnapshot.sites.push(second); await repository.update((state) => state.nodes.push(node));
  const renewals = new CertificateRenewalService(repository);
  await renewals.create({ siteIds: [publicSiteId(nodeId, "agent-site-1"), publicSiteId(nodeId, "agent-site-2")], idempotencyKey: "serial-renewal-1" }, { nodeScope: [nodeId] }, "user:test", crypto.randomUUID());
  const { RemoteTaskService } = await import("../../apps/controller/dist/modules/remote-tasks/remoteTaskService.js");
  const tasks = new RemoteTaskService(repository);
  const first = await tasks.poll(nodeId, crypto.randomUUID()); assert.equal(first.length, 1);
  assert.equal(first[0].type, "sites.certificates.renew");
  assert.deepEqual(await tasks.poll(nodeId, crypto.randomUUID()), first);
  await tasks.update(nodeId, { taskId: first[0].taskId, attempt: 1, status: "running", timestamp: new Date().toISOString() }, crypto.randomUUID());
  assert.equal((await tasks.poll(nodeId, crypto.randomUUID())).length, 0);
  await tasks.update(nodeId, { taskId: first[0].taskId, attempt: 1, status: "succeeded", timestamp: new Date().toISOString(), result: { message: "renewed", truncated: false } }, crypto.randomUUID());
  assert.equal((await tasks.poll(nodeId, crypto.randomUUID())).length, 1);
});

test("certificate renewal rejects stale or unknown sites without creating partial tasks", async () => {
  const repository = new MemoryAgentControlRepository();
  const nodeId = "11111111-1111-4111-8111-111111111111";
  await repository.update((state) => state.nodes.push(remoteNode(nodeId, new Date(Date.now() - 300_000).toISOString())));
  const service = new CertificateRenewalService(repository);
  await assert.rejects(() => service.create({ siteIds: [publicSiteId(nodeId, "agent-site-1")], idempotencyKey: "stale-renewal-1" }, { nodeScope: [nodeId] }, "user:test", crypto.randomUUID()), /过期/);
  assert.equal((await repository.read()).tasks.length, 0);
});

test("Controller local renewal uses only the fixed helper protocol and persists the result", async () => {
  const repository = new MemoryAgentControlRepository();
  const certificateId = "cert_11111111111111111111111111111111";
  const localInventory = { getLocalSites: async () => ({ sites: [{ id: "nginx-local-site", nodeId: "node-local", certificate: { renewable: true, certificateId } }] }) };
  const requests = [];
  const service = new CertificateRenewalService(repository, localInventory, async (request) => { requests.push(request); return { ok: true }; });
  const batch = await service.create({ siteIds: ["nginx-local-site"], idempotencyKey: "local-renewal-1" }, { nodeScope: [] }, "user:test", crypto.randomUUID());
  for (let attempt = 0; attempt < 20 && (await service.get(batch.batchId, { nodeScope: [] })).status !== "succeeded"; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  const completed = await service.get(batch.batchId, { nodeScope: [] });
  assert.equal(completed.status, "succeeded");
  assert.equal(completed.operations[0].nodeId, "node-local");
  assert.deepEqual(requests, [{ operation: "renew", certificateId }]);
  const task = (await repository.read()).tasks[0];
  assert.equal(task.maxAttempts, 1); assert.equal(task.retryable, false); assert.equal(task.status, "succeeded");
});

test("GET /api/sites requires sites read and returns the contracted payload", async () => {
  const database = openDatabase(":memory:");
  const identity = new IdentityService(database, Buffer.alloc(32, 5));
  await identity.createInitialAdministrator("admin", "Administrator", "correct horse battery staple");
  const admin = (await identity.login("admin", "correct horse battery staple", "test", "ua")).principal;
  const services = createControllerServices(new FakePlatformAdapter(), process.cwd(), loadControllerConfig({}), new MemoryAgentControlRepository());
  services.sites = new SiteMonitoringService({ collectSites: async () => ({ collectedAt, collectionStatus: "partial", warnings: ["one unreadable config"], sites: [] }) });
  services.siteManagement = new SiteManagementService(new MemorySiteManagementRepository(), services.sites, services.certificateRenewals);
  const overviewToken = identity.createApiToken(admin, { name: "overview", permissions: ["overview:read"], nodeScope: [], expiresAt: null }).token;
  const sitesToken = identity.createApiToken(admin, { name: "sites", permissions: ["sites:read"], nodeScope: [], expiresAt: null }).token;
  const nodesToken = identity.createApiToken(admin, { name: "nodes", permissions: ["nodes:read"], nodeScope: "all", expiresAt: null }).token;
  const server = createStackPilotServer({ env: { STACKPILOT_COOKIE_SECURE: "0" }, services, database, identity });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(`${base}/api/sites`)).status, 401);
    assert.equal((await fetch(`${base}/api/sites`, { headers: { Authorization: `Bearer ${nodesToken}` } })).status, 403);
    assert.equal((await fetch(`${base}/api/sites`, { headers: { Authorization: `Bearer ${overviewToken}` } })).status, 403);
    const response = await fetch(`${base}/api/sites`, { headers: { Authorization: `Bearer ${sitesToken}` } });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { collectedAt, collectionStatus: "partial", warnings: ["one unreadable config"], sites: [] });
  } finally { server.close(); await once(server, "close"); database.close(); }
});

test("certificate renewal HTTP API enforces CSRF, reauthentication and returns a persisted batch", async () => {
  const database = openDatabase(":memory:");
  const identity = new IdentityService(database, Buffer.alloc(32, 9));
  await identity.createInitialAdministrator("admin", "Administrator", "correct horse battery staple");
  const repository = new MemoryAgentControlRepository();
  const nodeId = "11111111-1111-4111-8111-111111111111";
  await repository.update((state) => state.nodes.push(remoteNode(nodeId)));
  const services = createControllerServices(new FakePlatformAdapter(), process.cwd(), loadControllerConfig({}), repository);
  services.sites = new SiteMonitoringService({ collectSites: async () => ({ collectedAt: new Date().toISOString(), collectionStatus: "complete", warnings: [], sites: [] }) }, repository);
  const server = createStackPilotServer({ env: { STACKPILOT_COOKIE_SECURE: "0", STACKPILOT_ALLOWED_ORIGINS: "http://127.0.0.1:5173" }, services, database, identity });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { Origin: "http://127.0.0.1:5173", "Content-Type": "application/json" }, body: JSON.stringify({ username: "admin", password: "correct horse battery staple" }) });
    const loginBody = await login.json(); const cookie = login.headers.get("set-cookie").split(";")[0];
    const headers = { Origin: "http://127.0.0.1:5173", Cookie: cookie, "X-CSRF-Token": loginBody.csrfToken, "Content-Type": "application/json" };
    const body = JSON.stringify({ siteIds: [publicSiteId(nodeId, "agent-site-1")], idempotencyKey: "http-renewal-1" });
    assert.equal((await fetch(`${base}/api/sites/certificate-renewals`, { method: "POST", headers, body })).status, 403);
    const reauth = await (await fetch(`${base}/api/auth/reauthenticate`, { method: "POST", headers, body: JSON.stringify({ password: "correct horse battery staple" }) })).json();
    const created = await fetch(`${base}/api/sites/certificate-renewals`, { method: "POST", headers: { ...headers, "X-Reauth-Proof": reauth.proof }, body });
    assert.equal(created.status, 202);
    const batch = await created.json();
    const fetched = await fetch(`${base}/api/sites/certificate-renewals/${batch.batchId}`, { headers: { Cookie: cookie } });
    assert.equal(fetched.status, 200);
    assert.equal((await fetched.json()).batchId, batch.batchId);
  } finally { server.close(); await once(server, "close"); database.close(); }
});
