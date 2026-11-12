import { randomUUID } from "node:crypto";
import { TakeoverJournalSchema, type TakeoverJournal } from "./takeoverJournal.js";
import type { SshPreflight } from "./preflight.js";

export type TakeoverOperations = {
  now(): number; bootMs(): Promise<number>; bootId(): Promise<string>;
  inspect(): Promise<SshPreflight>;
  backup(): Promise<TakeoverJournal["backups"]>;
  armRollback(planId: string, deadlineBootMs: number): Promise<void>;
  rollbackArmed(planId: string): Promise<boolean>;
  cancelRollback(planId: string): Promise<void>;
  apply(snapshot: SshPreflight): Promise<void>;
  restore(backups: TakeoverJournal["backups"]): Promise<void>;
  verifyRestored(backups: TakeoverJournal["backups"]): Promise<void>;
  terminateLegacy(connections: TakeoverJournal["connections"]): Promise<void>;
};
type JournalStore = { read(): Promise<TakeoverJournal | null>; write(value: TakeoverJournal): Promise<void> };
/** All mutations run under the host's kernel operation lock. Network calls and
 * independent Controller verification must happen outside that critical section. */
export class TakeoverTransaction {
  constructor(private readonly store: JournalStore, private readonly operations: TakeoverOperations) {}
  private async save(journal: TakeoverJournal, state: TakeoverJournal["state"]) { journal.state = state; journal.updatedAt = new Date(this.operations.now()).toISOString(); await this.store.write(journal); }
  private async current(planId: string) { const value = await this.store.read(); if (!value || value.planId !== planId) throw new Error("SSH takeover plan does not own the local journal"); return value; }
  private async expired(journal: TakeoverJournal) { return journal.bootId !== await this.operations.bootId() || journal.rollbackBootMs <= await this.operations.bootMs() || Date.parse(journal.rollbackAt) <= this.operations.now(); }
  async apply(planId: string, baselineDigest: string) {
    if (!/^[0-9a-f-]{36}$/.test(planId) || !/^[0-9a-f]{64}$/.test(baselineDigest)) throw new Error("Invalid SSH takeover request");
    const previous = await this.store.read();
    if (previous?.planId === planId) {
      if (previous.baselineDigest !== baselineDigest) throw new Error("Idempotent SSH request changed its baseline");
      if (previous.state === "managed" || previous.state === "rolled-back") return previous;
      if (previous.state === "awaiting-verification" && !await this.expired(previous) && await this.operations.rollbackArmed(planId)) return previous;
      // A partial application is never replayed after a lost response or restart.
      return this.rollback(planId);
    }
    if (previous && previous.state !== "rolled-back") throw new Error("Another SSH takeover journal requires resolution");
    const snapshot = await this.operations.inspect(); if (snapshot.digest !== baselineDigest) throw new Error("SSH configuration changed after preflight");
    const createdAt = new Date(this.operations.now()).toISOString();
    const journal = TakeoverJournalSchema.parse({ protocol: 1, planId, bootId: await this.operations.bootId(), baselineDigest, appliedDigest: null, state: "prepared", createdAt, updatedAt: createdAt, rollbackAt: new Date(this.operations.now() + 300_000).toISOString(), rollbackBootMs: await this.operations.bootMs() + 300_000, verificationId: null, backups: await this.operations.backup(), connections: snapshot.connections });
    await this.store.write(journal);
    try {
      await this.operations.armRollback(planId, journal.rollbackBootMs);
      if (!await this.operations.rollbackArmed(planId) || await this.expired(journal)) throw new Error("Independent SSH rollback protection is unavailable");
      // Recheck immediately before changing either authentication file.
      if ((await this.operations.inspect()).digest !== baselineDigest) throw new Error("SSH configuration drifted during preparation");
      await this.save(journal, "applying"); await this.operations.apply(snapshot);
      const applied = await this.operations.inspect(); journal.appliedDigest = applied.digest;
      // Include connections admitted by the old listener between preflight and
      // reload, including unfinished old-auth handshakes. Verification starts
      // only after this receipt has been persisted and returned.
      journal.connections = [...new Map([...journal.connections, ...applied.connections].map(value => [`${value.pid}:${value.start}`, value])).values()];
      if (await this.expired(journal) || !await this.operations.rollbackArmed(planId)) throw new Error("SSH rollback deadline passed during application");
      await this.save(journal, "awaiting-verification"); return journal;
    } catch (error) { await this.rollback(planId); throw error; }
  }
  async commit(planId: string, verificationId: string) {
    const journal = await this.current(planId);
    // UUID is a reference to Controller-held evidence, not a claim of verification.
    if (!/^[0-9a-f-]{36}$/.test(verificationId)) throw new Error("Missing independent SSH verification reference");
    if (journal.state === "managed" && journal.verificationId === verificationId) return journal;
    if (journal.state !== "awaiting-verification" || await this.expired(journal) || !await this.operations.rollbackArmed(planId)) throw new Error("SSH takeover is not eligible for commit");
    if ((await this.operations.inspect()).digest !== journal.appliedDigest) { await this.rollback(planId); throw new Error("Managed SSH configuration changed before commit"); }
    journal.verificationId = verificationId; await this.save(journal, "committing");
    try {
      await this.operations.terminateLegacy(journal.connections);
      if (await this.expired(journal) || (await this.operations.inspect()).digest !== journal.appliedDigest) throw new Error("SSH takeover changed while closing legacy connections");
      await this.save(journal, "managed");
    } catch (error) { await this.rollback(planId); throw error; }
    // Persist commit before cancelling the timer: a late timer must never reopen old auth.
    await this.operations.cancelRollback(planId); return journal;
  }
  async rollback(planId: string) {
    const journal = await this.current(planId);
    if (journal.state === "managed" || journal.state === "rolled-back") return journal;
    await this.save(journal, "rolling-back");
    try { await this.operations.restore(journal.backups); await this.operations.verifyRestored(journal.backups); }
    catch (error) { await this.save(journal, "manual-recovery-required"); throw error; }
    await this.save(journal, "rolled-back"); await this.operations.cancelRollback(planId); return journal;
  }
  async recoverAfterBoot() { const journal = await this.store.read(); if (journal && journal.state !== "managed" && journal.state !== "rolled-back") return this.rollback(journal.planId); return journal; }
}

// No caller-provided journal filename, shell command or executable path is accepted.
export function newTakeoverPlanId() { return randomUUID(); }
