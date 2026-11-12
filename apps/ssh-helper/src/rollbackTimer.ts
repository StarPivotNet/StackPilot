import { runCommand, type CommandRunner } from "./commands.js";
import { rootFile } from "./files.js";
import { setTimeout as delay } from "node:timers/promises";

export class RollbackTimer {
  constructor(private readonly run: CommandRunner = runCommand) {}
  private names(planId: string) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(planId)) throw new Error("Invalid SSH rollback plan");
    return { timer: `stackpilot-ssh-rollback@${planId}.timer`, service: `stackpilot-ssh-rollback@${planId}.service` };
  }
  async arm(planId: string, deadlineBootMs: number) {
    const { timer } = this.names(planId);
    if (!Number.isFinite(deadlineBootMs) || deadlineBootMs <= 0 || deadlineBootMs * 1000 > Number.MAX_SAFE_INTEGER) throw new Error("Invalid SSH rollback deadline");
    const source = await rootFile("/etc/systemd/system/stackpilot-ssh-rollback@.service");
    if (!source.includes("/usr/bin/flock") || !source.includes("/apps/ssh-helper/dist/rollback.js %i")) throw new Error("Independent SSH rollback service is unavailable");
    await this.run("/usr/bin/busctl", ["call", "org.freedesktop.systemd1", "/org/freedesktop/systemd1", "org.freedesktop.systemd1.Manager", "StartTransientUnit", "ssa(sv)a(sa(sv))", timer, "fail", "4", "Description", "s", "StackPilot independent SSH rollback deadline", "TimersMonotonic", "a(st)", "1", "OnBootSec", String(Math.floor(deadlineBootMs * 1000)), "WakeSystem", "b", "true", "AccuracyUSec", "t", "1000000", "0"]);
    for (let attempt = 0; attempt < 50; attempt++) { if (await this.armed(planId)) return; await delay(20); }
    throw new Error("Independent SSH rollback timer did not start");
  }
  async armed(planId: string) {
    const { timer, service } = this.names(planId);
    const output = await this.run("/usr/bin/systemctl", ["show", timer, "--property=ActiveState,SubState,Unit,WakeSystem"]);
    const values = Object.fromEntries(output.trim().split("\n").map(value => { const equal = value.indexOf("="); return [value.slice(0, equal), value.slice(equal + 1)]; }));
    return values.ActiveState === "active" && values.SubState === "waiting" && values.Unit === service && values.WakeSystem === "yes";
  }
  async cancel(planId: string) {
    const { timer } = this.names(planId);
    const loadState = async () => (await this.run("/usr/bin/systemctl", ["show", timer, "--property=LoadState", "--value"])).trim();
    // Transient timers disappear on reboot or after collection. Recovery must
    // still succeed when there is nothing left to cancel.
    if (await loadState() === "not-found") return;
    try { await this.run("/usr/bin/systemctl", ["stop", "--", timer]); }
    catch (error) { if (await loadState() !== "not-found") throw error; }
  }
}
