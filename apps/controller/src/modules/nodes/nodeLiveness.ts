import type { AgentNodeState } from "../../repositories/agentControlRepository.js";

/** How long a node may stay silent before the Controller treats it as gone. */
export const NODE_OFFLINE_AFTER_MS = 45_000;

/**
 * A node is live while it keeps heartbeating. The persisted `status` alone cannot answer that:
 * only a heartbeat or a revocation writes it, so a node whose process died keeps reading
 * "online" until something unrelated changes it, and routing keeps handing it work.
 */
export function isNodeLive(node: AgentNodeState, now = Date.now(), offlineAfterMs = NODE_OFFLINE_AFTER_MS): boolean {
  if (node.revokedAt || node.status !== "online") return false;
  // A missing timestamp is not evidence of silence; only a stale one is.
  const seen = node.lastSeenAt ? Date.parse(node.lastSeenAt) : Number.NaN;
  return Number.isNaN(seen) || now - seen <= offlineAfterMs;
}
