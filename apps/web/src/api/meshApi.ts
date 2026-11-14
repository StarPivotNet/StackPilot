import { NetworkMeshPlanResponseSchema } from "@stackpilot/contracts";
import type { NetworkMeshPlanResponse } from "@stackpilot/contracts";
import { requestJson } from "./client";

export type { NetworkMeshHandshake, NetworkMeshNodeState, NetworkMeshPlanResponse } from "@stackpilot/contracts";

export function fetchMeshPlan(signal?: AbortSignal) {
  return requestJson<NetworkMeshPlanResponse>("/network/mesh", { signal }).then((payload) => NetworkMeshPlanResponseSchema.parse(payload));
}
