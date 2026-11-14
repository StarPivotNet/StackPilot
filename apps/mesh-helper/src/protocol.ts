import { log } from "./audit.js";
import { loadConfig, type MeshHelperConfig } from "./config.js";
import { applyMeshConfiguration, type ConfigureDependencies } from "./configure.js";
import { collectMeshIdentity } from "./identity.js";
import { collectMeshStatus, type StatusDependencies } from "./status.js";
import { HelperError, type MeshHelperRequest, type MeshHelperResponse } from "./types.js";
import { parseRequest } from "./validation.js";

export type Dependencies = StatusDependencies & ConfigureDependencies & {
  config?: MeshHelperConfig;
  status?: typeof collectMeshStatus;
  identity?: typeof collectMeshIdentity;
  configure?: typeof applyMeshConfiguration;
};

async function runOperation(request: MeshHelperRequest, config: MeshHelperConfig, dependencies: Dependencies) {
  switch (request.operation) {
    case "status": { const status = await (dependencies.status ?? collectMeshStatus)(config, dependencies); return { data: status as unknown as Record<string, unknown>, summary: { collectionStatus: status.collectionStatus, peers: status.peers.length } }; }
    case "identity": { const identity = await (dependencies.identity ?? collectMeshIdentity)(config, dependencies); return { data: identity as unknown as Record<string, unknown>, summary: { configuredRevision: identity.configuredRevision } }; }
    case "configure": {
      const applied = await (dependencies.configure ?? applyMeshConfiguration)(config, request, dependencies);
      return { data: applied as unknown as Record<string, unknown>, summary: { appliedRevision: applied.appliedRevision, peers: applied.peerCount } };
    }
  }
}

export async function handleRequest(raw: string, dependencies: Dependencies = {}): Promise<MeshHelperResponse> {
  let request: MeshHelperRequest;
  try { request = parseRequest(raw); }
  catch (error) { return { ok: false, operation: "status", errorCode: error instanceof HelperError ? error.code : "INVALID_REQUEST", message: "Request does not match the fixed mesh helper protocol" }; }
  const started = performance.now();
  try {
    const result = await runOperation(request, dependencies.config ?? loadConfig(), dependencies);
    log({ level: "info", message: "Mesh helper operation completed", operation: request.operation, ...result.summary, durationMs: Math.round(performance.now() - started) });
    return { ok: true, operation: request.operation, data: result.data };
  } catch (error) {
    const code = error instanceof HelperError ? error.code : "MESH_OPERATION_FAILED";
    log({ level: "error", message: "Mesh helper operation failed", operation: request.operation, errorCode: code, durationMs: Math.round(performance.now() - started) });
    return { ok: false, operation: request.operation, errorCode: code, message: "Mesh helper operation failed; inspect structured root helper logs" };
  }
}

export { parseRequest } from "./validation.js";
