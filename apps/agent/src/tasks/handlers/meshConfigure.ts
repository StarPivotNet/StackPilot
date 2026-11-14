import { NetworkMeshConfigureTaskParametersSchema, type RemoteTaskResultSummary } from "@stackpilot/contracts";
import { requestMeshApply } from "../../mesh/helperClient.js";

export async function meshConfigureHandler(parameters: unknown, signal: AbortSignal, request: typeof requestMeshApply = requestMeshApply): Promise<RemoteTaskResultSummary> {
  const input = NetworkMeshConfigureTaskParametersSchema.parse(parameters);
  const applied = await request(input, signal);
  return { message: `Mesh revision ${applied.appliedRevision} applied with ${applied.peerCount} peer(s)`, data: applied as unknown as Record<string, unknown>, truncated: false };
}
