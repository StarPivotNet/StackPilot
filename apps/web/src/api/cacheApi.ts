import { NetworkCacheDownloadJobListResponseSchema, NetworkCacheDownloadRequestSchema, NetworkCacheDownloadResponseSchema, NetworkCachePlanResponseSchema, NetworkEgressPlanResponseSchema } from "@stackpilot/contracts";
import type { NetworkCacheDownloadJobListResponse, NetworkCacheDownloadRequest, NetworkCacheDownloadResponse, NetworkCachePlanResponse, NetworkEgressPlanResponse } from "@stackpilot/contracts";
import { requestJson } from "./client";

export type { NetworkCacheDownloadJob, NetworkCacheDownloadJobListResponse, NetworkCacheDownloadRequest, NetworkCacheNodeState, NetworkCachePlanResponse, NetworkCacheStats, NetworkEgressNode, NetworkEgressPlanResponse } from "@stackpilot/contracts";

export function fetchCachePlan(signal?: AbortSignal) {
  return requestJson<NetworkCachePlanResponse>("/network/cache", { signal }).then((payload) => NetworkCachePlanResponseSchema.parse(payload));
}

/** Read-only: the job list is polled every ten seconds and must never mutate. */
export function fetchDownloadJobs(signal?: AbortSignal) {
  return requestJson<NetworkCacheDownloadJobListResponse>("/network/cache/downloads", { signal })
    .then((payload) => NetworkCacheDownloadJobListResponseSchema.parse(payload));
}

/** Read-only: the quality table is polled with the job list and never triggers a probe round. */
export function fetchEgressPlan(signal?: AbortSignal) {
  return requestJson<NetworkEgressPlanResponse>("/network/egress", { signal }).then((payload) => NetworkEgressPlanResponseSchema.parse(payload));
}

/** A retry replays the finished job's own parameters, so it needs no second reauthentication. */
export function retryDownload(taskId: string) {
  return requestJson<NetworkCacheDownloadResponse>(`/network/cache/downloads/${encodeURIComponent(taskId)}/retry`, { method: "POST", body: "{}" })
    .then((payload) => NetworkCacheDownloadResponseSchema.parse(payload));
}

export function createDownload(input: NetworkCacheDownloadRequest, reauthProof: string) {
  return requestJson<NetworkCacheDownloadResponse>("/network/cache/downloads", {
    method: "POST", headers: { "X-Reauth-Proof": reauthProof }, body: JSON.stringify(NetworkCacheDownloadRequestSchema.parse(input)),
  }).then((payload) => NetworkCacheDownloadResponseSchema.parse(payload));
}
