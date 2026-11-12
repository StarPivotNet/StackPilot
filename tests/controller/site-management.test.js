import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import { openDatabase } from "../../apps/controller/dist/database/database.js";
import { IdentityService } from "../../apps/controller/dist/identity/identityService.js";
import { RemoteSiteExecutor, SiteManagementService } from "../../apps/controller/dist/modules/sites/siteManagementService.js";
import { MemorySiteManagementRepository, SqliteSiteManagementRepository } from "../../apps/controller/dist/modules/sites/siteManagementRepository.js";
import { SecretStore } from "../../apps/controller/dist/security/secretStore.js";
import { createControllerServices } from "../../apps/controller/dist/app.js";
import { createStackPilotServer } from "../../apps/controller/dist/server.js";
import { loadControllerConfig } from "../../apps/controller/dist/config/environment.js";
import { MemoryAgentControlRepository } from "../../apps/controller/dist/repositories/agentControlRepository.js";
import { SqliteAgentControlRepository } from "../../apps/controller/dist/repositories/sqliteAgentControlRepository.js";
import { FakePlatformAdapter } from "./support/fakePlatform.js";

const emptyResult = (preview = null) => ({ message: null, siteId: null, releaseId: null, stagingId: null, desiredState: null, siteVersion: null, certificateRenewalBatchId: null, planPreview: preview, logs: [] });
const planInput = { nodeId: "node-local", domains: ["app.example.com"], repositoryUrl: "https://github.com/example/project.git", repositoryRef: "main", certificateEmail: "operator@example.com", environmentVariables: [{ name: "API_MODE", value: "production" }], idempotencyKey: "create-site-001" };
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const managedSiteId = (nodeId, domain) => {
  const agentSiteId = `site_${sha256(`${nodeId}\0${domain.toLowerCase()}`).slice(0, 32)}`;
  return `site-${sha256(`${nodeId}\0${agentSiteId}`).slice(0, 32)}`;
};

async function waitFor(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function managementFixture(database, executorOverride, sites = []) {
  const repository = new SqliteSiteManagementRepository(database, new SecretStore(database, Buffer.alloc(32, 7)));
  const dispatched = [];
  const executor = executorOverride ?? { dispatch: async (operationId, nodeId, instruction) => { dispatched.push({ operationId, nodeId, instruction }); return crypto.randomUUID(); }, reconcile: async () => null };
  const monitoring = { getSites: async () => ({ collectedAt: new Date().toISOString(), collectionStatus: "complete", warnings: [], sites }) };
  const renewals = { create: async () => { throw new Error("unused"); }, get: async () => { throw new Error("unused"); } };
  return { repository, dispatched, service: new SiteManagementService(repository, monitoring, renewals, executor) };
}

async function createRelease(service, repository, input, releaseId, key) {
  const plan = await service.createPlan({ ...input, idempotencyKey: `${key}-prepare` }, { nodeScope: "all" }, "user:test");
  service.complete(plan.operationId, true, { ...emptyResult(), stagingId: `${key}-staging`, planPreview: { runtime: "static", healthCheckPath: "/", changes: ["repository"] } }, null);
  const ready = repository.getPlan(plan.planId);
  const activation = await service.activate(plan.planId, { planVersion: ready.version, planDigest: ready.digest, idempotencyKey: `${key}-activate` }, { nodeScope: "all" }, "user:test");
  service.complete(activation.operationId, true, { ...emptyResult(), siteId: managedSiteId(input.nodeId, input.domains[0]), releaseId }, null);
  return repository.getManagedSite(managedSiteId(input.nodeId, input.domains[0]));
}

test("site rollbacks validate ownership, versions, protection, conflicts and update the active release", async () => {
  const database = openDatabase(":memory:");
  try {
    const { repository, service, dispatched } = managementFixture(database);
    const siteId = managedSiteId(planInput.nodeId, planInput.domains[0]);
    await createRelease(service, repository, planInput, "release_previous_001", "previous");
    const current = await createRelease(service, repository, { ...planInput, repositoryRef: "stable" }, "release_current_001", "current");
    const request = { targetReleaseId: "release_previous_001", expectedSiteVersion: current.version, reason: "Restore known good release", idempotencyKey: "rollback-site-001" };

    await assert.rejects(() => service.rollback(siteId, { ...request, targetReleaseId: "release_current_001" }, { nodeScope: "all" }, "user:test", "Administrator"), /当前活动版本/);
    await assert.rejects(() => service.rollback(siteId, { ...request, expectedSiteVersion: 1 }, { nodeScope: "all" }, "user:test", "Administrator"), /版本已变化/);
    await assert.rejects(() => service.rollback(siteId, request, { nodeScope: ["node-other"] }, "user:test", "Administrator"), /超出授权范围/);
    repository.saveManagedSite({ ...current, protected: true });
    await assert.rejects(() => service.rollback(siteId, request, { nodeScope: "all" }, "user:test", "Administrator"), /受保护站点/);
    repository.saveManagedSite(current);
    repository.saveManagedSite({ ...current, siteId: "site-foreign-001", domainDigest: sha256("foreign.example.com"), activeReleaseId: "release_foreign_current" });
    repository.saveRelease("release_foreign_001", "site-foreign-001", repository.getRelease("release_previous_001").planId, new Date().toISOString());
    await assert.rejects(() => service.rollback(siteId, { ...request, targetReleaseId: "release_foreign_001" }, { nodeScope: "all" }, "user:test", "Administrator"), /不属于当前站点/);

    const rollback = await service.rollback(siteId, request, { nodeScope: "all" }, "user:test", "Administrator");
    const repeated = await service.rollback(siteId, request, { nodeScope: "all" }, "user:test", "Administrator");
    assert.equal(repeated.operationId, rollback.operationId);
    assert.deepEqual(dispatched.at(-1).instruction, { type: "rollback", siteId, targetPlanId: repository.getRelease("release_previous_001").planId, targetReleaseId: "release_previous_001", expectedVersion: current.version });
    await assert.rejects(() => service.rollback(siteId, { ...request, idempotencyKey: "rollback-conflict-002" }, { nodeScope: "all" }, "user:test", "Administrator"), /未完成/);
    const completed = service.complete(rollback.operationId, true, { ...emptyResult(), siteId, releaseId: "release_previous_001", siteVersion: current.version + 1 }, null);
    assert.equal(completed.status, "succeeded");
    assert.equal(repository.getManagedSite(siteId).activeReleaseId, "release_previous_001");
    assert.equal(repository.getManagedSite(siteId).version, current.version + 1);
    const payload = service.listRollbacks({ nodeScope: [planInput.nodeId] });
    assert.equal(payload.rollbacks.find((item) => item.id === rollback.operationId).requestedBy, "Administrator");
    const failed = await service.rollback(siteId, { ...request, targetReleaseId: "release_current_001", expectedSiteVersion: current.version + 1, idempotencyKey: "rollback-failed-003" }, { nodeScope: "all" }, "user:test", "Administrator");
    service.complete(failed.operationId, false, null, "HEALTH_CHECK_FAILED");
    const afterFailure = service.listRollbacks({ nodeScope: [planInput.nodeId] });
    assert.equal(afterFailure.rollbacks.find((item) => item.id === "release_current_001")?.status, "available");
    assert.equal(service.listRollbacks({ nodeScope: ["node-other"] }).rollbacks.length, 0);
  } finally { database.close(); }
});

test("site plans reject domains already claimed by the target node", async () => {
  const database = openDatabase(":memory:");
  try {
    const monitored = { id: "site_existing_01", nodeId: "node-local", domain: "app.example.com", status: "running", runtime: "static", host: "node-local", upstream: null, source: "Nginx", latencyMs: null, trafficBytes: null, errorRatePercent: null, lastDeployAt: null, manageability: "monitored", managementReason: "Discovered", protected: false, version: 1, desiredState: null, collectedAt: new Date().toISOString(), freshness: "current", certificate: { status: "unavailable", notBefore: null, expiresAt: null, issuer: null, subjectAlternativeNames: [], fingerprintSha256: null, renewalMode: "unsupported", renewable: false, unavailableReason: "Unavailable", certificateId: null }, renewal: { batchId: null, taskId: null, status: "idle", message: null, updatedAt: null } };
    const { service, dispatched } = managementFixture(database, undefined, [monitored]);
    await assert.rejects(() => service.createPlan(planInput, { nodeScope: "all" }, "user:test"), /已由目标节点的 Nginx 配置使用/);
    assert.equal(dispatched.length, 0);
    monitored.manageability = "managed";
    await service.createPlan({ ...planInput, idempotencyKey: "redeploy-site-001" }, { nodeScope: "all" }, "user:test");
    assert.equal(dispatched.length, 1);
  } finally { database.close(); }
});

test("site plans persist idempotently while environment values remain encrypted and absent from public records", async () => {
  const database = openDatabase(":memory:");
  try {
    const { repository, service, dispatched } = managementFixture(database);
    const first = await service.createPlan(planInput, { nodeScope: "all" }, "user:test");
    const repeated = await service.createPlan(planInput, { nodeScope: "all" }, "user:test");
    assert.equal(repeated.planId, first.planId);
    assert.equal(dispatched.length, 1);
    assert.deepEqual(first.environmentVariableNames, ["API_MODE"]);
    assert.equal(first.deploymentEnvironment, "production");
    assert.equal(Object.hasOwn(first, "certificateEmail"), false);
    assert.doesNotMatch(JSON.stringify(first), /API_MODE.*production|"value":"production"/);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM site_plans").get().count, 1);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM site_environment_references").get().count, 2);
    assert.doesNotMatch(JSON.stringify(database.prepare("SELECT hex(ciphertext) AS value FROM encrypted_secrets").all()), /production/);
    service.complete(first.operationId, true, { ...emptyResult({ runtime: "node22", healthCheckPath: "/healthz", changes: ["repository", "runtime", "nginx", "certificate", "environment", "traffic_switch"] }), stagingId: "staging-site-001" }, null);
    const ready = repository.getPlan(first.planId);
    assert.equal(ready.status, "ready");
    const activation = await service.activate(first.planId, { planVersion: ready.version, planDigest: ready.digest, idempotencyKey: "activate-site-001" }, { nodeScope: "all" }, "user:test");
    assert.equal(activation.status, "queued");
    assert.equal(dispatched[1].instruction.type, "activate");
  } finally { database.close(); }
});

test("deployment environment changes the plan digest and staging activation performs no writes or dispatch", async () => {
  const database = openDatabase(":memory:");
  try {
    const { repository, service, dispatched } = managementFixture(database);
    const production = await service.createPlan({ ...planInput, idempotencyKey: "environment-production-001" }, { nodeScope: "all" }, "user:test");
    const staging = await service.createPlan({ ...planInput, deploymentEnvironment: "staging", domains: ["staging.example.com"], idempotencyKey: "environment-staging-001" }, { nodeScope: "all" }, "user:test");
    assert.equal(staging.deploymentEnvironment, "staging");
    assert.notEqual(staging.digest, production.digest);
    service.complete(staging.operationId, true, { ...emptyResult(), stagingId: "staging-environment-001" }, null);
    const ready = repository.getPlan(staging.planId);
    const before = database.prepare("SELECT COUNT(*) AS count FROM site_operations").get().count;
    await assert.rejects(
      () => service.activate(staging.planId, { planVersion: ready.version, planDigest: ready.digest, idempotencyKey: "activate-staging-001" }, { nodeScope: "all" }, "user:test"),
      (error) => error.status === 409 && /预发环境/.test(error.message),
    );
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM site_operations").get().count, before);
    assert.equal(repository.getPlan(staging.planId).status, "ready");
    assert.equal(dispatched.length, 2);
  } finally { database.close(); }
});

test("operation reads are side-effect free", async () => {
  const database = openDatabase(":memory:"); let reconciliations = 0;
  try {
    const { repository, service } = managementFixture(database, {
      dispatch: async () => crypto.randomUUID(),
      reconcile: async () => { reconciliations += 1; return { status: "running", result: null, errorCode: null }; },
    });
    const plan = await service.createPlan({ ...planInput, idempotencyKey: "operation-read-only-001" }, { nodeScope: "all" }, "user:test");
    const before = repository.getOperation(plan.operationId);
    assert.deepEqual(await service.getOperation(plan.operationId, { nodeScope: "all" }), before);
    assert.deepEqual(repository.getOperation(plan.operationId), before);
    assert.equal(reconciliations, 0);
  } finally { database.close(); }
});

test("site operation idempotency hits enforce the requester's current node scope", async () => {
  const repository = new MemorySiteManagementRepository(); let dispatches = 0; let collections = 0; let renewals = 0;
  const service = new SiteManagementService(
    repository,
    { getSites: async () => { collections += 1; throw new Error("idempotency hit must not collect sites"); } },
    { create: async () => { renewals += 1; throw new Error("idempotency hit must not renew"); }, get: async () => { throw new Error("unused"); } },
    { dispatch: async () => { dispatches += 1; throw new Error("idempotency hit must not dispatch"); }, reconcile: async () => null },
  );
  const requester = "user:scope-regression"; const scopedNodeId = "node-idempotency-scope"; const scopedSiteId = "site-idempotency-scope"; const now = new Date().toISOString();
  const cases = [
    { name: "activate", type: "activate", keyType: "activate:11111111-1111-4111-8111-111111111111", invoke: (key, access) => service.activate("11111111-1111-4111-8111-111111111111", { planVersion: 1, planDigest: "a".repeat(64), idempotencyKey: key }, access, requester) },
    { name: "lifecycle", type: "lifecycle", keyType: `lifecycle:${scopedSiteId}`, invoke: (key, access) => service.updateLifecycle(scopedSiteId, { action: "stopped", version: 1, idempotencyKey: key }, access, requester) },
    { name: "renew", type: "certificate_renewal", keyType: `renew:${scopedSiteId}`, invoke: (key, access) => service.renewCertificate(scopedSiteId, { version: 1, idempotencyKey: key }, access, requester, randomUUID()) },
    { name: "logs", type: "log_query", keyType: `logs:${scopedSiteId}`, invoke: (key, access) => service.queryLogs(scopedSiteId, { version: 1, since: null, limit: 100, idempotencyKey: key }, access, requester) },
  ];
  for (const scenario of cases) {
    const key = `scope-${scenario.name}`; const operationId = randomUUID();
    const saved = { operationId, taskId: randomUUID(), type: scenario.type, nodeId: scopedNodeId, siteId: scenario.name === "activate" ? null : scopedSiteId, planId: scenario.name === "activate" ? "11111111-1111-4111-8111-111111111111" : null, status: "succeeded", stage: "complete", progressPercent: 100, result: null, errorCode: null, createdAt: now, updatedAt: now };
    repository.saveOperation(saved, sha256(`${requester}\0${scenario.keyType}\0${key}`));
    await assert.rejects(() => scenario.invoke(key, { nodeScope: [] }), (error) => error.status === 403 && error.code === "FORBIDDEN");
    assert.equal((await scenario.invoke(key, { nodeScope: [scopedNodeId] })).operationId, operationId);
  }
  assert.equal(dispatches, 0); assert.equal(collections, 0); assert.equal(renewals, 0);
});

test("site plan creation rolls back the plan, operation and encrypted references atomically", async () => {
  const database = openDatabase(":memory:");
  try {
    const { service } = managementFixture(database);
    database.exec("CREATE TRIGGER reject_site_operation BEFORE INSERT ON site_operations BEGIN SELECT RAISE(ABORT, 'injected operation failure'); END");

    await assert.rejects(
      () => service.createPlan({ ...planInput, idempotencyKey: "atomic-plan-failure-001" }, { nodeScope: "all" }, "user:test"),
      /injected operation failure/,
    );

    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM site_plans").get().count, 0);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM site_operations").get().count, 0);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM site_environment_references").get().count, 0);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM encrypted_secrets WHERE key LIKE 'site-plan:%'").get().count, 0);
  } finally { database.close(); }
});

test("activation rejects an agent site ID that does not match the plan node and primary domain", async () => {
  const database = openDatabase(":memory:");
  try {
    const { repository, service } = managementFixture(database);
    const plan = await service.createPlan(planInput, { nodeScope: "all" }, "user:test");
    service.complete(plan.operationId, true, { ...emptyResult(), stagingId: "staging-site-001" }, null);
    const ready = repository.getPlan(plan.planId);
    const activation = await service.activate(plan.planId, { planVersion: ready.version, planDigest: ready.digest, idempotencyKey: "activate-forged-site-001" }, { nodeScope: "all" }, "user:test");
    const forgedSiteId = managedSiteId("node-victim", "victim.example.com");
    const victim = { siteId: forgedSiteId, nodeId: "node-victim", domainDigest: sha256("victim.example.com"), desiredState: "stopped", protected: true, version: 9, activeReleaseId: "release-victim", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    repository.saveManagedSite(victim);

    const completed = service.complete(activation.operationId, true, { ...emptyResult(), siteId: forgedSiteId, releaseId: "release-forged" }, null);

    assert.equal(completed.status, "failed");
    assert.equal(completed.errorCode, "INVALID_REMOTE_TASK_RESULT");
    assert.equal(completed.result, null);
    assert.deepEqual(repository.getManagedSite(forgedSiteId), victim);
    assert.equal(repository.getManagedSite(managedSiteId(planInput.nodeId, planInput.domains[0])), null);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM site_releases").get().count, 0);
    assert.equal(repository.getPlan(plan.planId).status, "ready");
  } finally { database.close(); }
});

test("remote site results are bound to the requested operation and site", async () => {
  const operationId = "11111111-1111-4111-8111-111111111111";
  const taskId = "22222222-2222-4222-8222-222222222222";
  const siteId = `site-${"a".repeat(32)}`;
  const operation = { operationId, taskId, type: "log_query", nodeId: "node-local", siteId, planId: null, status: "running", stage: "agent_running", progressPercent: 50, result: null, errorCode: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  for (const data of [
    { operationId: "33333333-3333-4333-8333-333333333333", siteId, logs: [] },
    { operationId, siteId: `site-${"b".repeat(32)}`, logs: [] },
  ]) {
    const executor = new RemoteSiteExecutor({ get: async () => ({ taskId, status: "succeeded", parameters: { operationId }, result: { data } }) }, {});
    const result = await executor.reconcile(operation);
    assert.equal(result.status, "failed");
    assert.equal(result.errorCode, "INVALID_REMOTE_TASK_RESULT");
  }
});

test("dispatch failures persist as terminal operations and idempotent retries do not redispatch", async () => {
  const database = openDatabase(":memory:"); let attempts = 0;
  try {
    const executor = { dispatch: async () => { attempts += 1; throw new Error("node unavailable"); }, reconcile: async () => null };
    const { repository, service } = managementFixture(database, executor);
    const failed = await service.createPlan(planInput, { nodeScope: "all" }, "user:test");
    assert.equal(failed.status, "failed");
    const operation = repository.getOperation(failed.operationId);
    assert.equal(operation.status, "failed"); assert.equal(operation.stage, "dispatch_failed"); assert.equal(operation.errorCode, "DISPATCH_FAILED");
    const repeated = await service.createPlan(planInput, { nodeScope: "all" }, "user:test");
    assert.equal(repeated.planId, failed.planId); assert.equal(repeated.status, "failed"); assert.equal(attempts, 1);
  } finally { database.close(); }
});

test("background reconciliation completes site plans without an operation API poll", async () => {
  const database = openDatabase(":memory:"); let reconciliations = 0;
  try {
    const executor = {
      dispatch: async () => crypto.randomUUID(),
      reconcile: async (operation) => {
        reconciliations += 1;
        return operation.type === "prepare"
          ? { status: "succeeded", result: { ...emptyResult({ runtime: "static", healthCheckPath: "/", changes: ["repository"] }), stagingId: "staging-background-001" }, errorCode: null }
          : { status: "succeeded", result: { ...emptyResult(), siteId: managedSiteId(planInput.nodeId, planInput.domains[0]), releaseId: "release-background-001" }, errorCode: null };
      },
    };
    const { repository, service } = managementFixture(database, executor);
    const plan = await service.createPlan(planInput, { nodeScope: "all" }, "user:test");

    service.startBackgroundReconciliation(10);
    await waitFor(() => repository.getPlan(plan.planId)?.status === "ready");
    const ready = repository.getPlan(plan.planId);
    await service.activate(plan.planId, { planVersion: ready.version, planDigest: ready.digest, idempotencyKey: "activate-background-001" }, { nodeScope: "all" }, "user:test");
    await waitFor(() => repository.getManagedSite(managedSiteId(planInput.nodeId, planInput.domains[0])) !== null);
    await service.stopBackgroundReconciliation();

    assert.equal(reconciliations, 2);
    assert.equal(repository.getOperation(plan.operationId).status, "succeeded");
    assert.equal(repository.getPlan(plan.planId).status, "activated");
    assert.equal(repository.getManagedSite(managedSiteId(planInput.nodeId, planInput.domains[0])).desiredState, "running");
  } finally { database.close(); }
});

test("background reconciliation resumes persisted operations after a Controller restart", async () => {
  const database = openDatabase(":memory:"); let restarted;
  try {
    const first = managementFixture(database, { dispatch: async () => crypto.randomUUID(), reconcile: async () => null });
    const plan = await first.service.createPlan({ ...planInput, idempotencyKey: "restart-plan-001" }, { nodeScope: "all" }, "user:test");
    assert.equal(first.repository.getOperation(plan.operationId).status, "queued");
    const persisted = first.repository.getOperation(plan.operationId);
    first.repository.updateOperation({ ...persisted, taskId: null });

    const restartedRepository = new SqliteSiteManagementRepository(database, new SecretStore(database, Buffer.alloc(32, 7)));
    const recoveredTaskId = crypto.randomUUID();
    const executor = new RemoteSiteExecutor({ list: async () => [{
      taskId: recoveredTaskId, status: "succeeded", parameters: { operationId: plan.operationId },
      result: { data: { operationId: plan.operationId, stagingId: "staging-recovered-001", planPreview: { runtime: "static", healthCheckPath: "/", changes: ["repository"] } } },
    }] }, restartedRepository);
    restarted = new SiteManagementService(
      restartedRepository,
      { getSites: async () => ({ collectedAt: new Date().toISOString(), collectionStatus: "complete", warnings: [], sites: [] }) },
      { create: async () => { throw new Error("unused"); }, get: async () => { throw new Error("unused"); } },
      executor,
    );

    restarted.startBackgroundReconciliation();
    await waitFor(() => restartedRepository.getPlan(plan.planId)?.status === "ready");
    await restarted.stopBackgroundReconciliation();

    assert.equal(restartedRepository.getOperation(plan.operationId).status, "succeeded");
    assert.equal(restartedRepository.getOperation(plan.operationId).taskId, recoveredTaskId);
  } finally { await restarted?.stopBackgroundReconciliation(); database.close(); }
});

test("background reconciliation isolates errors, never overlaps cycles and stops cleanly", async () => {
  const database = openDatabase(":memory:"); let active = 0; let maximumActive = 0; let calls = 0; let reportedErrors = 0;
  try {
    const executor = {
      dispatch: async () => crypto.randomUUID(),
      reconcile: async (item) => {
        calls += 1; active += 1; maximumActive = Math.max(maximumActive, active);
        try {
          await new Promise((resolve) => setTimeout(resolve, 15));
          if (item.planId && calls === 1) throw new Error("transient reconcile failure");
          return { status: "succeeded", result: { ...emptyResult(), stagingId: `staging-${item.operationId}` }, errorCode: null };
        } finally { active -= 1; }
      },
    };
    const { repository, service } = managementFixture(database, executor);
    const first = await service.createPlan({ ...planInput, idempotencyKey: "background-error-001" }, { nodeScope: "all" }, "user:test");
    const second = await service.createPlan({ ...planInput, domains: ["second.example.com"], idempotencyKey: "background-error-002" }, { nodeScope: "all" }, "user:test");

    service.startBackgroundReconciliation(1, () => { reportedErrors += 1; });
    await waitFor(() => repository.getPlan(first.planId)?.status === "ready" && repository.getPlan(second.planId)?.status === "ready");
    await service.stopBackgroundReconciliation();
    const stoppedAt = calls;
    await new Promise((resolve) => setTimeout(resolve, 25));

    assert.equal(reportedErrors, 1);
    assert.equal(maximumActive, 1);
    assert.equal(calls, stoppedAt);
  } finally { database.close(); }
});

test("dispatch task-id persistence cannot overwrite a background terminal result", async () => {
  const database = openDatabase(":memory:"); let releaseDispatch; let dispatchStarted = false; let taskAvailable = false; let service;
  try {
    const executor = {
      dispatch: async () => {
        dispatchStarted = true;
        await new Promise((resolve) => { releaseDispatch = resolve; });
        return crypto.randomUUID();
      },
      reconcile: async (item) => taskAvailable
        ? { status: "succeeded", result: { ...emptyResult(), stagingId: `staging-${item.operationId}` }, errorCode: null }
        : null,
    };
    const fixture = managementFixture(database, executor);
    const repository = fixture.repository; service = fixture.service;
    service.startBackgroundReconciliation(1);
    const creating = service.createPlan({ ...planInput, idempotencyKey: "dispatch-race-001" }, { nodeScope: "all" }, "user:test");
    await waitFor(() => dispatchStarted && typeof releaseDispatch === "function");
    taskAvailable = true;
    await waitFor(() => repository.listNonTerminalOperations().length === 0);
    releaseDispatch();
    const plan = await creating;
    await service.stopBackgroundReconciliation();

    assert.equal(repository.getOperation(plan.operationId).status, "succeeded");
    assert.equal(repository.getPlan(plan.planId).status, "ready");
  } finally { await service?.stopBackgroundReconciliation(); database.close(); }
});

test("SQLite remote task storage encrypts site deployment parameters", async () => {
  const database = openDatabase(":memory:");
  try {
    const secrets = new SecretStore(database, Buffer.alloc(32, 6));
    const repository = new SqliteAgentControlRepository(database, undefined, secrets);
    const task = {
      protocolVersion: "1.0", taskId: crypto.randomUUID(), type: "sites.plan.prepare", targetNodeId: crypto.randomUUID(),
      parameters: { operationId: crypto.randomUUID(), certificateContact: "operator@example.com", environmentVariables: [{ name: "API_MODE", value: "sensitive-value" }] },
      createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), idempotencyKey: "encrypted-task-001",
      requester: "controller:site-management", traceId: crypto.randomUUID(), requiredCapability: "sites.deploy", attempt: 0, maxAttempts: 1,
      status: "queued", updatedAt: new Date().toISOString(), result: null, errorCode: null, retryable: false, nextAttemptAt: null,
    };
    await repository.update((state) => state.tasks.push(task));
    const row = database.prepare("SELECT payload FROM remote_tasks WHERE task_id=?").get(task.taskId);
    assert.match(row.payload, /encryptedTaskKey/);
    assert.doesNotMatch(row.payload, /operator@example|sensitive-value|environmentVariables/);
    assert.deepEqual((await repository.read()).tasks[0].parameters, task.parameters);
  } finally { database.close(); }
});

test("site management HTTP endpoints enforce permission, CSRF, one-time reauthentication and strict bodies", async () => {
  const database = openDatabase(":memory:");
  const identity = new IdentityService(database, Buffer.alloc(32, 8));
  await identity.createInitialAdministrator("admin", "Administrator", "correct horse battery staple");
  const config = loadControllerConfig({ STACKPILOT_COOKIE_SECURE: "0", STACKPILOT_ALLOWED_ORIGINS: "http://127.0.0.1:5173" });
  const siteRepository = new SqliteSiteManagementRepository(database, new SecretStore(database, Buffer.alloc(32, 8)));
  const services = createControllerServices(new FakePlatformAdapter(), process.cwd(), config, new MemoryAgentControlRepository(), null, siteRepository);
  services.siteManagement = new SiteManagementService(siteRepository, services.sites, services.certificateRenewals, { dispatch: async () => crypto.randomUUID(), reconcile: async () => null });
  const server = createStackPilotServer({ config, services, database, identity });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { Origin: "http://127.0.0.1:5173", "Content-Type": "application/json" }, body: JSON.stringify({ username: "admin", password: "correct horse battery staple" }) });
    const session = await login.json();
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const headers = { Origin: "http://127.0.0.1:5173", Cookie: cookie, "X-CSRF-Token": session.csrfToken, "Content-Type": "application/json" };
    assert.equal((await fetch(`${base}/api/site-plans`, { method: "POST", headers, body: JSON.stringify(planInput) })).status, 403);
    const reauth = await (await fetch(`${base}/api/auth/reauthenticate`, { method: "POST", headers, body: JSON.stringify({ password: "correct horse battery staple" }) })).json();
    const created = await fetch(`${base}/api/site-plans`, { method: "POST", headers: { ...headers, "X-Reauth-Proof": reauth.proof }, body: JSON.stringify(planInput) });
    assert.equal(created.status, 202);
    const plan = await created.json();
    assert.equal(plan.status, "queued");
    assert.deepEqual(plan.environmentVariableNames, ["API_MODE"]);
    assert.equal(Object.hasOwn(plan, "certificateEmail"), false);
    assert.equal((await fetch(`${base}/api/site-plans`, { method: "POST", headers: { ...headers, "X-Reauth-Proof": reauth.proof }, body: JSON.stringify(planInput) })).status, 403);
    const operation = await fetch(`${base}/api/site-operations/${plan.operationId}`, { headers: { Cookie: cookie } });
    assert.equal(operation.status, 200);
    assert.equal(operation.headers.get("cache-control"), "no-store");
    assert.equal((await operation.json()).operationId, plan.operationId);
    const readOnly = identity.createApiToken((await identity.login("admin", "correct horse battery staple", "test", "ua")).principal, { name: "sites-reader", permissions: ["sites:read"], nodeScope: "all", expiresAt: null }).token;
    assert.equal((await fetch(`${base}/api/site-plans`, { method: "POST", headers: { Authorization: `Bearer ${readOnly}`, "Content-Type": "application/json" }, body: JSON.stringify(planInput) })).status, 403);
  } finally { server.close(); await once(server, "close"); database.close(); }
});

test("site rollback HTTP endpoints enforce CSRF, reauthentication and reject API tokens", async () => {
  const database = openDatabase(":memory:");
  const identity = new IdentityService(database, Buffer.alloc(32, 9));
  await identity.createInitialAdministrator("admin", "Administrator", "correct horse battery staple");
  const config = loadControllerConfig({ STACKPILOT_COOKIE_SECURE: "0", STACKPILOT_ALLOWED_ORIGINS: "http://127.0.0.1:5173" });
  const repository = new SqliteSiteManagementRepository(database, new SecretStore(database, Buffer.alloc(32, 9)));
  const services = createControllerServices(new FakePlatformAdapter(), process.cwd(), config, new MemoryAgentControlRepository(), null, repository);
  services.siteManagement = new SiteManagementService(repository, services.sites, services.certificateRenewals, { dispatch: async () => crypto.randomUUID(), reconcile: async () => null });
  const siteId = managedSiteId(planInput.nodeId, planInput.domains[0]);
  await createRelease(services.siteManagement, repository, planInput, "release_previous_http", "http-previous");
  const current = await createRelease(services.siteManagement, repository, { ...planInput, repositoryRef: "stable" }, "release_current_http", "http-current");
  const server = createStackPilotServer({ config, services, database, identity });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { Origin: "http://127.0.0.1:5173", "Content-Type": "application/json" }, body: JSON.stringify({ username: "admin", password: "correct horse battery staple" }) });
    const session = await login.json(); const cookie = login.headers.get("set-cookie").split(";")[0];
    const body = { targetReleaseId: "release_previous_http", expectedSiteVersion: current.version, reason: "HTTP rollback", idempotencyKey: "rollback-http-001" };
    assert.equal((await fetch(`${base}/api/sites/${siteId}/rollbacks`, { method: "POST", headers: { Origin: "http://127.0.0.1:5173", Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify(body) })).status, 403);
    const headers = { Origin: "http://127.0.0.1:5173", Cookie: cookie, "X-CSRF-Token": session.csrfToken, "Content-Type": "application/json" };
    assert.equal((await fetch(`${base}/api/sites/${siteId}/rollbacks`, { method: "POST", headers, body: JSON.stringify(body) })).status, 403);
    const reauth = await (await fetch(`${base}/api/auth/reauthenticate`, { method: "POST", headers, body: JSON.stringify({ password: "correct horse battery staple" }) })).json();
    const created = await fetch(`${base}/api/sites/${siteId}/rollbacks`, { method: "POST", headers: { ...headers, "X-Reauth-Proof": reauth.proof }, body: JSON.stringify(body) });
    assert.equal(created.status, 202); assert.equal((await created.json()).rollback.requestedBy, "Administrator");
    assert.equal((await fetch(`${base}/api/sites/${siteId}/rollbacks`, { method: "POST", headers: { ...headers, "X-Reauth-Proof": reauth.proof }, body: JSON.stringify(body) })).status, 403);
    const principal = (await identity.login("admin", "correct horse battery staple", "test", "ua")).principal;
    const token = identity.createApiToken(principal, { name: "deployer", permissions: ["sites:read", "sites:deploy"], nodeScope: "all", expiresAt: null }).token;
    assert.equal((await fetch(`${base}/api/sites/${siteId}/rollbacks`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) })).status, 403);
    const listed = await fetch(`${base}/api/site-rollbacks`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(listed.status, 200); assert.ok(Array.isArray((await listed.json()).rollbacks));
  } finally { server.close(); await once(server, "close"); database.close(); }
});
