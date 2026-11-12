import { z } from "zod";

export const SSH_LOGIN_WINDOW_SECONDS = 900;
export const SSH_MAX_SESSION_SECONDS = 28_800;
export const SshProfileSchema = z.enum(["shell", "service-operator", "host-admin"]);
export const SshStateSchema = z.enum(["unmanaged", "prechecked", "applying", "awaiting-verification", "managed", "rolling-back", "rolled-back", "manual-recovery-required", "drifted"]);
export const SshPolicyInputSchema = z.object({
  nodeId: z.string().uuid(), userId: z.string().uuid(), profile: SshProfileSchema,
  services: z.array(z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.@-]{0,127}\.service$/)).max(100).default([]),
  sessionSeconds: z.number().int().min(60).max(SSH_MAX_SESSION_SECONDS).default(SSH_MAX_SESSION_SECONDS),
  enabled: z.boolean(),
}).strict().refine(value => value.profile === "service-operator" ? value.services.length > 0 : value.services.length === 0, "服务列表必须与权限档位匹配");
export const SshPolicySchema = SshPolicyInputSchema.safeExtend({ id: z.string().uuid(), account: z.string(), revision: z.number().int(), appliedRevision: z.number().int(), updatedAt: z.string().datetime() });
export const SshIssueRequestSchema = z.object({ nodeId: z.string().uuid(), purpose: z.string().trim().min(1).max(500), sessionSeconds: z.number().int().min(60).max(SSH_MAX_SESSION_SECONDS).optional() }).strict();
export const SshCredentialSchema = z.object({ id: z.string().uuid(), nodeId: z.string().uuid(), userId: z.string().uuid(), policyId: z.string().uuid(), policyRevision: z.number().int(), account: z.string(), purpose: z.string(), createdAt: z.string().datetime(), loginExpiresAt: z.string().datetime(), sessionSeconds: z.number().int(), consumedAt: z.string().datetime().nullable(), revokedAt: z.string().datetime().nullable() });
export const SshSessionSchema = z.object({ id: z.string().uuid(), credentialId: z.string().uuid(), nodeId: z.string().uuid(), userId: z.string().uuid(), account: z.string(), connectionId: z.string().min(16).max(256), startedAt: z.string().datetime(), expiresAt: z.string().datetime(), terminationRequestedAt: z.string().datetime().nullable(), terminatedAt: z.string().datetime().nullable() });
export const SshHostSchema = z.object({ nodeId: z.string().uuid(), state: SshStateSchema, available: z.boolean(), reason: z.string(), address: z.string(), port: z.number().int().min(1).max(65535), fingerprints: z.array(z.string()), collectedAt: z.string().datetime().nullable() });
export const SshWorkspaceSchema = z.object({ hosts: z.array(SshHostSchema), policies: z.array(SshPolicySchema), credentials: z.array(SshCredentialSchema), sessions: z.array(SshSessionSchema), collectedAt: z.string().datetime() });
export type SshPolicy = z.infer<typeof SshPolicySchema>;
export type SshPolicyInput = z.infer<typeof SshPolicyInputSchema>;
export type SshCredential = z.infer<typeof SshCredentialSchema>;
export type SshSession = z.infer<typeof SshSessionSchema>;
export type SshHost = z.infer<typeof SshHostSchema>;
export type SshWorkspace = z.infer<typeof SshWorkspaceSchema>;
