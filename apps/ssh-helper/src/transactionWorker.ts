import { z } from "zod";
import { RootStore } from "./store.js";
import { TakeoverJournalStore } from "./takeoverJournal.js";
import { TakeoverTransaction } from "./takeover.js";
import { TakeoverHost } from "./takeoverHost.js";
import { requireNativeSshHost } from "./environment.js";
import { isEntrypoint } from "./entrypoint.js";

/** Invoked only under the same no-fork flock as the independent rollback unit. */
async function main() {
  await requireNativeSshHost();
  const action = z.enum(["apply", "commit", "rollback"]).parse(process.argv[2]), id = z.string().uuid().parse(process.argv[3]);
  const proof = action === "apply" ? z.string().regex(/^[0-9a-f]{64}$/).parse(process.argv[4]) : action === "commit" ? z.string().uuid().parse(process.argv[4]) : null;
  if (process.argv.length !== (action === "rollback" ? 4 : 5)) throw new Error("Unexpected SSH transaction arguments");
  const store = new RootStore("/var/lib/stackpilot-ssh-helper"); await store.prepare();
  const transaction = new TakeoverTransaction(new TakeoverJournalStore(store), new TakeoverHost());
  const result = action === "apply" ? await transaction.apply(id, proof!) : action === "commit" ? await transaction.commit(id, proof!) : await transaction.rollback(id);
  // Journal backups remain root-only; the caller receives bounded metadata only.
  process.stdout.write(JSON.stringify({ planId: result.planId, state: result.state, baselineDigest: result.baselineDigest, appliedDigest: result.appliedDigest, rollbackAt: result.rollbackAt, verificationId: result.verificationId }) + "\n");
}
if (await isEntrypoint(import.meta.url)) void main().catch(() => { process.stderr.write("SSH transaction failed; inspect its protected recovery journal and out-of-band access.\n"); process.exitCode = 1; });
