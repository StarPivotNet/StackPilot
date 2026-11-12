import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { SessionRuntime } from "../../apps/ssh-helper/dist/runtime.js";
import { ControllerError } from "../../apps/ssh-helper/dist/controllerClient.js";
import { SessionScopes } from "../../apps/ssh-helper/dist/systemd.js";
import { parseProcessStat } from "../../apps/ssh-helper/dist/processes.js";
import { LocalSessionSchema } from "../../apps/ssh-helper/dist/store.js";

function fixture() {
  let time = 1000; let alive = true; let online = true; let denied = false; let revoked = false; let path = "/system.slice/ssh.service"; let records = []; let creates = 0; let stops = 0; let acks = 0;
  const bootId = randomUUID(); const nodeId = randomUUID();
  const started = Date.now();
  const session = { id: randomUUID(), credentialId: randomUUID(), nodeId, userId: randomUUID(), account: "sp_test", connectionId: "trusted-connection-instance", startedAt: new Date(started).toISOString(), expiresAt: new Date(started + 60_000).toISOString(), terminationRequestedAt: null, terminatedAt: null };
  const store = { sessions: async () => structuredClone(records), saveSessions: async values => { records = structuredClone(values); } };
  const controller = {
    authenticate: async () => { if (!online) throw new Error("offline"); time += 1000; return session; },
    state: async () => { if (denied) throw new ControllerError(401); if (!online) throw new Error("offline"); return { controllerTime: new Date().toISOString(), sessions: [{ id: session.id, connectionId: session.connectionId, terminate: revoked }] }; },
    acknowledge: async () => { if (!online) throw new Error("offline"); acks++; },
  };
  const processes = {
    bootId: async () => bootId, bootMs: async () => time,
    connection: async () => ({ bootId, monitor: { pid: 100, ppid: 90, start: "10000" }, connectionId: session.connectionId }),
    sshd: async pid => ({ pid, ppid: 90, start: "10000" }),
    identity: async pid => { if (!alive) throw Object.assign(new Error("gone"), { code: "ENOENT" }); return { pid, ppid: 90, start: "10000" }; },
    descendants: async () => [100, 101, 102], cgroup: async () => path,
    members: async value => alive && value === path ? [100, 101, 102] : [],
  };
  const scopes = { create: async (name, pids, remaining) => { assert.deepEqual(pids, [100, 101, 102]); assert(remaining <= 59_001); creates++; path = `/system.slice/${name}`; }, stop: async () => { stops++; alive = false; } };
  const make = () => new SessionRuntime(store, controller, { nodeId, credentialId: randomUUID(), privateKey: null }, processes, scopes);
  return { make, session, store, scopes, processes, controller, offline: () => { online = false; }, online: () => { online = true; }, deny: () => { denied = true; }, revoke: () => { revoked = true; }, advance: ms => { time += ms; }, records: () => records, counts: () => ({ creates, stops, acks }) };
}
test("scope is attached before PAM access and transport time cannot extend the lease", async () => {
  const f = fixture(); const runtime = f.make(); await runtime.initialize();
  await runtime.authenticate(100, 101, "sp_test", "x"); await runtime.check(100, "sp_test");
  assert.equal(f.records()[0].deadlineBootMs, 61_000); assert.equal(f.counts().creates, 1);
  await assert.rejects(runtime.check(100, "sp_other"));
  await assert.rejects(runtime.authenticate(100, 101, "sp_test", "x"));
});
test("helper restart and Controller outage preserve the original deadline", async () => {
  const f = fixture(); const first = f.make(); await first.initialize(); await first.authenticate(100, 101, "sp_test", "x");
  const deadline = f.records()[0].deadlineBootMs; f.advance(20_000); f.offline();
  const restarted = f.make(); await restarted.initialize(); assert.equal(f.records()[0].deadlineBootMs, deadline); assert.equal(f.counts().creates, 1);
  await assert.rejects(restarted.authenticate(200, 201, "sp_test", "x"));
  await restarted.check(100, "sp_test"); f.advance(40_000); await restarted.synchronize();
  assert.equal(f.counts().stops, 1); assert.equal(f.counts().acks, 0); assert.equal(f.records()[0].terminated, true);
  f.online(); await restarted.synchronize(); assert.equal(f.counts().acks, 1); assert.equal(f.records().length, 0);
});
test("online policy revocation stops the entire scope and acknowledges only after termination", async () => {
  const f = fixture(); const runtime = f.make(); await runtime.initialize(); await runtime.authenticate(100, 101, "sp_test", "x");
  f.revoke(); await runtime.synchronize(); assert.deepEqual(f.counts(), { creates: 1, stops: 1, acks: 1 });
  await runtime.synchronize(); assert.equal(f.counts().acks, 1);
});
test("authenticated helper revocation closes sessions rather than treating 401 as a partition", async () => {
  const f = fixture(); const runtime = f.make(); await runtime.initialize(); await runtime.authenticate(100, 101, "sp_test", "x");
  f.deny(); await runtime.synchronize(); assert.equal(f.counts().stops, 1);
});
test("failed scope termination stays pending without a false acknowledgement", async () => {
  const f = fixture(); const runtime = f.make(); await runtime.initialize(); await runtime.authenticate(100, 101, "sp_test", "x");
  f.scopes.stop = async () => { throw new Error("systemd unavailable"); }; f.revoke();
  await assert.rejects(runtime.synchronize()); assert.equal(f.records()[0].terminationRequested, true); assert.equal(f.records()[0].terminated, false); assert.equal(f.counts().acks, 0);
  await assert.rejects(runtime.check(100, "sp_test"));
});
test("failed attachment cannot confirm termination while the monitor is still alive", async () => {
  const f = fixture(); const runtime = f.make(); await runtime.initialize(); f.scopes.create = async () => { throw new Error("scope creation failed"); };
  await assert.rejects(runtime.authenticate(100, 101, "sp_test", "x"));
  assert.equal(f.records()[0].terminationRequested, true); assert.equal(f.records()[0].terminated, false); assert.equal(f.counts().acks, 0);
});
test("persisted local scope and cgroup must match their exact session", async () => {
  const f = fixture(); const runtime = f.make(); await runtime.initialize(); await runtime.authenticate(100, 101, "sp_test", "x");
  assert.equal(LocalSessionSchema.safeParse(f.records()[0]).success, true);
  assert.equal(LocalSessionSchema.safeParse({ ...f.records()[0], cgroup: "/system.slice/ssh.service" }).success, false);
  assert.equal(LocalSessionSchema.safeParse({ ...f.records()[0], scope: `stackpilot-ssh-${randomUUID()}.scope` }).success, false);
});
test("systemd boundary allows only bounded session scopes and fixed executables", async () => {
  const calls = []; const scopes = new SessionScopes(async (file, args) => { calls.push({ file, args }); });
  const name = `stackpilot-ssh-${randomUUID()}.scope`; await scopes.create(name, [100, 101], 60_000); await scopes.stop(name);
  assert.equal(calls[0].file, "/usr/bin/busctl"); assert(calls[0].args.includes("60000000")); assert(calls[0].args.includes("control-group")); assert(calls[0].args.includes("Delegate"));
  assert.deepEqual(calls[1], { file: "/usr/bin/systemctl", args: ["stop", "--", name] });
  for (const bad of ["ssh.service", "../ssh.scope", "stackpilot-ssh-foo.scope"]) await assert.rejects(scopes.stop(bad));
  await assert.rejects(scopes.create(name, [1], 100)); await assert.rejects(scopes.create(name, [100], 28_800_001)); await assert.rejects(scopes.create(name, [100], 0));
});
test("proc stat parsing keeps parent and start identity even with parentheses in process names", () => {
  const fields = ["S", "90", ...Array(17).fill("0"), "123456", "0"];
  assert.deepEqual(parseProcessStat(`100 (sshd (pam) worker) ${fields.join(" ")}`), { pid: 100, ppid: 90, start: "123456" });
  assert.throws(() => parseProcessStat("100 invalid"));
});
