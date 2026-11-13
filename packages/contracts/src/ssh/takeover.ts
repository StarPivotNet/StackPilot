import { z } from "zod";

const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Account = z.string().regex(/^sp_[a-z0-9]{1,25}$/);
export const SshProcessIdentitySchema = z.object({ pid: z.number().int().min(2), ppid: z.number().int().min(1), start: z.string().regex(/^\d+$/) }).strict();
export const SshInventorySchema = z.object({
  collectedAt: z.string().datetime(), digest: Digest,
  files: z.array(z.object({ path: z.string().startsWith("/").max(4096), sha256: Digest, mode: z.number().int().min(0).max(0o7777), uid: z.literal(0), gid: z.number().int().min(0) }).strict()).max(128),
  listeners: z.array(z.object({ address: z.string().max(253), port: z.number().int().min(1).max(65535), pids: z.array(z.number().int().min(1)).max(128) }).strict()).min(1).max(128),
  fingerprints: z.array(z.string().regex(/^SHA256:[A-Za-z0-9+/]{43}$/)).min(1).max(8), hostKeys: z.array(z.string().startsWith("/").max(4096)).min(1).max(8),
  authentication: z.record(z.string().max(100), z.array(z.string().max(4096)).max(100)), matches: z.array(z.string().max(512)).max(128),
  listener: SshProcessIdentitySchema, connections: z.array(SshProcessIdentitySchema).max(1024), socketActive: z.boolean(),
}).strict();
export const SshTakeoverStateSchema = z.enum(["prechecking", "prechecked", "applying", "awaiting-verification", "managed", "rolling-back", "rolled-back", "manual-recovery-required", "failed", "drifted"]);
export const SshTakeoverInputSchema = z.object({ nodeId: z.string().uuid(), requestId: z.string().uuid(), address: z.union([z.ipv4(), z.ipv6(), z.hostname()]), port: z.number().int().min(1).max(65535).default(22), outOfBandConfirmed: z.literal(true) }).strict();
export const SshTakeoverCommandSchema = z.object({
  id: z.string().uuid(), planId: z.string().uuid(), action: z.enum(["preflight", "probe-key", "apply", "commit", "rollback", "remove-probe-key"]),
  baselineDigest: Digest.nullable(), account: Account.nullable(), policyId: z.string().uuid().nullable(), policyRevision: z.number().int().positive().nullable(),
  probePublicKey: z.string().regex(/^ssh-rsa [A-Za-z0-9+/=]{100,8192}$/).nullable(), verificationId: z.string().uuid().nullable(),
}).strict();
export const SshTakeoverLocalSchema = z.object({ planId: z.string().uuid(), state: z.enum(["prepared", "applying", "awaiting-verification", "committing", "managed", "rolling-back", "rolled-back", "manual-recovery-required"]), baselineDigest: Digest, appliedDigest: Digest.nullable(), rollbackAt: z.string().datetime(), verificationId: z.string().uuid().nullable() }).strict();
export const SshTakeoverReceiptSchema = z.object({ commandId: z.string().uuid(), planId: z.string().uuid(), successful: z.boolean(), inventory: SshInventorySchema.nullable(), local: SshTakeoverLocalSchema.nullable(), error: z.enum(["PREFLIGHT_FAILED", "PROBE_PREPARATION_FAILED", "TRANSACTION_FAILED", "MANUAL_RECOVERY_REQUIRED"]).nullable() }).strict();
export const SshTakeoverPlanSchema = SshTakeoverInputSchema.safeExtend({
  id: z.string().uuid(), requestedBy: z.string().uuid(), state: SshTakeoverStateSchema,
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(), inventory: SshInventorySchema.nullable(), local: SshTakeoverLocalSchema.nullable(),
  command: SshTakeoverCommandSchema.nullable(), error: z.string().max(500).nullable(),
  binding: z.object({ policyId: z.string().uuid(), revision: z.number().int().positive(), account: Account, uid: z.number().int().min(1000) }).nullable().default(null),
  lastReceiptId: z.string().uuid().nullable().default(null),
  verificationId: z.string().uuid().nullable().default(null),
  appliedInventory: SshInventorySchema.nullable().default(null),
  evidence: z.array(z.object({ check: z.string().max(100), passed: z.boolean(), collectedAt: z.string().datetime() }).strict()).max(64),
});
export type SshInventory = z.infer<typeof SshInventorySchema>;
export type SshTakeoverPlan = z.infer<typeof SshTakeoverPlanSchema>;
export type SshTakeoverInput = z.infer<typeof SshTakeoverInputSchema>;
export type SshTakeoverCommand = z.infer<typeof SshTakeoverCommandSchema>;
export type SshTakeoverReceipt = z.infer<typeof SshTakeoverReceiptSchema>;
