import { z } from "zod";

export const SSH_HELPER_PROTOCOL = "1";
export const SshHelperEnrollmentInputSchema = z.object({ nodeId: z.string().uuid() }).strict();
export const SshHelperEnrollSchema = z.object({ enrollmentToken: z.string().min(32).max(256), publicKey: z.string().min(32).max(1024) }).strict();
export const SshHelperAuthSchema = z.object({ nodeId: z.string().uuid(), credentialId: z.string().uuid(), timestamp: z.string().datetime(), nonce: z.string().regex(/^[A-Za-z0-9_-]{22,120}$/), signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/) }).strict();
export const SshHelperReportSchema = z.object({ collectedAt: z.string().datetime(), supported: z.boolean(), reason: z.string().max(500), platform: z.enum(["debian-12", "ubuntu-24.04", "unsupported"]), version: z.string().min(1).max(100) }).strict();
export const SshHelperLoginSchema = z.object({ account: z.string().regex(/^sp_[a-z0-9]{1,25}$/), password: z.string().regex(/^[A-Za-z0-9_-]{43}$/), connectionId: z.string().min(16).max(256) }).strict();
export const SshHelperSessionAckSchema = z.object({ sessionId: z.string().uuid(), connectionId: z.string().min(16).max(256) }).strict();
export const SshHelperStateSchema = z.object({ controllerTime: z.string().datetime(), sessions: z.array(z.object({ id: z.string().uuid(), connectionId: z.string(), terminate: z.boolean() })) });
export const SshHelperEnrolledSchema = z.object({ nodeId: z.string().uuid(), credentialId: z.string().uuid(), protocolVersion: z.literal("1") }).strict();
export type SshHelperAuth = z.infer<typeof SshHelperAuthSchema>;
export function sshHelperSignaturePayload(input: Omit<SshHelperAuth, "signature"> & { method: string; path: string; bodySha256: string }) {
  return ["stackpilot-ssh-helper-v1", input.nodeId, input.credentialId, input.method.toUpperCase(), input.path, input.timestamp, input.nonce, input.bodySha256].join("\n");
}
