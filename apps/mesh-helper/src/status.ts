import { readFile } from "node:fs/promises";
import type { MeshHelperConfig } from "./config.js";
import { readOverlayFirewall } from "./firewall.js";
import { runFixedCommand, WG_EXECUTABLE, type FixedCommandRunner } from "./runner.js";
import { HelperError, type MeshFirewallState, type MeshInterfaceState, type MeshPeerState, type MeshStatusData } from "./types.js";
import { OVERLAY_ADDRESS, PUBLIC_KEY } from "./validation.js";

export type StatusDependencies = { run?: FixedCommandRunner; now?: () => Date; mtu?: (name: string) => Promise<number | null>; up?: (name: string) => Promise<boolean | null>; firewall?: (run: FixedCommandRunner) => Promise<MeshFirewallState> };

const MAX_PEERS = 256;
const NEVER_HANDSHAKED = "(none)";

export async function readInterfaceMtu(name: string): Promise<number | null> {
  try {
    const mtu = Number.parseInt((await readFile(`/sys/class/net/${name}/mtu`, "utf8")).trim(), 10);
    return Number.isSafeInteger(mtu) && mtu >= 576 && mtu <= 9_000 ? mtu : null;
  } catch { return null; }
}

/** `wg show dump` keeps answering while the device is down, so the admin state comes from IFF_UP. */
export async function readInterfaceUp(name: string): Promise<boolean | null> {
  try {
    const flags = Number.parseInt((await readFile(`/sys/class/net/${name}/flags`, "utf8")).trim(), 16);
    return Number.isSafeInteger(flags) ? (flags & 0x1) !== 0 : null;
  } catch { return null; }
}

function byteCount(value: string | undefined) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

function overlayAddress(allowedIps: string | undefined) {
  for (const entry of (allowedIps ?? "").split(",")) {
    const address = entry.trim().split("/")[0] ?? "";
    if (OVERLAY_ADDRESS.test(address)) return address;
  }
  return null;
}

/** Parses `wg show <interface> dump` without ever retaining the interface private key. */
export function parseInterfaceDump(name: string, dump: string, collectedAt: Date, firewall: MeshFirewallState): MeshStatusData {
  const [header, ...rows] = dump.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const warnings: string[] = firewall.enforced ? [] : ["Overlay port whitelist is not installed on this host"];
  const peers: MeshPeerState[] = [];
  if (header === undefined) return { collectedAt: collectedAt.toISOString(), collectionStatus: "unavailable", warnings: [...warnings, "WireGuard interface dump was empty"], interface: null, peers, firewall };
  const [, publicKey, listenPort] = header.split("\t");
  const parsedPort = Number.parseInt(listenPort ?? "", 10);
  for (const row of rows) {
    const fields = row.split("\t");
    if (fields.length < 8) { warnings.push("A WireGuard peer row was truncated"); continue; }
    const [peerKey, , endpoint, allowedIps, handshake, received, sent] = fields;
    const address = overlayAddress(allowedIps);
    if (peerKey === undefined || !PUBLIC_KEY.test(peerKey) || address === null) { warnings.push("A WireGuard peer outside the overlay address plan was skipped"); continue; }
    if (peers.length >= MAX_PEERS) { warnings.push("WireGuard peers were truncated to the helper limit"); break; }
    const handshakeSeconds = Number.parseInt(handshake ?? "", 10);
    const latestHandshakeAt = Number.isSafeInteger(handshakeSeconds) && handshakeSeconds > 0 ? new Date(handshakeSeconds * 1_000).toISOString() : null;
    peers.push({
      publicKey: peerKey, overlayAddress: address,
      endpoint: endpoint && endpoint !== NEVER_HANDSHAKED ? endpoint.slice(0, 96) : null,
      latestHandshakeAt,
      handshakeAgeSeconds: latestHandshakeAt === null ? null : Math.max(0, Math.floor((collectedAt.getTime() - Date.parse(latestHandshakeAt)) / 1_000)),
      receivedBytes: byteCount(received), sentBytes: byteCount(sent),
    });
  }
  const interfaceState: MeshInterfaceState = {
    name, present: true, up: null,
    listenPort: Number.isSafeInteger(parsedPort) && parsedPort > 0 && parsedPort <= 65_535 ? parsedPort : null,
    mtu: null,
    publicKey: publicKey !== undefined && PUBLIC_KEY.test(publicKey) ? publicKey : null,
    peerCount: peers.length,
  };
  if (interfaceState.listenPort === null) warnings.push("WireGuard interface is not listening on a UDP port");
  if (interfaceState.publicKey === null) warnings.push("WireGuard interface public key is unavailable");
  return { collectedAt: collectedAt.toISOString(), collectionStatus: warnings.length > 0 ? "partial" : "complete", warnings, interface: interfaceState, peers, firewall };
}

export async function collectMeshStatus(config: MeshHelperConfig, dependencies: StatusDependencies = {}): Promise<MeshStatusData> {
  const collectedAt = (dependencies.now ?? (() => new Date()))().toISOString();
  const run = dependencies.run ?? runFixedCommand;
  const firewall = await (dependencies.firewall ?? ((runner: FixedCommandRunner) => readOverlayFirewall(runner, config.interfaceName)))(run);
  const firewallWarnings = firewall.enforced ? [] : ["Overlay port whitelist is not installed on this host"];
  let dump: string;
  try { ({ stdout: dump } = await run(WG_EXECUTABLE, ["show", config.interfaceName, "dump"], 5_000)); }
  catch (error) {
    const code = error instanceof HelperError ? error.code : "COMMAND_FAILED";
    return {
      collectedAt, collectionStatus: "unavailable", interface: null, peers: [], firewall,
      warnings: [...firewallWarnings, code === "COMMAND_TIMEOUT" ? "wg show timed out" : "WireGuard interface is unavailable"],
    };
  }
  const status = parseInterfaceDump(config.interfaceName, dump, new Date(collectedAt), firewall);
  // `wg dump` omits the link MTU and the admin state; read both from sysfs so operators see MTU
  // black holes and a fail-closed link before the handshake age gives it away.
  const mtu = await (dependencies.mtu ?? readInterfaceMtu)(config.interfaceName);
  const up = await (dependencies.up ?? readInterfaceUp)(config.interfaceName);
  if (status.interface) status.interface = { ...status.interface, ...(mtu === null ? {} : { mtu }), up };
  return status;
}
