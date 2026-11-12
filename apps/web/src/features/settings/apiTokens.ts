import { ApiTokenListResponseSchema, CreateApiTokenRequestSchema, CreateApiTokenResponseSchema, type CreateApiTokenRequest } from "@stackpilot/contracts";
import { requestJson } from "../../api/client";

export const fetchSettingsTokens = (signal?: AbortSignal) => requestJson<unknown>("/tokens", { signal }).then((value) => ({ ...ApiTokenListResponseSchema.parse(value), receivedAt: Date.now() }));
export const createSettingsToken = (input: CreateApiTokenRequest, proof: string) => requestJson<unknown>("/tokens", {
  method: "POST", headers: { "X-Reauth-Proof": proof }, body: JSON.stringify(CreateApiTokenRequestSchema.parse(input)),
}).then((value) => CreateApiTokenResponseSchema.parse(value));
export const revokeSettingsToken = (id: string, proof: string) => requestJson<{ message: string }>(`/tokens/${encodeURIComponent(id)}`, {
  method: "DELETE", headers: { "X-Reauth-Proof": proof },
});
