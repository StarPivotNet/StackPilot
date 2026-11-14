import { MESH_INTERFACE_NAME, type MeshHelperConfig } from "./config.js";
import { NFT_EXECUTABLE, type FixedCommandRunner } from "./runner.js";
import { HelperError, type MeshFirewallState } from "./types.js";

/** Appendix C of p2p-mesh-plan.md: the data plane is the only overlay ingress besides ICMP. */
export const OVERLAY_DATA_PLANE_PORT = 18_080;
export const OVERLAY_FIREWALL_TABLE = "stackpilot_mesh";
const FIREWALL_TIMEOUT_MS = 10_000;

/**
 * One dedicated table, never the host ruleset. `add` then `delete` is the idempotent reset: it works
 * on every nftables the supported distributions ship (`destroy` is newer), so the whole ruleset
 * replaces the previous one in a single transaction and a failure leaves the previous table intact.
 */
export function renderFirewallRuleset(interfaceName: string, dataPlanePort = OVERLAY_DATA_PLANE_PORT) {
  return [
    `add table inet ${OVERLAY_FIREWALL_TABLE}`,
    `delete table inet ${OVERLAY_FIREWALL_TABLE}`,
    `table inet ${OVERLAY_FIREWALL_TABLE} {`,
    "\tchain input {",
    "\t\ttype filter hook input priority filter; policy accept;",
    `\t\tiifname "${interfaceName}" ct state established,related accept`,
    `\t\tiifname "${interfaceName}" ip protocol icmp accept`,
    `\t\tiifname "${interfaceName}" tcp dport ${dataPlanePort} accept`,
    `\t\tiifname "${interfaceName}" counter drop`,
    "\t}",
    // No node relays overlay traffic, so a forwarded packet from the overlay is a lateral-movement
    // attempt against a host that happens to route.
    "\tchain forward {",
    "\t\ttype filter hook forward priority filter; policy accept;",
    `\t\tiifname "${interfaceName}" counter drop`,
    "\t}",
    "}",
    "",
  ].join("\n");
}

/** The input chain body only: `forward` also carries a drop, and it must not satisfy this verdict. */
function inputChainBody(listing: string) {
  return /chain input \{([\s\S]*?)\n\s*\}/.exec(listing)?.[1] ?? "";
}

/**
 * Presence plus our rules: a table with the right name but other content, or rules scoped to another
 * interface, must not read as enforced.
 */
export async function readOverlayFirewall(run: FixedCommandRunner, interfaceName?: string): Promise<MeshFirewallState> {
  try {
    const { stdout } = await run(NFT_EXECUTABLE, ["list", "table", "inet", OVERLAY_FIREWALL_TABLE], FIREWALL_TIMEOUT_MS);
    const body = inputChainBody(stdout);
    const scoped = interfaceName === undefined || body.includes(`iifname "${interfaceName}"`);
    return { enforced: scoped && body.includes(`dport ${OVERLAY_DATA_PLANE_PORT}`) && /\bdrop\b/.test(body), dataPlanePort: OVERLAY_DATA_PLANE_PORT };
  } catch { return { enforced: false, dataPlanePort: OVERLAY_DATA_PLANE_PORT }; }
}

export async function ensureOverlayFirewall(config: MeshHelperConfig, run: FixedCommandRunner) {
  // The ruleset is a text template, so the interface name is validated again at the boundary.
  if (!MESH_INTERFACE_NAME.test(config.interfaceName)) throw new HelperError("INVALID_CONFIG", "Mesh interface name is invalid");
  try { await run(NFT_EXECUTABLE, ["-f", "-"], FIREWALL_TIMEOUT_MS, renderFirewallRuleset(config.interfaceName)); }
  catch { throw new HelperError("FIREWALL_UNAVAILABLE", "The overlay port whitelist could not be installed with nft"); }
}

export async function removeOverlayFirewall(run: FixedCommandRunner) {
  await run(NFT_EXECUTABLE, ["delete", "table", "inet", OVERLAY_FIREWALL_TABLE], FIREWALL_TIMEOUT_MS).catch(() => undefined);
}
