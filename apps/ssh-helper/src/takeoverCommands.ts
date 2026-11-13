import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { realpath } from "node:fs/promises";
import { SshInventorySchema, SshTakeoverCommandSchema, SshTakeoverLocalSchema, type SshTakeoverCommand, type SshTakeoverReceipt } from "@stackpilot/contracts";
import type { RootStore } from "./store.js";
import { TakeoverJournalStore } from "./takeoverJournal.js";
import { ProbeKeys } from "./probeKeys.js";
import { SshPreflightInspector } from "./preflight.js";
import { rootDirectory, rootExecutable, rootFile } from "./files.js";

type AccountBinding = { binding(account: string, policyId: string, revision: number): Promise<{ uid: number; home: string }> };
const execute = promisify(execFile);
export class TakeoverCommands {
  constructor(private readonly store: RootStore, private readonly accounts: AccountBinding, private readonly inspector = new SshPreflightInspector()) {}
  async local() {
    const journal = await new TakeoverJournalStore(this.store).read();
    return journal ? SshTakeoverLocalSchema.parse({ planId: journal.planId, state: journal.state, baselineDigest: journal.baselineDigest, appliedDigest: journal.appliedDigest, rollbackAt: journal.rollbackAt, verificationId: journal.verificationId }) : null;
  }
  private async worker(command: SshTakeoverCommand) {
    if (await realpath(this.store.directory) !== "/var/lib/stackpilot-ssh-helper") throw new Error("SSH takeover requires the installed systemd state directory");
    const path = fileURLToPath(new URL("./transactionWorker.js", import.meta.url));
    await rootDirectory(dirname(path)); await rootFile(path); await rootExecutable(await realpath("/usr/bin/node")); await rootExecutable(await realpath("/usr/bin/flock"));
    const proof = command.action === "apply" ? command.baselineDigest : command.action === "commit" ? command.verificationId : null;
    if (command.action !== "rollback" && !proof) throw new Error("SSH transaction proof is missing");
    await execute("/usr/bin/flock", ["--no-fork", "--exclusive", "--timeout", "30", "/var/lib/stackpilot-ssh-helper/takeover.lock", "/usr/bin/node", path, command.action, command.planId, ...(proof ? [proof] : [])], { encoding: "utf8", timeout: 90_000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024, env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C", LC_ALL: "C" } });
  }
  async execute(raw: SshTakeoverCommand): Promise<SshTakeoverReceipt> {
    const command = SshTakeoverCommandSchema.parse(raw);
    const result: SshTakeoverReceipt = { commandId: command.id, planId: command.planId, successful: false, inventory: null, local: null, error: null };
    try {
      if (command.action === "preflight") { if (await realpath(this.store.directory) !== "/var/lib/stackpilot-ssh-helper") throw new Error("SSH takeover requires the installed systemd state directory"); result.inventory = SshInventorySchema.parse(await this.inspector.inspect()); }
      else if (command.action === "probe-key") {
        if (!command.account || !command.policyId || !command.policyRevision || !command.probePublicKey) throw new Error("Missing probe binding");
        const binding = await this.accounts.binding(command.account, command.policyId, command.policyRevision);
        await new ProbeKeys(this.store).prepare({ account: command.account, planId: command.planId, publicKey: command.probePublicKey, binding });
      } else if (command.action === "remove-probe-key") {
        if (!command.account) throw new Error("Missing probe account"); await new ProbeKeys(this.store).remove(command.planId, command.account);
      } else {
        const previous = await this.local();
        if (command.action !== "rollback" || previous?.planId === command.planId) await this.worker(command);
        else if (previous && !["rolled-back", "managed"].includes(previous.state)) throw new Error("Another local takeover requires recovery");
        const local = await this.local(); result.local = local?.planId === command.planId ? local : null;
        result.inventory = SshInventorySchema.parse(await this.inspector.inspect());
      }
      result.successful = true;
    } catch {
      const local = await this.local().catch(() => null); result.local = local?.planId === command.planId ? local : null;
      result.error = result.local?.state === "manual-recovery-required" ? "MANUAL_RECOVERY_REQUIRED" : command.action === "preflight" ? "PREFLIGHT_FAILED" : command.action === "probe-key" ? "PROBE_PREPARATION_FAILED" : "TRANSACTION_FAILED";
    }
    return result;
  }
}
