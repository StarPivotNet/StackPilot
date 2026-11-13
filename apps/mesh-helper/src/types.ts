export type MeshPeerConfig = { publicKey: string; overlayAddress: string; endpoint: string | null };

export type MeshConfigurationRequest = {
  sourceRevision: number;
  address: string;
  listenPort: number;
  mtu: number;
  peers: MeshPeerConfig[];
};

export type MeshHelperRequest =
  | { operation: "status" }
  | { operation: "identity" }
  | { operation: "configure"; revision: number; configuration: MeshConfigurationRequest };

export type MeshHelperOperation = MeshHelperRequest["operation"];

export type MeshHelperResponse = {
  ok: boolean;
  operation: MeshHelperOperation;
  errorCode?: string;
  message?: string;
  data?: Record<string, unknown>;
};

export type MeshInterfaceState = {
  name: string;
  present: boolean;
  /** null when sysfs cannot answer, so the panel shows 未上报 instead of guessing. */
  up: boolean | null;
  listenPort: number | null;
  mtu: number | null;
  publicKey: string | null;
  peerCount: number;
};

export type MeshPeerState = {
  publicKey: string;
  overlayAddress: string;
  endpoint: string | null;
  latestHandshakeAt: string | null;
  handshakeAgeSeconds: number | null;
  receivedBytes: number;
  sentBytes: number;
};

export type MeshFirewallState = { enforced: boolean; dataPlanePort: number };

export type MeshStatusData = {
  collectedAt: string;
  collectionStatus: "complete" | "partial" | "unavailable";
  warnings: string[];
  interface: MeshInterfaceState | null;
  peers: MeshPeerState[];
  firewall: MeshFirewallState;
};

export type MeshIdentityData = { interfaceName: string; publicKey: string; configuredRevision: number };

export type MeshApplyData = {
  appliedRevision: number;
  interfaceName: string;
  publicKey: string;
  peerCount: number;
  appliedAt: string;
};

export type MeshRevisionState = {
  revision: number;
  digest: string;
  appliedAt: string;
  address: string;
  listenPort: number;
  mtu: number;
  peerCount: number;
};

export class HelperError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "HelperError";
  }
}
