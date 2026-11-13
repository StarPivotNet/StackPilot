import { HelperError, type MeshConfigurationRequest, type MeshHelperRequest, type MeshPeerConfig } from "./types.js";

export const PUBLIC_KEY = /^[A-Za-z0-9+/]{43}=$/;
export const PRIVATE_KEY = PUBLIC_KEY;
export const OVERLAY_ADDRESS = /^100\.(?:6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.(?:25[0-5]|2[0-4][0-9]|1?[0-9]?[0-9])\.(?:25[0-5]|2[0-4][0-9]|1?[0-9]?[0-9])$/;
const ENDPOINT = /^(?:[A-Za-z0-9.-]{1,64}|\[[0-9A-Fa-f:.]{3,45}\]):(?:[1-9][0-9]{0,4})$/;
const MAX_PEERS = 256;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HelperError("INVALID_REQUEST", "Request must be an object");
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]) {
  const actual = Object.keys(value).sort().join(",");
  if (actual !== [...expected].sort().join(",")) throw new HelperError("INVALID_REQUEST", "Request fields do not match the fixed operation schema");
}

function integer(value: unknown, min: number, max: number, field: string) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw new HelperError("INVALID_REQUEST", `Request field ${field} is out of range`);
  return value;
}

function text(value: unknown, max: number, field: string) {
  if (typeof value !== "string" || value.length === 0 || value.length > max) throw new HelperError("INVALID_REQUEST", `Request field ${field} is invalid`);
  return value;
}

export function parsePeer(value: unknown): MeshPeerConfig {
  const peer = record(value);
  exactKeys(peer, ["publicKey", "overlayAddress", "endpoint"]);
  const publicKey = text(peer.publicKey, 44, "peers[].publicKey");
  if (!PUBLIC_KEY.test(publicKey)) throw new HelperError("INVALID_REQUEST", "Peer public key is invalid");
  const overlayAddress = text(peer.overlayAddress, 15, "peers[].overlayAddress");
  if (!OVERLAY_ADDRESS.test(overlayAddress)) throw new HelperError("INVALID_REQUEST", "Peer overlay address is outside the shared address plan");
  if (peer.endpoint !== null) {
    const endpoint = text(peer.endpoint, 96, "peers[].endpoint");
    if (!ENDPOINT.test(endpoint)) throw new HelperError("INVALID_REQUEST", "Peer endpoint must be host:port");
  }
  return { publicKey, overlayAddress, endpoint: peer.endpoint as string | null };
}

export function parseConfiguration(value: unknown): MeshConfigurationRequest {
  const configuration = record(value);
  exactKeys(configuration, ["sourceRevision", "address", "listenPort", "mtu", "peers"]);
  const address = text(configuration.address, 15, "configuration.address");
  if (!OVERLAY_ADDRESS.test(address)) throw new HelperError("INVALID_REQUEST", "Local overlay address is outside the shared address plan");
  if (!Array.isArray(configuration.peers)) throw new HelperError("INVALID_REQUEST", "Peer list must be an array");
  if (configuration.peers.length > MAX_PEERS) throw new HelperError("INVALID_REQUEST", "Peer list exceeds the helper limit");
  const peers = configuration.peers.map(parsePeer);
  if (peers.some((peer) => peer.overlayAddress === address)) throw new HelperError("INVALID_REQUEST", "Peer list must not contain the local overlay address");
  if (new Set(peers.map((peer) => peer.publicKey)).size !== peers.length) throw new HelperError("INVALID_REQUEST", "Peer public keys must be unique");
  if (new Set(peers.map((peer) => peer.overlayAddress)).size !== peers.length) throw new HelperError("INVALID_REQUEST", "Peer overlay addresses must be unique");
  return {
    sourceRevision: integer(configuration.sourceRevision, 1, 2_147_483_647, "configuration.sourceRevision"),
    address, listenPort: integer(configuration.listenPort, 1, 65_535, "configuration.listenPort"),
    mtu: integer(configuration.mtu, 576, 9_000, "configuration.mtu"), peers,
  };
}

export function parseRequest(raw: string): MeshHelperRequest {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new HelperError("INVALID_REQUEST", "Request must be valid JSON"); }
  const value = record(parsed);
  if (value.operation === "status") { exactKeys(value, ["operation"]); return { operation: "status" }; }
  if (value.operation === "identity") { exactKeys(value, ["operation"]); return { operation: "identity" }; }
  if (value.operation === "configure") {
    exactKeys(value, ["operation", "revision", "configuration"]);
    const revision = integer(value.revision, 1, 2_147_483_647, "revision");
    const configuration = parseConfiguration(value.configuration);
    if (revision !== configuration.sourceRevision) throw new HelperError("INVALID_REQUEST", "Revision must match configuration.sourceRevision");
    return { operation: "configure", revision, configuration };
  }
  throw new HelperError("INVALID_REQUEST", "Operation is not in the fixed mesh helper protocol");
}
