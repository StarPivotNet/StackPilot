import { MeshPeerDirectoryResponseSchema, type MeshPeerDirectoryEntry, type MeshPeerDirectoryResponse } from "@stackpilot/contracts";

export const PEER_DIRECTORY_PATH = "/api/agent/mesh/peers";
/** A minute of cache is enough: peers change only when the Controller applies a new revision. */
export const PEER_DIRECTORY_TTL_MS = 60_000;

/** Inbound callers are authenticated against the Controller's own node records, never against a local list. */
export class PeerDirectory {
  private entries = new Map<string, MeshPeerDirectoryEntry>();
  private assignment: MeshPeerDirectoryResponse["self"] = null;
  private refreshedAtMs = 0;

  constructor(private readonly load: () => Promise<MeshPeerDirectoryResponse>, private readonly now: () => number = Date.now) {}

  async refresh(force = false): Promise<void> {
    if (!force && this.refreshedAtMs > 0 && this.now() - this.refreshedAtMs < PEER_DIRECTORY_TTL_MS) return;
    const response = MeshPeerDirectoryResponseSchema.parse(await this.load());
    this.entries = new Map(response.peers.map((peer) => [peer.nodeId, peer]));
    this.assignment = response.self;
    this.refreshedAtMs = this.now();
  }

  publicKeyFor(nodeId: string) { return this.entries.get(nodeId)?.publicKey ?? null; }
  entryFor(nodeId: string) { return this.entries.get(nodeId) ?? null; }
  selfAssignment() { return this.assignment; }
  refreshedAt() { return this.refreshedAtMs; }
}
