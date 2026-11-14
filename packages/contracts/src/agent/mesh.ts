import { z } from "zod";

export const NetworkMeshInterfaceNameSchema = z.string().min(1).max(15).regex(/^[A-Za-z0-9_=+.-]+$/);
// WireGuard keys are 32 bytes encoded as 44-character base64.
export const NetworkMeshPublicKeySchema = z.string().regex(/^[A-Za-z0-9+/]{43}=$/);
// Overlay addresses are allocated inside the RFC 6598 shared range 100.64.0.0/10.
export const NetworkMeshOverlayAddressSchema = z.string().max(15)
  .regex(/^100\.(?:6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.(?:25[0-5]|2[0-4][0-9]|1?[0-9]?[0-9])\.(?:25[0-5]|2[0-4][0-9]|1?[0-9]?[0-9])$/);
export const NetworkMeshCollectionStatusSchema = z.enum(["complete", "partial", "unavailable"]);

export const NetworkMeshInterfaceSchema = z.object({
  name: NetworkMeshInterfaceNameSchema,
  present: z.boolean(),
  // Nullish so a helper that cannot read sysfs reports unknown instead of guessing.
  up: z.boolean().nullish(),
  listenPort: z.number().int().min(1).max(65_535).nullable(),
  mtu: z.number().int().min(576).max(9_000).nullable(),
  publicKey: NetworkMeshPublicKeySchema.nullable(),
  peerCount: z.number().int().min(0).max(256),
}).strict();

export const NetworkMeshPeerSchema = z.object({
  publicKey: NetworkMeshPublicKeySchema,
  overlayAddress: NetworkMeshOverlayAddressSchema,
  endpoint: z.string().min(1).max(96).nullable(),
  latestHandshakeAt: z.string().datetime().nullable(),
  handshakeAgeSeconds: z.number().int().min(0).max(31_536_000).nullable(),
  receivedBytes: z.number().int().min(0),
  sentBytes: z.number().int().min(0),
}).strict();

// The overlay only forwards the data-plane port and ICMP; everything else is dropped by the helper.
export const NetworkMeshFirewallSchema = z.object({
  enforced: z.boolean(),
  dataPlanePort: z.number().int().min(1).max(65_535),
}).strict();

export const NetworkMeshStatusDataSchema = z.object({
  collectedAt: z.string().datetime(),
  collectionStatus: NetworkMeshCollectionStatusSchema,
  warnings: z.array(z.string().min(1).max(240)).max(20),
  interface: NetworkMeshInterfaceSchema.nullable(),
  peers: z.array(NetworkMeshPeerSchema).max(256),
  // Nullish so a helper upgraded ahead of the Agent still parses; the Agent then reports null.
  firewall: NetworkMeshFirewallSchema.nullish(),
}).strict();

export type NetworkMeshCollectionStatus = z.infer<typeof NetworkMeshCollectionStatusSchema>;
export type NetworkMeshFirewall = z.infer<typeof NetworkMeshFirewallSchema>;
export type NetworkMeshInterface = z.infer<typeof NetworkMeshInterfaceSchema>;
export type NetworkMeshPeer = z.infer<typeof NetworkMeshPeerSchema>;
export type NetworkMeshStatusData = z.infer<typeof NetworkMeshStatusDataSchema>;

/** A WireGuard session rekeys at 120s; three minutes without a handshake means the link is down. */
export const MESH_HANDSHAKE_TIMEOUT_SECONDS = 180;

/** Reported by the Agent in each heartbeat; the private key never leaves the node helper. */
export const NetworkMeshIdentitySchema = z.object({
  interfaceName: NetworkMeshInterfaceNameSchema,
  publicKey: NetworkMeshPublicKeySchema,
  configuredRevision: z.number().int().min(0).max(2_147_483_647),
}).strict();

/** Aggregate the Agent derives from the last helper dump; nothing here can rebuild a key or a packet. */
export const NetworkMeshLinkSchema = z.object({
  collectedAt: z.string().datetime(),
  peerCount: z.number().int().min(0).max(256),
  activePeerCount: z.number().int().min(0).max(256),
  latestHandshakeAt: z.string().datetime().nullable(),
  firewallEnforced: z.boolean().nullish(),
  dataPlanePort: z.number().int().min(1).max(65_535).nullish(),
  interfaceUp: z.boolean().nullish(),
}).strict();

/** Heartbeat report: durable identity plus the perishable link measurement. */
export const NetworkMeshHeartbeatSchema = NetworkMeshIdentitySchema.extend({
  link: NetworkMeshLinkSchema.nullish(),
});

/** What the Controller exposes on the plan; the age is computed on one clock so the UI can threshold it. */
export const NetworkMeshHandshakeSchema = z.object({
  collectedAt: z.string().datetime(),
  ageSeconds: z.number().int().min(0).max(31_536_000).nullable(),
  peerCount: z.number().int().min(0).max(256),
  activePeerCount: z.number().int().min(0).max(256),
}).strict();

export const NetworkMeshEndpointSchema = z.string().max(96).regex(/^(?:[A-Za-z0-9.-]{1,64}|\[[0-9A-Fa-f:.]{3,45}\]):(?:[1-9][0-9]{0,4})$/);

export const NetworkMeshPeerConfigSchema = z.object({
  publicKey: NetworkMeshPublicKeySchema,
  overlayAddress: NetworkMeshOverlayAddressSchema,
  endpoint: NetworkMeshEndpointSchema.nullable(),
}).strict();

/** The Controller owns the peer list; the helper only persists and applies it. */
export const NetworkMeshConfigurationSchema = z.object({
  sourceRevision: z.number().int().min(1).max(2_147_483_647),
  address: NetworkMeshOverlayAddressSchema,
  listenPort: z.number().int().min(1).max(65_535),
  mtu: z.number().int().min(576).max(9_000),
  peers: z.array(NetworkMeshPeerConfigSchema).max(256),
}).strict().superRefine((value, context) => {
  if (value.peers.some((peer) => peer.overlayAddress === value.address)) context.addIssue({ code: "custom", message: "the local overlay address must not appear in the peer list", path: ["peers"] });
  if (new Set(value.peers.map((peer) => peer.publicKey)).size !== value.peers.length) context.addIssue({ code: "custom", message: "peer public keys must be unique", path: ["peers"] });
  if (new Set(value.peers.map((peer) => peer.overlayAddress)).size !== value.peers.length) context.addIssue({ code: "custom", message: "peer overlay addresses must be unique", path: ["peers"] });
});

export const NetworkMeshApplyDataSchema = z.object({
  appliedRevision: z.number().int().min(1).max(2_147_483_647),
  interfaceName: NetworkMeshInterfaceNameSchema,
  publicKey: NetworkMeshPublicKeySchema,
  peerCount: z.number().int().min(0).max(256),
  appliedAt: z.string().datetime(),
}).strict();

export const NetworkMeshNodeStateSchema = z.object({
  nodeId: z.string().uuid(),
  nodeName: z.string().min(1).max(120),
  status: z.enum(["disabled", "pending", "ready", "stale"]),
  overlayAddress: NetworkMeshOverlayAddressSchema.nullable(),
  publicKey: NetworkMeshPublicKeySchema.nullable(),
  configuredRevision: z.number().int().min(0).max(2_147_483_647).nullable(),
  handshake: NetworkMeshHandshakeSchema.nullable(),
  firewallEnforced: z.boolean().nullable(),
  dataPlanePort: z.number().int().min(1).max(65_535).nullable(),
  // Nullish so a Web build that lags its Controller still parses a plan without this field.
  interfaceUp: z.boolean().nullish(),
}).strict();

export const NetworkMeshPlanResponseSchema = z.object({
  revision: z.number().int().min(0).max(2_147_483_647),
  overlayCidr: z.string().min(1).max(32),
  listenPort: z.number().int().min(1).max(65_535),
  updatedAt: z.string().datetime(),
  nodes: z.array(NetworkMeshNodeStateSchema).max(512),
  warnings: z.array(z.string().min(1).max(240)).max(20),
}).strict();

export type NetworkMeshIdentity = z.infer<typeof NetworkMeshIdentitySchema>;
export type NetworkMeshLink = z.infer<typeof NetworkMeshLinkSchema>;
export type NetworkMeshHeartbeat = z.infer<typeof NetworkMeshHeartbeatSchema>;
export type NetworkMeshHandshake = z.infer<typeof NetworkMeshHandshakeSchema>;
export type NetworkMeshPeerConfig = z.infer<typeof NetworkMeshPeerConfigSchema>;
export type NetworkMeshConfiguration = z.infer<typeof NetworkMeshConfigurationSchema>;
export type NetworkMeshApplyData = z.infer<typeof NetworkMeshApplyDataSchema>;
export type NetworkMeshNodeState = z.infer<typeof NetworkMeshNodeStateSchema>;
export type NetworkMeshPlanResponse = z.infer<typeof NetworkMeshPlanResponseSchema>;
