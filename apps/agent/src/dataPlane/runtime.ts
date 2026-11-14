import type { AgentIdentity } from "../identity/identityStore.js";
import type { ContentCache } from "../cache/store.js";
import type { RunningDataPlane } from "./server.js";
import { startDataPlaneServer } from "./server.js";
import type { PeerDirectory } from "./peers.js";

/** Handlers run without an identity argument; the process-level identity is the one the Agent enrolled with. */
let identity: AgentIdentity | null = null;
export function setAgentIdentity(value: AgentIdentity | null) { identity = value; }
export function agentIdentity() { return identity; }

/** The directory a fill checks an egress target against; without it no peer is called. */
let peerDirectory: PeerDirectory | null = null;
export function setAgentPeerDirectory(value: PeerDirectory | null) { peerDirectory = value; }
export function agentPeerDirectory() { return peerDirectory; }

/**
 * Keeps the overlay proxy in step with the Controller's assignment. The bind address is the node's
 * overlay address, so a node without an assignment simply runs no proxy.
 */
export class DataPlaneRuntime {
  private running: RunningDataPlane | null = null;

  constructor(
    private readonly nodeId: string,
    private readonly cache: ContentCache,
    private readonly directory: PeerDirectory,
    private readonly log: (record: { level: "info" | "warn"; message: string }) => void = () => undefined,
  ) {}

  current() { return this.running === null ? null : { address: this.running.address, port: this.running.port }; }

  async sync(): Promise<void> {
    const assignment = this.directory.selfAssignment();
    if (!assignment) { await this.stop("no overlay assignment"); return; }
    if (this.running && this.running.address === assignment.overlayAddress && this.running.port === assignment.dataPlanePort) return;
    await this.stop("assignment changed");
    try {
      this.running = await startDataPlaneServer({
        nodeId: this.nodeId, cache: this.cache,
        resolvePublicKey: (peerNodeId) => this.directory.publicKeyFor(peerNodeId),
        address: assignment.overlayAddress, port: assignment.dataPlanePort,
      });
      this.log({ level: "info", message: `Data plane listening on ${this.running.address}:${this.running.port}` });
    } catch (error) {
      this.log({ level: "warn", message: `Data plane could not bind ${assignment.overlayAddress}:${assignment.dataPlanePort} (${error instanceof Error ? error.name : "UnknownError"})` });
    }
  }

  async stop(reason = "shutdown"): Promise<void> {
    if (!this.running) return;
    const running = this.running; this.running = null;
    await running.close().catch(() => undefined);
    this.log({ level: "info", message: `Data plane stopped (${reason})` });
  }
}
