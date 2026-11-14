import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AGENT_PROTOCOL_VERSION, ServiceStatusTaskParametersSchema } from "@stackpilot/contracts";
import { TaskExecutor } from "../../apps/agent/dist/tasks/executor.js";
import { taskRegistry } from "../../apps/agent/dist/tasks/registry.js";
import { activeAgentCapabilities } from "../../apps/agent/dist/capabilities/index.js";
import { terminalCommandHandler, terminalCommandInvocation, terminalCommandsAvailable, truncateTerminalOutput } from "../../apps/agent/dist/tasks/handlers/terminalCommand.js";

const nodeId = "11111111-1111-4111-8111-111111111111";
const task = (overrides = {}) => ({ protocolVersion: AGENT_PROTOCOL_VERSION, taskId: "22222222-2222-4222-8222-222222222222", type: "system.summary.read", targetNodeId: nodeId, parameters: { includeLoad: false }, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), idempotencyKey: "summary-once-123", requester: "test", traceId: "33333333-3333-4333-8333-333333333333", requiredCapability: "system.summary.read", attempt: 1, maxAttempts: 3, ...overrides });

test("service status tasks reject systemctl option injection", () => {
  assert.equal(ServiceStatusTaskParametersSchema.safeParse({ serviceName: "nginx.service" }).success, true);
  for (const serviceName of ["-Hroot@example.com", "--host=example.com", "-Mcontainer"]) assert.equal(ServiceStatusTaskParametersSchema.safeParse({ serviceName }).success, false);
});

test("task registry exposes only structured handlers and keeps side effects non-retryable", () => {
  assert.deepEqual(Object.keys(taskRegistry).sort(), ["network.cache.fetch", "network.egress.probe", "network.mesh.configure", "network.mesh.status.read", "service.status.read", "sites.certificates.renew", "sites.lifecycle.update", "sites.logs.read", "sites.plan.activate", "sites.plan.prepare", "sites.rollback", "system.summary.read", "terminal.command.execute"]);
  assert.ok(Object.values(taskRegistry).every((definition) => definition.maxOutputBytes <= 16_384));
  assert.ok(Object.keys(taskRegistry).every((name) => !/shell/i.test(name)));
  assert.equal(taskRegistry["system.summary.read"].timeoutMs, 6_000);
  assert.equal(taskRegistry["terminal.command.execute"].timeoutMs, 10_000); assert.equal(taskRegistry["terminal.command.execute"].maxOutputBytes, 1_024); assert.equal(taskRegistry["terminal.command.execute"].retryable, false); assert.equal(taskRegistry["terminal.command.execute"].cancellable, true); assert.deepEqual(taskRegistry["terminal.command.execute"].platforms, ["linux"]);
  assert.equal(taskRegistry["sites.certificates.renew"].retryable, false); assert.equal(taskRegistry["sites.certificates.renew"].cancellable, false); assert.deepEqual(taskRegistry["sites.certificates.renew"].platforms, ["linux"]); assert.equal(taskRegistry["sites.certificates.renew"].timeoutMs, 600_000);
  assert.equal(taskRegistry["sites.plan.prepare"].capability, "sites.deploy"); assert.equal(taskRegistry["sites.plan.prepare"].retryable, false);
  assert.equal(taskRegistry["sites.rollback"].capability, "sites.deploy"); assert.equal(taskRegistry["sites.rollback"].retryable, false); assert.equal(taskRegistry["sites.rollback"].cancellable, false);
  assert.equal(taskRegistry["sites.lifecycle.update"].capability, "sites.lifecycle.manage"); assert.equal(taskRegistry["sites.lifecycle.update"].retryable, false);
  assert.equal(taskRegistry["sites.logs.read"].capability, "sites.logs.read"); assert.equal(taskRegistry["sites.logs.read"].retryable, false);
  assert.equal(taskRegistry["network.egress.probe"].capability, "network.transfer"); assert.equal(taskRegistry["network.egress.probe"].retryable, false); assert.equal(taskRegistry["network.egress.probe"].cancellable, true); assert.deepEqual(taskRegistry["network.egress.probe"].platforms, ["linux"]);
});

test("site mutations require a Linux helper and terminal commands require fixed executables", () => {
  assert.deepEqual(activeAgentCapabilities("linux", false), ["system.summary.read", "service.status.read", "sites.inventory.read"]);
  assert.deepEqual(activeAgentCapabilities("darwin", true), ["system.summary.read", "service.status.read", "sites.inventory.read"]);
  assert.deepEqual(activeAgentCapabilities("linux", true), ["system.summary.read", "service.status.read", "sites.inventory.read", "sites.logs.read", "sites.deploy", "sites.lifecycle.manage", "sites.certificates.renew", "runtime.install"]);
  assert.deepEqual(activeAgentCapabilities("linux", false, true), ["system.summary.read", "service.status.read", "sites.inventory.read", "databases.inventory.read"]);
  assert.deepEqual(activeAgentCapabilities("linux", true, true), ["system.summary.read", "service.status.read", "sites.inventory.read", "sites.logs.read", "sites.deploy", "sites.lifecycle.manage", "sites.certificates.renew", "runtime.install", "databases.inventory.read"]);
  assert.deepEqual(activeAgentCapabilities("linux", false, false, true), ["system.summary.read", "service.status.read", "sites.inventory.read", "terminal.command.execute"]);
  assert.deepEqual(activeAgentCapabilities("linux", true, false, true), ["system.summary.read", "service.status.read", "sites.inventory.read", "terminal.command.execute", "sites.logs.read", "sites.deploy", "sites.lifecycle.manage", "sites.certificates.renew", "runtime.install"]);
  assert.deepEqual(activeAgentCapabilities("linux", true, true, true, true), [
    "system.summary.read", "service.status.read", "sites.inventory.read", "terminal.command.execute", "sites.logs.read", "sites.deploy", "sites.lifecycle.manage", "sites.certificates.renew", "runtime.install", "databases.inventory.read",
    "database.inventory.read", "database.sql.read", "database.backup", "database.operate", "database.install", "database.restore",
  ]);
  assert.equal(terminalCommandsAvailable(() => true), true); assert.equal(terminalCommandsAvailable((path) => path !== "/usr/bin/top"), false);
});

test("terminal handler maps strict commands to fixed executables and preserves non-zero output", async () => {
  assert.deepEqual(terminalCommandInvocation({ command: "disk-usage" }), { executable: "/usr/bin/df", args: ["-h"] });
  assert.deepEqual(terminalCommandInvocation({ command: "uptime" }), { executable: "/usr/bin/uptime", args: [] });
  assert.deepEqual(terminalCommandInvocation({ command: "top-summary" }), { executable: "/usr/bin/top", args: ["-b", "-n", "1"] });
  assert.deepEqual(terminalCommandInvocation({ command: "service-status", serviceName: "nginx.service" }), { executable: "/usr/bin/systemctl", args: ["status", "nginx.service", "--no-pager"] });
  const calls = [];
  const result = await terminalCommandHandler({ command: "service-status", serviceName: "nginx.service" }, new AbortController().signal, async (executable, args, options) => {
    calls.push({ executable, args, options }); const error = new Error("inactive"); error.code = 3; error.stdout = "nginx.service inactive\n"; error.stderr = "diagnostic\n"; throw error;
  });
  assert.equal(calls[0].executable, "/usr/bin/systemctl"); assert.deepEqual(calls[0].args, ["status", "nginx.service", "--no-pager"]); assert.equal(calls[0].options.maxBuffer, 64 * 1_024);
  assert.equal(result.message, "nginx.service inactive\ndiagnostic"); assert.equal(result.data.exitCode, 3); assert.equal(result.truncated, false);
});

test("terminal output truncation is UTF-8 safe and reports truncation", () => {
  const result = truncateTerminalOutput("你".repeat(400), 1_024);
  assert.equal(Buffer.byteLength(result.output, "utf8") <= 1_024, true); assert.equal(result.output.endsWith("�"), false); assert.equal(result.truncated, true);
});

test("executor validates target, expiry, capability and unknown types", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stackpilot-agent-test-"));
  try {
    const executor = new TaskExecutor(join(directory, "receipts.json"), nodeId, "linux", ["system.summary.read"]); await executor.load();
    await assert.rejects(() => executor.execute(task({ targetNodeId: "44444444-4444-4444-8444-444444444444" })), /WRONG_TARGET/);
    await assert.rejects(() => executor.execute(task({ expiresAt: new Date(Date.now() - 1).toISOString() })), /TASK_EXPIRED/);
    await assert.rejects(() => executor.execute(task({ requiredCapability: "service.status.read" })), /CAPABILITY_DENIED/);
    await assert.rejects(() => executor.execute(task({ type: "run-shell" })), (error) => error.name === "ZodError");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("site prepare passes the Agent's current runtime capability to its handler", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stackpilot-agent-test-")); const observed = [];
  const registry = { ...taskRegistry, "sites.plan.prepare": { ...taskRegistry["sites.plan.prepare"], run: async (parameters, _signal, _nodeId, capabilities) => {
    observed.push({ parameters, capabilities }); return { message: "prepared", truncated: false };
  } } };
  const parameters = { operationId: "77777777-7777-4777-8777-777777777777", planId: "88888888-8888-4888-8888-888888888888", domains: ["app.example.com"], repositoryUrl: "https://github.com/example/site.git", repositoryRef: "main", certificateContact: "ops@example.com", certificateEnvironment: "staging", environmentVariables: [], expectedPlanDigest: "a".repeat(64), runtimeInstallAuthorized: true };
  const prepare = task({ taskId: "99999999-9999-4999-8999-999999999999", type: "sites.plan.prepare", parameters, requiredCapability: "sites.deploy", idempotencyKey: "prepare-runtime-denied" });
  try {
    const denied = new TaskExecutor(join(directory, "denied.json"), nodeId, "linux", ["sites.deploy"], registry); await denied.load(); await denied.execute(prepare);
    assert.equal(observed[0].parameters.runtimeInstallAuthorized, true); assert.deepEqual(observed[0].capabilities, ["sites.deploy"]);
    const allowed = new TaskExecutor(join(directory, "allowed.json"), nodeId, "linux", ["sites.deploy", "runtime.install"], registry); await allowed.load();
    await allowed.execute({ ...prepare, taskId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", idempotencyKey: "prepare-runtime-allowed" });
    assert.deepEqual(observed[1].capabilities, ["sites.deploy", "runtime.install"]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("executor persists receipts before execution and prevents duplicate delivery", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stackpilot-agent-test-")); const receiptPath = join(directory, "receipts.json");
  try {
    const executor = new TaskExecutor(receiptPath, nodeId, "linux", ["system.summary.read"]); await executor.load();
    const first = await executor.execute(task()); assert.equal(first.status, "succeeded");
    const second = await executor.execute(task()); assert.deepEqual(second, first);
    const duplicateKey = await executor.execute(task({ taskId: "66666666-6666-4666-8666-666666666666" })); assert.equal(duplicateKey.status, "failed"); assert.equal(duplicateKey.errorCode, "DUPLICATE_IDEMPOTENCY_KEY");
    const receipts = JSON.parse(await readFile(receiptPath, "utf8")); assert.equal(receipts.length, 1); assert.equal(receipts[0].reported, false);
    await executor.markReported(first.taskId); assert.equal(executor.pendingUpdates().length, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("executor reserves concurrency slots before asynchronous receipt persistence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stackpilot-agent-test-"));
  let activeHandlers = 0; let peakHandlers = 0; let releaseHandlers;
  const release = new Promise((resolve) => { releaseHandlers = resolve; });
  const concurrentRegistry = {
    ...taskRegistry,
    "system.summary.read": {
      ...taskRegistry["system.summary.read"],
      run: async () => {
        activeHandlers += 1; peakHandlers = Math.max(peakHandlers, activeHandlers);
        await release;
        activeHandlers -= 1;
        return { message: "complete", truncated: false };
      },
    },
  };
  try {
    const executor = new TaskExecutor(join(directory, "concurrent.json"), nodeId, "linux", ["system.summary.read"], concurrentRegistry); await executor.load();
    const executions = [];
    for (let index = 0; index < 10; index += 1) {
      const execution = executor.tryExecute(task({
        taskId: `22222222-2222-4222-8222-${String(index).padStart(12, "0")}`,
        idempotencyKey: `summary-concurrent-${index}`,
      }), 4);
      if (!execution) break;
      executions.push(execution);
    }
    assert.equal(executions.length, 4);
    assert.equal(executor.activeCount, 4);
    while (activeHandlers < 4) await new Promise((resolve) => setTimeout(resolve, 1));
    assert.equal(peakHandlers, 4);
    releaseHandlers();
    assert.deepEqual((await Promise.all(executions)).map((result) => result.status), ["succeeded", "succeeded", "succeeded", "succeeded"]);
    assert.equal(executor.activeCount, 0);
    assert.equal(JSON.parse(await readFile(join(directory, "concurrent.json"), "utf8")).length, 4);
  } finally { releaseHandlers?.(); await rm(directory, { recursive: true, force: true }); }
});

test("executor serializes site helper tasks while allowing other work within the global limit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stackpilot-agent-test-"));
  let releaseSite;
  const siteFinished = new Promise((resolve) => { releaseSite = resolve; });
  const serialRegistry = {
    ...taskRegistry,
    "sites.lifecycle.update": { ...taskRegistry["sites.lifecycle.update"], run: async () => { await siteFinished; return { message: "site complete", truncated: false }; } },
    "system.summary.read": { ...taskRegistry["system.summary.read"], run: async () => ({ message: "summary complete", truncated: false }) },
  };
  try {
    const executor = new TaskExecutor(join(directory, "site-serial.json"), nodeId, "linux", ["sites.lifecycle.manage", "system.summary.read"], serialRegistry); await executor.load();
    const lifecycle = (index) => task({
      taskId: `33333333-3333-4333-8333-${String(index).padStart(12, "0")}`,
      type: "sites.lifecycle.update",
      requiredCapability: "sites.lifecycle.manage",
      idempotencyKey: `site-lifecycle-${index}`,
      parameters: { operationId: `44444444-4444-4444-8444-${String(index).padStart(12, "0")}`, siteId: `site-${"a".repeat(32)}`, action: "stopped", expectedVersion: 1 },
    });
    const first = executor.tryExecute(lifecycle(1), 4);
    assert.ok(first);
    assert.equal(executor.activeSiteOperationCount, 1);
    assert.equal(executor.tryExecute(lifecycle(2), 4), undefined);
    const summary = executor.tryExecute(task({ taskId: "55555555-5555-4555-8555-555555555555", idempotencyKey: "parallel-summary-task" }), 4);
    assert.ok(summary);
    assert.equal((await summary).status, "succeeded");
    releaseSite();
    assert.equal((await first).status, "succeeded");
    assert.equal(executor.activeSiteOperationCount, 0);
  } finally { releaseSite?.(); await rm(directory, { recursive: true, force: true }); }
});

test("restart converts an uncertain running receipt to a reportable failure without re-execution", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stackpilot-agent-test-")); const receiptPath = join(directory, "receipts.json");
  try {
    await import("node:fs/promises").then(({ writeFile }) => writeFile(receiptPath, JSON.stringify([{ taskId: task().taskId, idempotencyKey: task().idempotencyKey, attempt: 1, status: "running", updatedAt: new Date().toISOString(), reported: true, update: { taskId: task().taskId, attempt: 1, status: "running", timestamp: new Date().toISOString() } }])));
    const executor = new TaskExecutor(receiptPath, nodeId, "linux", ["system.summary.read"]); await executor.load();
    assert.equal(executor.pendingUpdates()[0].errorCode, "AGENT_RESTARTED_DURING_TASK");
    assert.equal((await executor.execute(task())).status, "failed");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("executor enforces timeout and cooperative cancellation with an injected handler", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stackpilot-agent-test-"));
  const slowRegistry = {
    ...taskRegistry,
    "system.summary.read": {
      ...taskRegistry["system.summary.read"], timeoutMs: 20,
      run: (_parameters, signal) => new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve({ message: "unexpected", truncated: false }), 5_000);
        signal.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("aborted")); }, { once: true });
      }),
    },
  };
  try {
    const timeoutExecutor = new TaskExecutor(join(directory, "timeout.json"), nodeId, "linux", ["system.summary.read"], slowRegistry); await timeoutExecutor.load();
    assert.equal((await timeoutExecutor.execute(task())).status, "cancelled");
    const cancelTask = task({ taskId: "55555555-5555-4555-8555-555555555555", idempotencyKey: "cancel-summary-123" });
    const cancelExecutor = new TaskExecutor(join(directory, "cancel.json"), nodeId, "linux", ["system.summary.read"], slowRegistry); await cancelExecutor.load();
    const execution = cancelExecutor.execute(cancelTask); setTimeout(() => cancelExecutor.cancel(cancelTask.taskId), 5);
    assert.equal((await execution).status, "cancelled");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("executor reports cancellation when a handler returns after its abort signal", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stackpilot-agent-test-"));
  const lateRegistry = {
    ...taskRegistry,
    "system.summary.read": {
      ...taskRegistry["system.summary.read"], timeoutMs: 5,
      run: () => new Promise((resolve) => setTimeout(() => resolve({ message: "late result", truncated: false }), 15)),
    },
  };
  try {
    const executor = new TaskExecutor(join(directory, "late.json"), nodeId, "linux", ["system.summary.read"], lateRegistry); await executor.load();
    const result = await executor.execute(task());
    assert.equal(result.status, "cancelled");
    assert.equal(result.errorCode, "TASK_CANCELLED_OR_TIMEOUT");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("non-cancellable renewal timeout is reported as an unknown result", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stackpilot-agent-test-"));
  const renewalRegistry = {
    ...taskRegistry,
    "sites.certificates.renew": {
      ...taskRegistry["sites.certificates.renew"], timeoutMs: 5,
      run: (_parameters, signal) => new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve({ message: "late", truncated: false }), 5_000);
        signal.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("aborted")); }, { once: true });
      }),
    },
  };
  const renewal = task({ type: "sites.certificates.renew", requiredCapability: "sites.certificates.renew", maxAttempts: 1, idempotencyKey: "renew-timeout-123", parameters: { batchId: "44444444-4444-4444-8444-444444444444", certificates: [{ certificateId: "cert_test_1", siteIds: ["site-test-1"] }] } });
  try {
    const executor = new TaskExecutor(join(directory, "renewal.json"), nodeId, "linux", ["sites.certificates.renew"], renewalRegistry); await executor.load();
    const execution = executor.execute(renewal); setTimeout(() => executor.cancel(renewal.taskId), 1);
    const result = await execution;
    assert.equal(result.status, "failed");
    assert.equal(result.errorCode, "RESULT_UNKNOWN");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a running transfer publishes at most one progress sample per interval", async () => {
  const root = await mkdtemp(join(tmpdir(), "stackpilot-executor-"));
  try {
    const definition = {
      capability: "network.transfer", platforms: ["linux"], timeoutMs: 5_000, maxOutputBytes: 16_384, cancellable: true, retryable: false,
      validate: (value) => value,
      run: async (_parameters, _signal, _nodeId, _capabilities, context) => {
        for (let step = 1; step <= 3; step += 1) context.reportProgress({ bytesReceived: step * 1024, totalBytes: 4096, partsDone: 0, partsTotal: 0 });
        return { message: "ok", truncated: false };
      },
    };
    const executor = new TaskExecutor(join(root, "receipts.json"), nodeId, "linux", ["network.transfer"], { "network.cache.fetch": definition });
    const updates = [];
    const result = await executor.execute(
      task({ type: "network.cache.fetch", parameters: {}, requiredCapability: "network.transfer" }),
      async (update) => { updates.push(update); },
    );
    assert.equal(result.status, "succeeded");
    // One running acknowledgement, then a single sample: the other two land inside the interval.
    assert.deepEqual(updates.map((update) => update.status), ["running", "running"]);
    assert.equal(updates[0].progress, undefined);
    assert.deepEqual(updates[1].progress, { bytesReceived: 1024, totalBytes: 4096, partsDone: 0, partsTotal: 0 });
  } finally { await rm(root, { recursive: true, force: true }); }
});
