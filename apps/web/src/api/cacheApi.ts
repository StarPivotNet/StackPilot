import { NetworkCachePlanResponseSchema } from "@stackpilot/contracts";
import type { NetworkCachePlanResponse } from "@stackpilot/contracts";
import { requestJson } from "./client";

export type { NetworkCacheNodeState, NetworkCachePlanResponse, NetworkCacheStats } from "@stackpilot/contracts";

export function fetchCachePlan(signal?: AbortSignal) {
  return requestJson<NetworkCachePlanResponse>("/network/cache", { signal }).then((payload) => NetworkCachePlanResponseSchema.parse(payload));
}
