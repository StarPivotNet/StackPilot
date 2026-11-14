import type { AgentCapability } from "@stackpilot/contracts";

export const LEGACY_AGENT_CAPABILITIES: readonly AgentCapability[] = ["system.summary.read", "service.status.read"];
export const BASE_AGENT_CAPABILITIES: readonly AgentCapability[] = [...LEGACY_AGENT_CAPABILITIES, "sites.inventory.read"];
const SITE_HELPER_CAPABILITIES: readonly AgentCapability[] = ["sites.logs.read", "sites.deploy", "sites.lifecycle.manage", "sites.certificates.renew", "runtime.install"];
const DATABASE_HELPER_CAPABILITIES: readonly AgentCapability[] = [
  "database.inventory.read", "database.sql.read", "database.backup", "database.operate", "database.install", "database.restore",
];
const LINUX_CAPABILITIES: readonly AgentCapability[] = ["terminal.command.execute"];
const MESH_HELPER_CAPABILITIES: readonly AgentCapability[] = ["network.mesh.read", "network.mesh.configure"];
const CACHE_CAPABILITIES: readonly AgentCapability[] = ["network.cache.read", "network.transfer"];
export const AGENT_CAPABILITIES: readonly AgentCapability[] = [...BASE_AGENT_CAPABILITIES, ...SITE_HELPER_CAPABILITIES, ...LINUX_CAPABILITIES, "databases.inventory.read", ...DATABASE_HELPER_CAPABILITIES, ...MESH_HELPER_CAPABILITIES, ...CACHE_CAPABILITIES];

export function activeAgentCapabilities(
  platform: "linux" | "darwin" | "win32",
  siteHelperReady: boolean,
  databaseInventorySupported = false,
  terminalCommandsReady = false,
  databaseHelperReady = false,
  meshHelperReady = false,
  cacheReady = false,
): AgentCapability[] {
  const capabilities: AgentCapability[] = [...BASE_AGENT_CAPABILITIES];
  if (platform === "linux" && terminalCommandsReady) capabilities.push(...LINUX_CAPABILITIES);
  if (platform === "linux" && siteHelperReady) capabilities.push(...SITE_HELPER_CAPABILITIES);
  if (databaseInventorySupported) capabilities.push("databases.inventory.read");
  if (platform === "linux" && databaseInventorySupported && databaseHelperReady) capabilities.push(...DATABASE_HELPER_CAPABILITIES);
  if (platform === "linux" && meshHelperReady) capabilities.push(...MESH_HELPER_CAPABILITIES);
  if (platform === "linux" && cacheReady) capabilities.push(...CACHE_CAPABILITIES);
  return capabilities;
}
