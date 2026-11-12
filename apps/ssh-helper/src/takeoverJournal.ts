import { z } from "zod";
import type { RootStore } from "./store.js";

const BackupSchema = z.object({ path: z.enum(["/etc/ssh/sshd_config", "/etc/pam.d/sshd"]), contents: z.string().max(1024 * 1024), mode: z.number().int().min(0).max(0o7777), gid: z.number().int().min(0), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const TakeoverJournalSchema = z.object({
  protocol: z.literal(1), planId: z.string().uuid(), bootId: z.string().uuid(), baselineDigest: z.string().regex(/^[a-f0-9]{64}$/), appliedDigest: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  state: z.enum(["prepared", "applying", "awaiting-verification", "committing", "managed", "rolling-back", "rolled-back", "manual-recovery-required"]),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(), rollbackAt: z.string().datetime(), rollbackBootMs: z.number().positive(),
  verificationId: z.string().uuid().nullable(), backups: z.array(BackupSchema).length(2).refine(values => new Set(values.map(value => value.path)).size === 2),
  connections: z.array(z.object({ pid: z.number().int().min(2), ppid: z.number().int().min(1), start: z.string().regex(/^\d+$/) }).strict()).max(1024),
}).strict();
export type TakeoverJournal = z.infer<typeof TakeoverJournalSchema>;
export class TakeoverJournalStore {
  constructor(private readonly store: RootStore) {}
  async read() { try { return TakeoverJournalSchema.parse(JSON.parse(await this.store.read("takeover.json"))); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; } }
  async write(value: TakeoverJournal) { await this.store.write("takeover.json", JSON.stringify(TakeoverJournalSchema.parse(value))); }
}
