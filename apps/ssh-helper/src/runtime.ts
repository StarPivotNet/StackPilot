import { setTimeout as delay } from "node:timers/promises";
import type { ControllerClient, HelperIdentity } from "./controllerClient.js";
import { ControllerError } from "./controllerClient.js";
import type { ProcessInspector } from "./processes.js";
import type { SessionScopes } from "./systemd.js";
import type { LocalSession, RootStore } from "./store.js";

export class SessionRuntime {
  private records: LocalSession[] = [];
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly store: RootStore, private readonly controller: ControllerClient, private readonly identity: HelperIdentity, private readonly processes: ProcessInspector, private readonly scopes: SessionScopes, private readonly accounts: { verify(account: string): Promise<void> } = { verify: async () => { throw new Error("SSH account verifier unavailable"); } }) {}
  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation); this.tail = result.catch(() => undefined); return result;
  }
  async initialize() { this.records = await this.store.sessions(); await this.synchronize(); }
  async authenticate(monitorPid: number, phasePid: number, account: string, password: string) {
    return this.exclusive(async () => {
      if (this.records.length >= 1024) throw new Error("SSH connection limit reached");
      await this.accounts.verify(account);
      const connection = await this.processes.connection(monitorPid, phasePid);
      if (this.records.some(record => record.session.connectionId === connection.connectionId && !record.terminated)) throw new Error("SSH connection already authenticated");
      const before = await this.processes.bootMs();
      const session = await this.controller.authenticate(this.identity, account, password, connection.connectionId);
      const record: LocalSession = { session, bootId: connection.bootId, monitorPid, monitorStart: connection.monitor.start, scope: `stackpilot-ssh-${session.id}.scope`, cgroup: `/system.slice/stackpilot-ssh-${session.id}.scope`, deadlineBootMs: before + Date.parse(session.expiresAt) - Date.parse(session.startedAt), terminationRequested: false, terminated: false, acknowledged: false };
      this.records.push(record); await this.store.saveSessions(this.records);
      try {
        const monitor = await this.processes.sshd(monitorPid); if (monitor.start !== record.monitorStart) throw new Error("SSH monitor changed");
        await this.scopes.create(record.scope, await this.processes.descendants(monitorPid), record.deadlineBootMs - await this.processes.bootMs());
        let attached = false;
        for (let attempt = 0; attempt < 50; attempt++) {
          const cgroup = await this.processes.cgroup(monitorPid);
          if (cgroup.endsWith(`/${record.scope}`)) { record.cgroup = cgroup; attached = true; break; } await delay(20);
        }
        if (!attached) throw new Error("SSH connection not attached to its scope");
        if ((await this.processes.identity(monitorPid)).start !== record.monitorStart) throw new Error("SSH monitor changed");
        await this.store.saveSessions(this.records);
      } catch (error) { await this.stop(record).catch(() => undefined); throw error; }
    });
  }
  async check(phasePid: number, account: string) {
    return this.exclusive(async () => {
      await this.processes.sshd(phasePid); const cgroup = await this.processes.cgroup(phasePid); const bootId = await this.processes.bootId();
      await this.accounts.verify(account);
      const record = this.records.find(value => value.cgroup === cgroup && value.session.account === account && value.bootId === bootId && !value.terminated && !value.terminationRequested);
      if (!record || record.deadlineBootMs <= await this.processes.bootMs()) throw new Error("SSH session is not authorized");
    });
  }
  async terminateAccount(account: string) {
    return this.exclusive(async () => { for (const record of this.records) if (record.session.account === account && !record.terminated) await this.stop(record); });
  }
  private async stop(record: LocalSession) {
    if (record.terminated) return;
    record.terminationRequested = true; await this.store.saveSessions(this.records);
    if (record.bootId === await this.processes.bootId()) {
      const members = await this.processes.members(record.cgroup);
      if (members.length) { await this.scopes.stop(record.scope); if ((await this.processes.members(record.cgroup)).length) throw new Error("SSH scope has not stopped"); }
      let alive = false;
      try { alive = (await this.processes.identity(record.monitorPid)).start === record.monitorStart; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT" && (error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      if (alive) throw new Error("SSH monitor has not stopped");
    }
    record.terminated = true; await this.store.saveSessions(this.records);
  }
  async synchronize() {
    return this.exclusive(async () => {
      let remote: Awaited<ReturnType<ControllerClient["state"]>> | null = null; let revoked = false;
      try { remote = await this.controller.state(this.identity); } catch (error) { revoked = error instanceof ControllerError && (error.status === 401 || error.status === 403); }
      const bootId = await this.processes.bootId(); const now = await this.processes.bootMs();
      let failed = false;
      for (const record of this.records) {
        try {
        if (!record.terminated) {
          const authorization = remote?.sessions.find(value => value.id === record.session.id && value.connectionId === record.session.connectionId);
          let accountValid = true; try { await this.accounts.verify(record.session.account); } catch { accountValid = false; }
          if (!accountValid || record.terminationRequested || revoked || (remote && (!authorization || authorization.terminate)) || record.bootId !== bootId || record.deadlineBootMs <= now || !(await this.processes.members(record.cgroup)).length) await this.stop(record);
        }
        if (record.terminated && !record.acknowledged) {
          try { await this.controller.acknowledge(this.identity, record.session); record.acknowledged = true; } catch { /* Durable receipt is retried on the next cycle. */ }
        }
        } catch { failed = true; }
      }
      this.records = this.records.filter(record => !record.acknowledged); await this.store.saveSessions(this.records);
      if (failed) throw new Error("Some SSH sessions require reconciliation");
      return remote;
    });
  }
}
