import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { TakeoverTransaction } from "../../apps/ssh-helper/dist/takeover.js";

function fixture() {
  const planId = randomUUID(), bootId = randomUUID(), events = [], initial = 'a'.repeat(64), applied = 'b'.repeat(64);
  let persisted = null, time = Date.now(), bootMs = 1000, currentBoot = bootId, digest = initial, armed = false, failArm = false, failRestore = false, failLegacy = false, inspectCount = 0, driftAt = 0;
  const snapshot = () => ({ digest, connections: [{ pid: digest === initial ? 100 : 101, ppid: 10, start: '123' }] });
  const operations = {
    now: () => time, bootMs: async () => bootMs, bootId: async () => currentBoot,
    inspect: async () => { inspectCount++; if (inspectCount === driftAt) digest = 'c'.repeat(64); return snapshot(); },
    backup: async () => [{ path: '/etc/ssh/sshd_config', contents: 'old ssh', sha256: initial, mode: 0o644, gid: 0 }, { path: '/etc/pam.d/sshd', contents: 'old pam', sha256: initial, mode: 0o644, gid: 0 }],
    armRollback: async () => { events.push('arm'); if (failArm) throw new Error('timer unavailable'); armed = true; }, rollbackArmed: async () => armed,
    cancelRollback: async () => { events.push(`cancel:${persisted.state}`); armed = false; },
    apply: async () => { assert(armed); assert.equal(persisted.state, 'applying'); events.push('apply'); digest = applied; },
    restore: async () => { events.push('restore'); if (failRestore) throw new Error('disk failure'); digest = initial; },
    verifyRestored: async () => { events.push('verified-restore'); assert.equal(digest, initial); },
    terminateLegacy: async connections => { events.push('close-legacy'); assert.equal(persisted.state, 'committing'); assert.deepEqual(connections.map(value => value.pid), [100, 101]); if (failLegacy) throw new Error('connection remains'); },
  };
  const store = { read: async () => structuredClone(persisted), write: async value => { persisted = structuredClone(value); events.push(`save:${value.state}`); } };
  return { planId, initial, events, run: () => new TakeoverTransaction(store, operations), state: () => persisted, expire: () => { bootMs += 300_001; time += 300_001; }, reboot: () => { currentBoot = randomUUID(); bootMs = 1; }, failTimer: () => { failArm = true; }, failRestore: () => { failRestore = true; }, failLegacy: () => { failLegacy = true; }, driftAt: count => { driftAt = count; }, clearJournalState: state => { persisted.state = state; } };
}
test("takeover persists backups and arms independent rollback before touching authentication", async () => {
  const f = fixture(); await f.run().apply(f.planId, f.initial);
  assert.equal(f.state().state, 'awaiting-verification'); assert(f.events.indexOf('arm') < f.events.indexOf('apply'));
  const deadline = f.state().rollbackBootMs; await f.run().apply(f.planId, f.initial); assert.equal(f.state().rollbackBootMs, deadline); assert.equal(f.events.filter(value => value === 'arm').length, 1);
  const verification = randomUUID(); await f.run().commit(f.planId, verification); assert.equal(f.state().state, 'managed'); assert.equal(f.events.at(-1), 'cancel:managed');
  await f.run().rollback(f.planId); assert.equal(f.state().state, 'managed'); assert(!f.events.includes('restore')); await f.run().commit(f.planId, verification);
});
test("timer failure and drift during preparation restore verified originals without applying", async () => {
  for (const change of [f => f.failTimer(), f => f.driftAt(2)]) {
    const f = fixture(); change(f); await assert.rejects(f.run().apply(f.planId, f.initial));
    assert(!f.events.includes('apply')); assert.equal(f.state().state, 'rolled-back'); assert(f.events.includes('verified-restore'));
  }
});
test("expired or restarted partial trials cannot replay application or renew their deadline", async () => {
  for (const change of [f => f.expire(), f => f.reboot(), f => f.clearJournalState('applying')]) {
    const f = fixture(); await f.run().apply(f.planId, f.initial); const before = f.state().rollbackBootMs; change(f);
    await f.run().apply(f.planId, f.initial); assert.equal(f.state().state, 'rolled-back'); assert.equal(f.state().rollbackBootMs, before); assert.equal(f.events.filter(value => value === 'apply').length, 1);
  }
});
test("failed restoration stays explicitly recoverable and never claims rollback succeeded", async () => {
  const f = fixture(); await f.run().apply(f.planId, f.initial); f.failRestore(); await assert.rejects(f.run().rollback(f.planId)); assert.equal(f.state().state, 'manual-recovery-required'); assert(!f.events.includes('cancel:rolled-back'));
});
test("commit requires live trial, unchanged configuration and confirmed legacy closure", async () => {
  const expired = fixture(); await expired.run().apply(expired.planId, expired.initial); expired.expire(); await assert.rejects(expired.run().commit(expired.planId, randomUUID())); assert.equal(expired.state().state, 'awaiting-verification');
  const drift = fixture(); await drift.run().apply(drift.planId, drift.initial); drift.driftAt(4); await assert.rejects(drift.run().commit(drift.planId, randomUUID())); assert.equal(drift.state().state, 'rolled-back');
  const fail = fixture(); await fail.run().apply(fail.planId, fail.initial); fail.failLegacy(); await assert.rejects(fail.run().commit(fail.planId, randomUUID())); assert.equal(fail.state().state, 'rolled-back');
});
test("boot recovery restores unfinished trials and rejects a timer from another plan", async () => {
  const f = fixture(); await f.run().apply(f.planId, f.initial); await assert.rejects(f.run().rollback(randomUUID())); await f.run().recoverAfterBoot(); assert.equal(f.state().state, 'rolled-back');
});
