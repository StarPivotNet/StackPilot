import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import test from "node:test";
import { openDatabase } from "../../apps/controller/dist/database/database.js";
import { IdentityService } from "../../apps/controller/dist/identity/identityService.js";
import { SshService } from "../../apps/controller/dist/modules/ssh/sshService.js";
import { SshTakeoverService } from "../../apps/controller/dist/modules/ssh/sshTakeoverService.js";
import { SshHelperService } from "../../apps/controller/dist/modules/ssh/sshHelperService.js";
import { SSH_VERIFICATION_CHECKS } from "../../apps/controller/dist/modules/ssh/sshVerificationChecks.js";

async function fixture(action) {
  const db = openDatabase(':memory:'), identity = new IdentityService(db, Buffer.alloc(32, 7)), password = 'correct horse battery staple';
  await identity.createInitialAdministrator('admin', 'Administrator', password);
  const principal = (await identity.login('admin', password, 'fixture', 'fixture')).principal, nodeId = randomUUID();
  db.prepare('INSERT INTO agent_nodes(node_id,payload,updated_at) VALUES(?,?,?)').run(nodeId, '{}', new Date().toISOString());
  const ssh = new SshService(db, identity.audit), helpers = new SshHelperService(db, identity.audit);
  const policy = ssh.upsertPolicy(principal, { nodeId, userId: principal.userId, enabled: true, profile: 'shell', services: [], sessionSeconds: 60 });
  const key = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const helper = helpers.enroll(helpers.createEnrollment(nodeId, principal.userId).token, key);
  ssh.acknowledgePolicy(nodeId, { policyId: policy.id, revision: policy.revision, enabled: true, applied: true, systemUid: 10000 });
  const service = new SshTakeoverService(db, identity.audit, ssh, async () => SSH_VERIFICATION_CHECKS.map(check => ({ check, passed: true, collectedAt: new Date().toISOString() })));
  const input = { nodeId, requestId: randomUUID(), address: '192.0.2.10', port: 22, outOfBandConfirmed: true };
  const inventory = { collectedAt: new Date().toISOString(), digest: 'a'.repeat(64), files: [], listeners: [{ address: '0.0.0.0', port: 22, pids: [100] }], fingerprints: [`SHA256:${'A'.repeat(43)}`], hostKeys: ['/etc/ssh/ssh_host_ed25519_key'], authentication: {}, matches: [], listener: { pid: 100, ppid: 1, start: '1' }, connections: [], socketActive: false };
  const receipt = plan => ({ commandId: plan.command.id, planId: plan.id, successful: true, inventory, local: null, error: null });
  const seedTrial = () => {
    const plan = service.create(principal, input); plan.state = 'awaiting-verification'; plan.command = null; plan.inventory = inventory;
    plan.binding = { policyId: policy.id, revision: policy.revision, account: policy.account, uid: 10000 };
    plan.local = { planId: plan.id, state: 'awaiting-verification', baselineDigest: inventory.digest, appliedDigest: 'b'.repeat(64), rollbackAt: new Date(Date.now()+300000).toISOString(), verificationId: null };
    db.prepare('UPDATE ssh_takeover_plans SET state=?,payload=? WHERE id=?').run(plan.state, JSON.stringify(plan), plan.id); return plan;
  };
  try { await action({ db, identity, principal, nodeId, ssh, service, helpers, helper, policy, input, inventory, receipt, seedTrial }); } finally { db.close(); }
}
test('takeover plans lock one node and preserve request idempotency; GET command derivation is read-only', async () => fixture(({ db, service, principal, nodeId, input, helper, receipt }) => {
  const plan = service.create(principal, input); assert.equal(plan.state, 'prechecking'); assert.equal(service.create(principal, input).id, plan.id);
  assert.throws(() => service.create(principal, { ...input, port: 2222 }), { status: 409 });
  assert.throws(() => service.create(principal, { ...input, requestId: randomUUID() }), { status: 409 });
  const before = db.prepare('SELECT total_changes() AS n').get().n; assert.equal(service.next(nodeId).id, plan.command.id); service.list(principal); assert.equal(db.prepare('SELECT total_changes() AS n').get().n, before);
  const result = service.receive(nodeId, helper.credentialId, receipt(plan)); assert.equal(result.state, 'prechecked');
  const count = db.prepare('SELECT total_changes() AS n').get().n; service.receive(nodeId, helper.credentialId, receipt(plan)); assert.equal(db.prepare('SELECT total_changes() AS n').get().n, count);
  assert.throws(() => service.receive(randomUUID(), helper.credentialId, receipt(plan)), { status: 403 });
}));
test('API tokens, foreign node scopes and unapplied accounts cannot start a switch', async () => fixture(({ db, service, principal, input, nodeId, helper, receipt, policy }) => {
  assert.throws(() => service.create({ ...principal, type: 'api-token' }, input), { status: 403 });
  assert.throws(() => service.create({ ...principal, nodeScope: [] }, input), { status: 403 });
  const plan = service.create(principal, input); service.receive(nodeId, helper.credentialId, receipt(plan));
  db.prepare("UPDATE ssh_policies SET payload=json_set(payload,'$.appliedRevision',0) WHERE id=?").run(policy.id);
  assert.throws(() => service.apply(principal, plan.id), { status: 409 });
}));
test('verification credentials bypass managed-host readiness only inside a live, current plan', async () => fixture(({ db, ssh, policy, seedTrial, nodeId, principal }) => {
  const plan = seedTrial(); assert.throws(() => ssh.issue(principal, { nodeId, purpose: 'normal login' }), { status: 503 });
  const issued = ssh.issueVerification(plan.id); assert.equal(issued.credential.kind, 'verification'); assert.equal(issued.credential.sessionSeconds, 60);
  assert.throws(() => ssh.authenticate(randomUUID(), policy.account, issued.password, randomUUID()), { status: 403 });
  assert.throws(() => ssh.authenticate(nodeId, 'sp_other', issued.password, randomUUID()), { status: 403 });
  assert.equal(ssh.authenticate(nodeId, policy.account, issued.password, randomUUID()).credentialId, issued.credential.id);
  assert.throws(() => ssh.authenticate(nodeId, policy.account, issued.password, randomUUID()), { status: 403 });
  for (const kind of ['expired','revoked']) { const value = ssh.issueVerification(plan.id, kind); assert.throws(() => ssh.authenticate(nodeId, policy.account, value.password, randomUUID()), { status: 403 }); }
  const last = ssh.issueVerification(plan.id); db.prepare("UPDATE ssh_takeover_plans SET state='rolling-back',payload=json_set(payload,'$.state','rolling-back') WHERE id=?").run(plan.id);
  assert.throws(() => ssh.authenticate(nodeId, policy.account, last.password, randomUUID()), { status: 403 });
}));
test('host receipts cannot manufacture independent verification or commit an incomplete checklist', async () => fixture(({ db, service, helper, nodeId, seedTrial, receipt }) => {
  const plan = seedTrial(); plan.command = { id: randomUUID(), planId: plan.id, action: 'commit', baselineDigest: plan.inventory.digest, account: plan.binding.account, policyId: plan.binding.policyId, policyRevision: plan.binding.revision, probePublicKey: null, verificationId: randomUUID() }; plan.verificationId = plan.command.verificationId;
  plan.evidence = [{ check: 'legacy-probe-key-accepted', passed: true, collectedAt: new Date().toISOString() }];
  db.prepare('UPDATE ssh_takeover_plans SET payload=? WHERE id=?').run(JSON.stringify(plan), plan.id);
  const incoming = { ...receipt(plan), local: { ...plan.local, state: 'managed', verificationId: plan.verificationId }, inventory: { ...plan.inventory, digest: plan.local.appliedDigest } };
  assert.throws(() => service.receive(nodeId, helper.credentialId, incoming), { status: 409 });
  assert.equal(service.get(plan.id).state, 'awaiting-verification');
}));
test('revocation derives a stable recovery command without poll mutations and restart retains recovery intent', async () => fixture(({ db, service, nodeId, principal, seedTrial }) => {
  const plan = seedTrial(); db.prepare('UPDATE users SET disabled_at=? WHERE id=?').run(new Date().toISOString(), principal.userId);
  const before = db.prepare('SELECT total_changes() AS n').get().n, command = service.next(nodeId); assert.equal(command.action, 'rollback'); assert.equal(service.next(nodeId).id, command.id); assert.equal(db.prepare('SELECT total_changes() AS n').get().n, before);
  service.recover(); assert.equal(service.get(plan.id).state, 'rolling-back'); assert.equal(service.get(plan.id).command.action, 'rollback');
}));
test('reverification uses fresh signed committed state and never queues an authentication rollback', async () => fixture(async ({ db, service, helpers, helper, principal, nodeId, inventory, seedTrial }) => {
  const plan = seedTrial(); plan.state = 'managed'; plan.local.state = 'managed'; plan.local.verificationId = randomUUID(); plan.verificationId = plan.local.verificationId; plan.local.rollbackAt = new Date(Date.now()-3600000).toISOString();
  const save = () => db.prepare('UPDATE ssh_takeover_plans SET state=?,payload=? WHERE id=?').run(plan.state,JSON.stringify(plan),plan.id); save();
  assert.throws(()=>service.reverify(principal,plan.id),{status:409});
  const report = { collectedAt:new Date().toISOString(),supported:true,reason:'native inventory',platform:'debian-12',version:'fixture',inventory:{...inventory,digest:plan.local.appliedDigest},takeover:plan.local };
  helpers.report({nodeId,credentialId:helper.credentialId},{...report,inventory:{...report.inventory,digest:'c'.repeat(64)}});
  assert.throws(()=>service.reverify(principal,plan.id),{status:409});
  helpers.report({nodeId,credentialId:helper.credentialId},report);
  const trial = service.reverify(principal,plan.id); assert.equal(trial.command,null); assert.equal(trial.local.state,'managed');
  await new Promise(resolve=>setImmediate(resolve));
  const verified = service.get(plan.id); assert.equal(verified.state,'managed'); assert.notEqual(verified.verificationId,plan.local.verificationId); assert.equal(verified.local.verificationId,plan.local.verificationId); assert.equal(verified.evidence.length,SSH_VERIFICATION_CHECKS.length);
  assert.equal(db.prepare('SELECT verification_id FROM ssh_hosts WHERE node_id=?').get(nodeId).verification_id,verified.verificationId);
  const restarted = service.reverify(principal,plan.id); assert.equal(restarted.state,'awaiting-verification'); service.recover(); assert.equal(service.get(plan.id).state,'drifted'); assert.equal(service.next(nodeId),null);
  await new Promise(resolve=>setImmediate(resolve)); assert.equal(service.get(plan.id).state,'drifted');
}));
