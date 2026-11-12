import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { once } from "node:events";
import { openDatabase } from "../../apps/controller/dist/database/database.js";
import { IdentityService } from "../../apps/controller/dist/identity/identityService.js";
import { SshService } from "../../apps/controller/dist/modules/ssh/sshService.js";
import { createStackPilotServer } from "../../apps/controller/dist/server.js";
import { FakePlatformAdapter } from "./support/fakePlatform.js";
import { SshPolicyInputSchema, SshIssueRequestSchema } from "@stackpilot/contracts";

const password = "correct horse battery staple";
async function fixture(action) {
  const db = openDatabase(":memory:");
  const identity = new IdentityService(db, Buffer.alloc(32, 9));
  await identity.createInitialAdministrator("admin", "Administrator", password);
  const principal = (await identity.login("admin", password, "test", "test")).principal;
  const nodeId = randomUUID();
  db.prepare("INSERT INTO agent_nodes(node_id,payload,updated_at) VALUES(?,?,?)").run(nodeId, "{}", new Date().toISOString());
  let time = Date.now();
  const service = new SshService(db, identity.audit, () => time);
  const policy = service.upsertPolicy(principal, { nodeId, userId: principal.userId, profile: "shell", services: [], sessionSeconds: 28_800, enabled: true });
  // Test-only trusted adapter fixture. There is no management endpoint that
  // can create this evidence or claim a policy has been applied on a host.
  const ready = () => {
    const host = { nodeId, state: "managed", available: true, reason: "", address: "192.0.2.10", port: 22, fingerprints: ["SHA256:test-only"], collectedAt: new Date(time).toISOString() };
    db.prepare("INSERT OR REPLACE INTO ssh_hosts(node_id,payload,verification_id) VALUES(?,?,?)").run(nodeId, JSON.stringify(host), randomUUID());
    policy.appliedRevision = policy.revision;
    db.prepare("UPDATE ssh_policies SET payload=? WHERE id=?").run(JSON.stringify(policy), policy.id);
  };
  const issue = () => service.issue(principal, { nodeId, purpose: "test maintenance" });
  try { await action({ db, identity, principal, nodeId, service, policy, ready, issue, advance: ms => { time += ms; } }); }
  finally { db.close(); }
}

test("SSH schema rejects privilege injection and invalid service policies", () => {
  const scope = { nodeId: randomUUID(), userId: randomUUID(), enabled: true };
  assert.equal(SshPolicyInputSchema.safeParse({ ...scope, profile: "shell", services: ["sshd.service"] }).success, false);
  assert.equal(SshPolicyInputSchema.safeParse({ ...scope, profile: "service-operator", services: [] }).success, false);
  assert.equal(SshPolicyInputSchema.safeParse({ ...scope, profile: "service-operator", services: ["x;sh.service"] }).success, false);
  assert.equal(SshIssueRequestSchema.safeParse({ nodeId: scope.nodeId, purpose: "maintenance", account: "root" }).success, false);
  assert.equal(SshIssueRequestSchema.safeParse({ nodeId: scope.nodeId, purpose: "maintenance", sessionSeconds: 28_801 }).success, false);
});
test("unverified hosts and unapplied policies cannot issue credentials", async () => fixture(({ service, principal, nodeId, issue, ready, db, policy }) => {
  assert.throws(issue, error => error.status === 503);
  ready();
  policy.appliedRevision = 0;
  db.prepare("UPDATE ssh_policies SET payload=? WHERE id=?").run(JSON.stringify(policy), policy.id);
  assert.throws(issue, error => error.status === 503);
  assert.equal(service.list(principal).credentials.length, 0);
  assert.equal(db.prepare("SELECT count(*) AS n FROM ssh_credentials").get().n, 0);
  assert.equal(service.list(principal).hosts[0].nodeId, nodeId);
}));
test("OTP is digest-only, single-use, node/account bound and has separate session lifetime", async () => fixture(({ ready, issue, service, principal, nodeId, db }) => {
  ready(); const result = issue();
  assert.equal(Buffer.from(result.password, "base64url").length, 32);
  assert.equal(Date.parse(result.credential.loginExpiresAt) - Date.parse(result.credential.createdAt), 900_000);
  assert.doesNotMatch(JSON.stringify(db.prepare("SELECT * FROM ssh_credentials").all()), new RegExp(result.password));
  assert.throws(() => service.authenticate(nodeId, "root", result.password, randomUUID()));
  const session = service.authenticate(nodeId, result.credential.account, result.password, randomUUID());
  assert.equal(Date.parse(session.expiresAt) - Date.parse(session.startedAt), 28_800_000);
  assert.throws(() => service.authenticate(nodeId, result.credential.account, result.password, randomUUID()));
  assert.equal(service.list(principal).sessions.length, 1);
  assert.doesNotMatch(JSON.stringify(service.list(principal)), new RegExp(result.password));
  assert.equal(service.list(principal).credentials[0].consumedAt, session.startedAt);
  assert.equal(db.prepare("SELECT count(*) AS n FROM ssh_sessions").get().n, 1);
}));
test("simultaneous authentication consumes at most one credential", async () => fixture(async ({ ready, issue, service, nodeId }) => {
  ready(); const value = issue();
  const results = await Promise.allSettled(Array.from({ length: 8 }, () => Promise.resolve().then(() => service.authenticate(nodeId, value.credential.account, value.password, randomUUID()))));
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
}));
test("expired credentials and stale helper evidence fail closed", async () => fixture(({ ready, issue, service, nodeId, advance }) => {
  ready(); const value = issue(); advance(900_000); ready();
  assert.throws(() => service.authenticate(nodeId, value.credential.account, value.password, randomUUID()));
  advance(30_001); assert.throws(issue, error => error.status === 503);
}));
test("revocation is durable and does not falsely confirm host termination", async () => fixture(({ ready, issue, service, nodeId, principal }) => {
  ready(); const value = issue(); const session = service.authenticate(nodeId, value.credential.account, value.password, randomUUID());
  service.revoke(principal, value.credential.id);
  const stored = service.list(principal).sessions.find(row => row.id === session.id);
  assert(stored.terminationRequestedAt); assert.equal(stored.terminatedAt, null);
  assert.throws(() => service.authenticate(nodeId, value.credential.account, value.password, randomUUID()));
  assert(service.revoke(principal, value.credential.id).revokedAt);
}));
test("policy changes invalidate existing passwords and sessions atomically", async () => fixture(({ ready, issue, service, nodeId, principal }) => {
  ready(); const value = issue(); service.authenticate(nodeId, value.credential.account, value.password, randomUUID());
  const changed = service.upsertPolicy(principal, { nodeId, userId: principal.userId, profile: "host-admin", services: [], sessionSeconds: 60, enabled: true });
  assert.equal(changed.appliedRevision, 0); assert.equal(changed.revision, 2);
  const state = service.list(principal);
  assert(state.credentials[0].revokedAt); assert(state.sessions[0].terminationRequestedAt);
  assert.throws(issue);
}));
test("ownership and node scopes prevent cross-user visibility and revocation", async () => fixture(({ ready, issue, service, principal, nodeId }) => {
  ready(); const value = issue();
  const other = { ...principal, userId: randomUUID(), permissions: new Set(["ssh:read", "ssh:connect"]), nodeScope: [nodeId] };
  assert.equal(service.list(other).credentials.length, 0);
  assert.throws(() => service.revoke(other, value.credential.id));
  assert.throws(() => service.revoke({ ...principal, nodeScope: [] }, value.credential.id));
}));
test("API tokens cannot issue credentials and issuance is rate limited", async () => fixture(({ ready, issue, service, principal, nodeId }) => {
  ready(); assert.throws(() => service.issue({ ...principal, type: "api-token" }, { nodeId, purpose: "test" }));
  for (let index = 0; index < 5; index++) issue();
  assert.throws(issue, error => error.status === 429);
}));
test("GET workspace does not mutate expired session state", async () => fixture(({ ready, issue, service, principal, nodeId, advance }) => {
  ready(); const value = issue(); service.authenticate(nodeId, value.credential.account, value.password, randomUUID());
  advance(28_800_001);
  assert.equal(service.list(principal).sessions[0].terminationRequestedAt, null);
  service.reconcile(); assert(service.list(principal).sessions[0].terminationRequestedAt);
}));
test("removing a user's node scope revokes credentials within the identity transaction", async () => fixture(async ({ ready, service, principal, identity, db, nodeId }) => {
  ready();
  identity.upsertRole(principal, "ssh-user", "SSH user", "", ["ssh:read", "ssh:connect"]);
  const userId = await identity.createUser(principal, "ssh-user", "SSH User", password, ["ssh-user"], [nodeId]);
  const policy = service.upsertPolicy(principal, { nodeId, userId, profile: "shell", services: [], enabled: true, sessionSeconds: 60 });
  policy.appliedRevision = policy.revision;
  db.prepare("UPDATE ssh_policies SET payload=? WHERE id=?").run(JSON.stringify(policy), policy.id);
  const user = (await identity.login("ssh-user", password, "ssh-test", "test")).principal;
  const value = service.issue(user, { nodeId, purpose: "maintenance" });
  service.authenticate(nodeId, value.credential.account, value.password, randomUUID());
  identity.updateUserAccess(principal, userId, ["ssh-user"], [], false);
  const state = service.list(principal);
  assert(state.credentials.find(row => row.id === value.credential.id).revokedAt);
  assert(state.sessions.find(row => row.credentialId === value.credential.id).terminationRequestedAt);
  assert.throws(() => service.issue(user, { nodeId, purpose: "stale principal" }));
}));
test("custom role changes invalidate previously issued SSH access", async () => fixture(async ({ ready, service, principal, identity, db, nodeId }) => {
  ready(); identity.upsertRole(principal, "ssh-role", "SSH", "", ["ssh:connect"]);
  const userId = await identity.createUser(principal, "role-user", "Role User", password, ["ssh-role"], [nodeId]);
  const policy = service.upsertPolicy(principal, { nodeId, userId, profile: "shell", services: [], enabled: true, sessionSeconds: 60 });
  policy.appliedRevision = policy.revision; db.prepare("UPDATE ssh_policies SET payload=? WHERE id=?").run(JSON.stringify(policy), policy.id);
  const user = (await identity.login("role-user", password, "ssh-test", "test")).principal;
  const value = service.issue(user, { nodeId, purpose: "maintenance" });
  identity.upsertRole(principal, "ssh-role", "SSH", "", ["ssh:read"]);
  assert(service.list(principal).credentials.find(row => row.id === value.credential.id).revokedAt);
  assert.throws(() => service.authenticate(nodeId, value.credential.account, value.password, randomUUID()));
}));
test("helper polling derives revoked access without mutating session records", async () => fixture(({ ready, issue, service, nodeId, principal, db }) => {
  ready(); const value = issue(); const session = service.authenticate(nodeId, value.credential.account, value.password, randomUUID());
  assert.equal(service.hostState(nodeId).sessions[0].terminate, false);
  db.prepare("UPDATE users SET disabled_at=? WHERE id=?").run(new Date().toISOString(), principal.userId);
  const before = db.prepare("SELECT payload FROM ssh_sessions WHERE id=?").get(session.id).payload;
  assert.equal(service.hostState(nodeId).sessions[0].terminate, true);
  assert.equal(db.prepare("SELECT payload FROM ssh_sessions WHERE id=?").get(session.id).payload, before);
}));
test("termination acknowledgement requires exact node and connection and is idempotent", async () => fixture(({ ready, issue, service, nodeId, principal, db, advance }) => {
  ready(); const value = issue(); const session = service.authenticate(nodeId, value.credential.account, value.password, randomUUID());
  service.revoke(principal, value.credential.id);
  assert.throws(() => service.acknowledgeTerminated(randomUUID(), session.id, session.connectionId));
  assert.throws(() => service.acknowledgeTerminated(nodeId, session.id, randomUUID()));
  const confirmed = service.acknowledgeTerminated(nodeId, session.id, session.connectionId); assert(confirmed.terminatedAt);
  const count = db.prepare("SELECT count(*) AS n FROM audit_events").get().n;
  advance(1000); assert.equal(service.acknowledgeTerminated(nodeId, session.id, session.connectionId).terminatedAt, confirmed.terminatedAt);
  assert.equal(db.prepare("SELECT count(*) AS n FROM audit_events").get().n, count); assert.equal(service.hostState(nodeId).sessions.length, 0);
}));
test("policy acknowledgement requires the current node, revision and effective access", async () => fixture(({ service, policy, nodeId, principal, db }) => {
  const input = { policyId: policy.id, revision: policy.revision, enabled: true, applied: true, systemUid: 10000 };
  assert.throws(() => service.acknowledgePolicy(randomUUID(), input));
  assert.throws(() => service.acknowledgePolicy(nodeId, { ...input, revision: policy.revision + 1 }));
  assert.throws(() => service.acknowledgePolicy(nodeId, { ...input, enabled: false }));
  assert.throws(() => service.acknowledgePolicy(nodeId, { ...input, systemUid: null }));
  service.acknowledgePolicy(nodeId, input, "helper:test-credential");
  const current = service.list(principal).policies[0]; assert.equal(current.appliedRevision, current.revision); assert(current.lastAppliedAt);
  const event = db.prepare("SELECT actor_type,actor_id FROM audit_events WHERE action='ssh.policy.applied'").get(); assert.equal(event.actor_type, "ssh-helper"); assert.equal(event.actor_id, "test-credential");
}));
test("failed policy application stays unavailable and exposes one persistent failure", async () => fixture(({ service, policy, nodeId, principal, db }) => {
  const input = { policyId: policy.id, revision: policy.revision, enabled: true, applied: false, systemUid: null };
  service.acknowledgePolicy(nodeId, input); service.acknowledgePolicy(nodeId, input);
  const current = service.list(principal).policies[0]; assert.equal(current.appliedRevision, 0); assert.equal(current.applyError, "POLICY_NOT_APPLIED"); assert.equal(current.lastAppliedAt, null);
  assert.equal(db.prepare("SELECT count(*) AS n FROM audit_events WHERE action='ssh.policy.apply-failed' AND outcome='failure'").get().n, 1);
}));
test("HTTP enforces session/CSRF/reauth and keeps takeover unavailable", async () => fixture(async ({ db, identity }) => {
  const origin = "http://127.0.0.1:5173";
  const server = createStackPilotServer({ env: { STACKPILOT_COOKIE_SECURE: "0", STACKPILOT_ALLOWED_ORIGINS: origin }, database: db, identity, platform: new FakePlatformAdapter() });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(`${base}/api/ssh/workspace`)).status, 401);
    const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ username: "admin", password }) });
    const cookie = login.headers.get("set-cookie").split(";")[0]; const session = await login.json();
    const headers = { Cookie: cookie, Origin: origin, "Content-Type": "application/json", "X-CSRF-Token": session.csrfToken };
    const workspace = await fetch(`${base}/api/ssh/workspace`, { headers });
    assert.equal(workspace.status, 200); assert.equal(workspace.headers.get("cache-control"), "no-store");
    assert.equal((await fetch(`${base}/api/ssh/takeover-plans`, { method: "POST", headers, body: "{}" })).status, 503);
    assert.equal((await fetch(`${base}/api/ssh/policies`, { method: "POST", headers, body: JSON.stringify({ nodeId: randomUUID(), userId: session.user.id, profile: "shell", enabled: true }) })).status, 403);
  } finally { server.close(); await once(server, "close"); }
}));
