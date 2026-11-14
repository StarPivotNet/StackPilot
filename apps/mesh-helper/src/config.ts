import { posix } from "node:path";
import { HelperError } from "./types.js";

export type MeshHelperConfig = { interfaceName: string; stateRoot: string };

const INTERFACE_NAME = /^[A-Za-z0-9_=+.-]{1,15}$/;
export const MESH_INTERFACE_NAME = INTERFACE_NAME;
const DEFAULT_INTERFACE = "wg0";
const DEFAULT_STATE_ROOT = "/var/lib/stackpilot-mesh";

export function loadConfig(env: NodeJS.ProcessEnv = process.env): MeshHelperConfig {
  const interfaceName = env.STACKPILOT_MESH_INTERFACE ?? DEFAULT_INTERFACE;
  if (!INTERFACE_NAME.test(interfaceName)) throw new HelperError("INVALID_CONFIG", "Mesh interface name is invalid");
  const stateRoot = posix.normalize(env.STACKPILOT_MESH_STATE_DIR ?? DEFAULT_STATE_ROOT);
  if (!stateRoot.startsWith("/") || stateRoot.includes("..")) throw new HelperError("INVALID_CONFIG", "Mesh state directory must be an absolute path without traversal");
  return { interfaceName, stateRoot };
}
