import { z } from "zod";

export const AgentPlatformSchema = z.enum(["linux", "darwin", "win32"]);
export const AGENT_FEATURE_DATABASE_INVENTORY = "database-inventory-v1";
export const AGENT_FEATURE_PHYSICAL_HOST_IDENTITY = "physical-host-identity-v1";
export const AGENT_FEATURE_SYSTEMD_SNAPSHOT = "systemd-snapshot-v1";
export const AGENT_FEATURE_FIREWALL_DENY_SNAPSHOT = "firewall-deny-snapshot-v1";
export const AgentCapabilitySchema = z.enum([
  "system.summary.read", "service.status.read", "terminal.command.execute", "sites.inventory.read", "sites.logs.read",
  "sites.deploy", "sites.lifecycle.manage", "sites.certificates.renew", "runtime.install", "databases.inventory.read",
  "database.inventory.read", "database.sql.read",
  "database.backup", "database.operate", "database.install", "database.restore",
  "network.mesh.read", "network.mesh.configure", "network.cache.read", "network.transfer",
]);
export const AgentCapabilitiesSchema = z.array(AgentCapabilitySchema).max(20).transform((items) => [...new Set(items)]);

export type AgentPlatform = z.infer<typeof AgentPlatformSchema>;
export type AgentCapability = z.infer<typeof AgentCapabilitySchema>;
