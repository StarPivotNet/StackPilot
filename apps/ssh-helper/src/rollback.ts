import { RootStore } from "./store.js";
import { TakeoverJournalStore } from "./takeoverJournal.js";
import { TakeoverTransaction } from "./takeover.js";
import { TakeoverHost } from "./takeoverHost.js";
import { requireNativeSshHost } from "./environment.js";
import { isEntrypoint } from "./entrypoint.js";

/** Runs under flock in a standalone systemd unit, without Controller, Agent,
 * helper identity or network dependencies. */
export async function rollbackEntry(action: string) {
  await requireNativeSshHost();
  if (action !== "boot" && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(action)) throw new Error("Invalid SSH recovery plan");
  const store = new RootStore("/var/lib/stackpilot-ssh-helper"); await store.prepare();
  const transaction = new TakeoverTransaction(new TakeoverJournalStore(store), new TakeoverHost());
  const result = action === "boot" ? await transaction.recoverAfterBoot() : await transaction.rollback(action);
  process.stdout.write(JSON.stringify({ state: result?.state ?? "unmanaged", planId: result?.planId ?? null }) + "\n");
}
if (await isEntrypoint(import.meta.url)) void rollbackEntry(process.argv[2] ?? "").catch(() => { process.stderr.write("SSH recovery could not be verified; out-of-band recovery may be required.\n"); process.exitCode = 1; });
