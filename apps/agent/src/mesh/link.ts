import { MESH_HANDSHAKE_TIMEOUT_SECONDS, type NetworkMeshLink, type NetworkMeshStatusData } from "@stackpilot/contracts";

function ageSeconds(at: string | null, now: Date) {
  if (!at) return null;
  const timestamp = Date.parse(at);
  return Number.isNaN(timestamp) ? null : Math.max(0, Math.floor((now.getTime() - timestamp) / 1_000));
}

/** Collapses the helper peer dump into the one link record a heartbeat may carry. */
export function summarizeMeshLink(status: NetworkMeshStatusData, now = new Date()): NetworkMeshLink {
  let activePeerCount = 0;
  let latestHandshakeAt: string | null = null;
  for (const peer of status.peers) {
    const age = ageSeconds(peer.latestHandshakeAt, now);
    if (age !== null && age <= MESH_HANDSHAKE_TIMEOUT_SECONDS) activePeerCount += 1;
    if (peer.latestHandshakeAt && (latestHandshakeAt === null || Date.parse(peer.latestHandshakeAt) > Date.parse(latestHandshakeAt))) latestHandshakeAt = peer.latestHandshakeAt;
  }
  return { collectedAt: status.collectedAt, peerCount: status.peers.length, activePeerCount, latestHandshakeAt, firewallEnforced: status.firewall?.enforced ?? null, dataPlanePort: status.firewall?.dataPlanePort ?? null, interfaceUp: status.interface?.up ?? null };
}
