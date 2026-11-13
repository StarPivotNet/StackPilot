import { NetworkMeshStatusTaskParametersSchema, type RemoteTaskResultSummary } from "@stackpilot/contracts";
import { requestMeshStatus } from "../../mesh/helperClient.js";

export async function meshStatusHandler(parameters: unknown, signal: AbortSignal, request: typeof requestMeshStatus = requestMeshStatus): Promise<RemoteTaskResultSummary> {
  NetworkMeshStatusTaskParametersSchema.parse(parameters);
  const mesh = await request(signal);
  const message = mesh.collectionStatus === "complete"
    ? `Mesh status collected for ${mesh.peers.length} peer(s)`
    : `Mesh status is ${mesh.collectionStatus}`;
  return { message, data: mesh as unknown as Record<string, unknown>, truncated: false };
}
