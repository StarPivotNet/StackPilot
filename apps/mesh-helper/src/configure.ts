import { createHash } from "node:crypto";
import type { MeshHelperConfig } from "./config.js";
import { realFileOperations, type FileOperations } from "./files.js";
import { ensureOverlayFirewall, readOverlayFirewall, removeOverlayFirewall } from "./firewall.js";
import { ensureMeshKey } from "./keys.js";
import { IP_EXECUTABLE, runFixedCommand, WG_EXECUTABLE, type FixedCommandRunner } from "./runner.js";
import { HelperError, type MeshApplyData, type MeshConfigurationRequest, type MeshRevisionState } from "./types.js";

const OVERLAY_ROUTE = "100.64.0.0/10";
const CONFIGURE_TIMEOUT_MS = 15_000;
const ADDRESS_TIMEOUT_MS = 10_000;

export type ConfigureDependencies = { run?: FixedCommandRunner; files?: FileOperations; now?: () => Date };

export const meshConfigurationPath = (config: MeshHelperConfig) => `${config.stateRoot}/${config.interfaceName}.conf`;
export const meshPreviousConfigurationPath = (config: MeshHelperConfig) => `${config.stateRoot}/${config.interfaceName}.previous.conf`;
export const meshStatePath = (config: MeshHelperConfig) => `${config.stateRoot}/${config.interfaceName}.state.json`;

export function configurationDigest(configuration: MeshConfigurationRequest) {
  const normalized = { ...configuration, peers: [...configuration.peers].sort((left, right) => left.publicKey.localeCompare(right.publicKey)) };
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

/** Renders only keys that `wg setconf` understands; addressing stays with `ip`. */
export function renderConfiguration(configuration: MeshConfigurationRequest, privateKey: string) {
  const lines = ["[Interface]", `PrivateKey = ${privateKey}`, `ListenPort = ${configuration.listenPort}`];
  for (const peer of configuration.peers) {
    lines.push("", "[Peer]", `PublicKey = ${peer.publicKey}`, `AllowedIPs = ${peer.overlayAddress}/32`);
    if (peer.endpoint !== null) lines.push(`Endpoint = ${peer.endpoint}`);
  }
  return `${lines.join("\n")}\n`;
}

export async function readRevisionState(config: MeshHelperConfig, files: FileOperations): Promise<MeshRevisionState | null> {
  const raw = await files.read(meshStatePath(config));
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<MeshRevisionState>;
    if (!Number.isSafeInteger(parsed.revision) || typeof parsed.digest !== "string" || typeof parsed.appliedAt !== "string") return null;
    return parsed as MeshRevisionState;
  } catch { return null; }
}

async function interfacePresent(config: MeshHelperConfig, run: FixedCommandRunner) {
  try { await run(IP_EXECUTABLE, ["link", "show", "dev", config.interfaceName], ADDRESS_TIMEOUT_MS); return true; }
  catch { return false; }
}

async function ensureInterface(config: MeshHelperConfig, run: FixedCommandRunner) {
  if (await interfacePresent(config, run)) return;
  await run(IP_EXECUTABLE, ["link", "add", "dev", config.interfaceName, "type", "wireguard"], ADDRESS_TIMEOUT_MS);
}

async function applyInterface(config: MeshHelperConfig, configuration: MeshConfigurationRequest, run: FixedCommandRunner) {
  // Loaded before the device exists, so no packet ever reaches an unfiltered interface.
  await ensureOverlayFirewall(config, run);
  await ensureInterface(config, run);
  await run(WG_EXECUTABLE, ["setconf", config.interfaceName, meshConfigurationPath(config)], CONFIGURE_TIMEOUT_MS);
  await run(IP_EXECUTABLE, ["address", "replace", `${configuration.address}/32`, "dev", config.interfaceName], ADDRESS_TIMEOUT_MS);
  await run(IP_EXECUTABLE, ["link", "set", "dev", config.interfaceName, "mtu", String(configuration.mtu), "up"], ADDRESS_TIMEOUT_MS);
  await run(IP_EXECUTABLE, ["route", "replace", OVERLAY_ROUTE, "dev", config.interfaceName], ADDRESS_TIMEOUT_MS);
}

/** WireGuard keeps its dump while the device is administratively down, so up-ness comes from sysfs. */
async function interfaceUp(config: MeshHelperConfig, files: FileOperations): Promise<boolean | null> {
  try {
    const flags = Number.parseInt((await files.read(`/sys/class/net/${config.interfaceName}/flags`) ?? "").trim(), 16);
    return Number.isSafeInteger(flags) ? (flags & 0x1) !== 0 : null;
  } catch { return null; }
}

/**
 * Restores the last accepted configuration; the previous state file was never replaced. Every step
 * is best effort: whatever broke the apply can break the restore, and the caller reports the
 * original error, so the only guarantee kept here is the whitelist-or-down decision at the end.
 */
async function rollback(config: MeshHelperConfig, run: FixedCommandRunner, files: FileOperations, previous: string | null) {
  if (previous === null) {
    await run(IP_EXECUTABLE, ["link", "del", "dev", config.interfaceName], ADDRESS_TIMEOUT_MS).catch(() => undefined);
    await files.remove(meshConfigurationPath(config));
    // A refused delete (EBUSY, EPERM, timeout) leaves a device behind; dropping the table then would
    // leave an unfiltered interface, so keep the whitelist and take the link down instead.
    if (await interfacePresent(config, run)) {
      await run(IP_EXECUTABLE, ["link", "set", "dev", config.interfaceName, "down"], ADDRESS_TIMEOUT_MS).catch(() => undefined);
      return;
    }
    await removeOverlayFirewall(run);
    return;
  }
  try {
    await files.writePrivate(meshConfigurationPath(config), previous);
    await run(WG_EXECUTABLE, ["setconf", config.interfaceName, meshConfigurationPath(config)], CONFIGURE_TIMEOUT_MS);
  } catch { /* the whitelist decision below still stands even when the restore did not complete */ }
  await files.remove(meshPreviousConfigurationPath(config));
  // The restored revision was accepted because its whitelist was in place; if it cannot be put back,
  // stop carrying overlay traffic instead of leaving the interface open.
  try { await ensureOverlayFirewall(config, run); }
  catch { await run(IP_EXECUTABLE, ["link", "set", "dev", config.interfaceName, "down"], ADDRESS_TIMEOUT_MS).catch(() => undefined); }
}

export async function applyMeshConfiguration(config: MeshHelperConfig, request: { revision: number; configuration: MeshConfigurationRequest }, dependencies: ConfigureDependencies = {}): Promise<MeshApplyData> {
  const files = dependencies.files ?? realFileOperations;
  const run = dependencies.run ?? runFixedCommand;
  const now = dependencies.now ?? (() => new Date());
  const state = await readRevisionState(config, files);
  const digest = configurationDigest(request.configuration);
  if (state && state.revision > request.revision) throw new HelperError("REVISION_STALE", "A newer mesh revision is already applied");
  if (state && state.revision === request.revision) {
    if (state.digest !== digest) throw new HelperError("REVISION_CONFLICT", "Mesh revision was reused with different content");
    // The revision is on disk, not necessarily on the host: a reboot, a fail-closed rollback that
    // took the link down, or a missing whitelist all leave the revision recorded but unhealthy.
    if ((await interfacePresent(config, run)) && (await interfaceUp(config, files)) === true && (await readOverlayFirewall(run, config.interfaceName)).enforced) {
      const key = await ensureMeshKey(config, { run, files });
      return { appliedRevision: state.revision, interfaceName: config.interfaceName, publicKey: key.publicKey, peerCount: request.configuration.peers.length, appliedAt: state.appliedAt };
    }
  }
  const key = await ensureMeshKey(config, { run, files });
  const previous = await files.read(meshConfigurationPath(config));
  await files.ensureDirectory(config.stateRoot);
  if (previous !== null) await files.writePrivate(meshPreviousConfigurationPath(config), previous);
  await files.writePrivate(meshConfigurationPath(config), renderConfiguration(request.configuration, key.privateKey));
  try { await applyInterface(config, request.configuration, run); }
  catch (error) { await rollback(config, run, files, previous).catch(() => undefined); throw error instanceof HelperError ? error : new HelperError("CONFIGURE_FAILED", "Mesh configuration could not be applied"); }
  const appliedAt = now().toISOString();
  const next: MeshRevisionState = {
    revision: request.revision, digest, appliedAt, address: request.configuration.address,
    listenPort: request.configuration.listenPort, mtu: request.configuration.mtu, peerCount: request.configuration.peers.length,
  };
  await files.writePrivate(meshStatePath(config), `${JSON.stringify(next, null, 2)}\n`);
  await files.remove(meshPreviousConfigurationPath(config));
  return { appliedRevision: next.revision, interfaceName: config.interfaceName, publicKey: key.publicKey, peerCount: next.peerCount, appliedAt };
}
