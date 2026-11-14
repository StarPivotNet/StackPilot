import type { MeshHelperConfig } from "./config.js";
import { readRevisionState, type ConfigureDependencies } from "./configure.js";
import { realFileOperations } from "./files.js";
import { ensureMeshKey } from "./keys.js";
import type { MeshIdentityData } from "./types.js";

/** Reports the local public key; the private key is generated on first use and never leaves the host. */
export async function collectMeshIdentity(config: MeshHelperConfig, dependencies: ConfigureDependencies = {}): Promise<MeshIdentityData> {
  const files = dependencies.files ?? realFileOperations;
  const key = await ensureMeshKey(config, dependencies);
  const state = await readRevisionState(config, files);
  return { interfaceName: config.interfaceName, publicKey: key.publicKey, configuredRevision: state?.revision ?? 0 };
}
