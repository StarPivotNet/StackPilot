import { z } from "zod";
import { SshWorkspaceSchema, SshTakeoverPlanSchema, SshPolicySchema, SshCredentialSchema, SshSessionSchema, type SshPolicyInput, type SshTakeoverInput } from "@stackpilot/contracts";
import { requestJson } from "./client";

export const fetchSshWorkspace = (signal?: AbortSignal) => requestJson("/ssh/workspace", { signal }).then(SshWorkspaceSchema.parse);
export const fetchSshPlans = (signal?: AbortSignal) => requestJson("/ssh/takeover-plans", { signal }).then(z.object({ plans: z.array(SshTakeoverPlanSchema), collectedAt: z.string().datetime() }).parse);
function post(path: string, body: unknown, proof: string, signal?: AbortSignal) { return requestJson(path, { method: "POST", headers: { "X-Reauth-Proof": proof }, body: JSON.stringify(body), signal }); }
export const saveSshPolicy = (input: SshPolicyInput, proof: string, signal?: AbortSignal) => post("/ssh/policies", input, proof, signal).then(SshPolicySchema.parse);
export const createSshPlan = (input: SshTakeoverInput, proof: string, signal?: AbortSignal) => post("/ssh/takeover-plans", input, proof, signal).then(SshTakeoverPlanSchema.parse);
export const actOnSshPlan = (id: string, action: "apply" | "rollback" | "reverify", proof: string, signal?: AbortSignal) => post(`/ssh/takeover-plans/${encodeURIComponent(id)}/${action}`, {}, proof, signal).then(SshTakeoverPlanSchema.parse);
const IssuedSchema = z.object({ credential: SshCredentialSchema, password: z.string().regex(/^[A-Za-z0-9_-]{43}$/), address: z.string(), port: z.number(), fingerprints: z.array(z.string()) });
export type IssuedSshCredential = z.infer<typeof IssuedSchema>;
export const issueSshCredential = (nodeId: string, purpose: string, sessionSeconds: number, proof: string, signal?: AbortSignal) => post("/ssh/credentials", { nodeId, purpose, sessionSeconds }, proof, signal).then(IssuedSchema.parse);
export const revokeSshCredential = (id: string, proof: string, signal?: AbortSignal) => post(`/ssh/credentials/${encodeURIComponent(id)}/revoke`, {}, proof, signal).then(SshCredentialSchema.parse);
export const terminateSshSession = (id: string, proof: string, signal?: AbortSignal) => post(`/ssh/sessions/${encodeURIComponent(id)}/terminate`, {}, proof, signal).then(SshSessionSchema.parse);
export const enrollSshHelper = (nodeId: string, proof: string, signal?: AbortSignal) => post("/ssh/helper-enrollments", { nodeId }, proof, signal).then(z.object({ id: z.string().uuid(), nodeId: z.string().uuid(), token: z.string().regex(/^[A-Za-z0-9_-]{43}$/), expiresAt: z.string().datetime() }).parse);
