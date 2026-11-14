import { connect } from "node:net";
import {
  NetworkMeshApplyDataSchema, NetworkMeshIdentitySchema, NetworkMeshStatusDataSchema,
  type NetworkMeshApplyData, type NetworkMeshConfigureTaskParameters, type NetworkMeshIdentity, type NetworkMeshLink, type NetworkMeshStatusData,
} from "@stackpilot/contracts";
import { summarizeMeshLink } from "./link.js";

export const MESH_HELPER_SOCKET_PATH = "/run/stackpilot-mesh/helper.sock";
const MAX_RESPONSE_BYTES = 1024 * 1024;

type MeshHelperResponse = { ok: boolean; operation?: string; errorCode?: string; message?: string; data?: unknown };

export class MeshHelperError extends Error {
  constructor(public readonly code: string, message = "Mesh helper request failed") {
    super(message); this.name = code;
  }
}

export type MeshSocketFactory = (path: string) => ReturnType<typeof connect>;

const defaultSocketFactory: MeshSocketFactory = (path) => connect({ path });

function send<T>(body: Record<string, unknown>, parse: (data: unknown) => T, signal: AbortSignal | undefined, socketPath: string, socketFactory: MeshSocketFactory): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new MeshHelperError("MESH_HELPER_CANCELLED")); return; }
    const socket = socketFactory(socketPath);
    const chunks: Buffer[] = []; let size = 0;
    const fail = (error: unknown) => { socket.destroy(); reject(error instanceof MeshHelperError ? error : new MeshHelperError("MESH_HELPER_UNAVAILABLE")); };
    const abort = () => fail(new MeshHelperError("MESH_HELPER_CANCELLED"));
    signal?.addEventListener("abort", abort, { once: true });
    socket.setTimeout(5_000, () => fail(new MeshHelperError("MESH_HELPER_TIMEOUT")));
    socket.once("connect", () => socket.end(`${JSON.stringify(body)}\n`));
    socket.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_RESPONSE_BYTES) fail(new MeshHelperError("MESH_HELPER_RESPONSE_TOO_LARGE")); else chunks.push(chunk);
    });
    socket.once("error", fail);
    socket.once("end", () => {
      signal?.removeEventListener("abort", abort);
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8").trim()) as MeshHelperResponse;
        if (!parsed || parsed.ok !== true) throw new MeshHelperError(parsed?.errorCode ?? "MESH_HELPER_FAILED", parsed?.message);
        resolve(parse(parsed.data));
      } catch (error) { reject(error instanceof MeshHelperError ? error : new MeshHelperError("MESH_HELPER_INVALID_RESPONSE")); }
    });
  });
}

export function requestMeshStatus(signal?: AbortSignal, socketPath = MESH_HELPER_SOCKET_PATH, socketFactory: MeshSocketFactory = defaultSocketFactory): Promise<NetworkMeshStatusData> {
  return send({ operation: "status" }, (data) => NetworkMeshStatusDataSchema.parse(data), signal, socketPath, socketFactory);
}

export function requestMeshIdentity(socketPath = MESH_HELPER_SOCKET_PATH, socketFactory: MeshSocketFactory = defaultSocketFactory): Promise<NetworkMeshIdentity> {
  return send({ operation: "identity" }, (data) => NetworkMeshIdentitySchema.parse(data), undefined, socketPath, socketFactory);
}

export function requestMeshApply(input: NetworkMeshConfigureTaskParameters, signal?: AbortSignal, socketPath = MESH_HELPER_SOCKET_PATH, socketFactory: MeshSocketFactory = defaultSocketFactory): Promise<NetworkMeshApplyData> {
  return send({ operation: "configure", revision: input.revision, configuration: input.configuration }, (data) => NetworkMeshApplyDataSchema.parse(data), signal, socketPath, socketFactory);
}

/** Heartbeat-side probe: returns the local mesh identity only when the helper answers. */
export async function readMeshIdentity(socketPath = MESH_HELPER_SOCKET_PATH): Promise<NetworkMeshIdentity | null> {
  try { return await requestMeshIdentity(socketPath); } catch { return null; }
}

/** Heartbeat-side probe: link health is advisory, so a silent helper yields no record instead of an error. */
export async function readMeshLink(socketPath = MESH_HELPER_SOCKET_PATH): Promise<NetworkMeshLink | null> {
  try { return summarizeMeshLink(await requestMeshStatus(undefined, socketPath)); } catch { return null; }
}

export async function meshHelperAvailable(socketPath = MESH_HELPER_SOCKET_PATH) {
  try { await requestMeshStatus(undefined, socketPath); return true; } catch { return false; }
}
