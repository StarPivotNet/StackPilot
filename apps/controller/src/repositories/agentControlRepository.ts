import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AgentCapability, AgentDatabaseSnapshot, AgentFirewallDenySnapshot, AgentHeartbeat, AgentNodeRecord, AgentSiteSnapshot, AgentSystemdSnapshot, AgentTelemetrySnapshot, NetworkCacheStats, NetworkMeshIdentity, NetworkMeshLink, PhysicalHostId, RemoteTaskRecord } from "@stackpilot/contracts";
import { AgentFirewallDenySnapshotSchema, AgentHeartbeatDatabaseSnapshotSchema, AgentHealthSchema, AgentNodeRecordSchema, AgentSiteSnapshotSchema, AgentSystemdSnapshotSchema, AgentTelemetrySnapshotSchema, NetworkCacheStatsSchema, NetworkMeshIdentitySchema, NetworkMeshLinkSchema, NetworkMeshOverlayAddressSchema, PhysicalHostIdSchema, RemoteTaskRecordSchema } from "@stackpilot/contracts";
import { z } from "zod";

export type EnrollmentState = { enrollmentId: string; tokenDigest: string; nodeName: string; expiresAt: string; usedAt: string | null; revokedAt: string | null };
export type AgentCredentialState = { credentialId: string; nodeId: string; publicKey: string; createdAt: string; revokedAt: string | null; replacedBy: string | null; rotationId: string | null };
export type AgentMeshAssignment = { overlayAddress: string; revision: number };
export type AgentNodeState = AgentNodeRecord & { physicalHostId?: PhysicalHostId; telemetry?: AgentTelemetrySnapshot; siteSnapshot?: AgentSiteSnapshot; databaseSnapshot?: AgentDatabaseSnapshot; systemdSnapshot?: AgentSystemdSnapshot; firewallDenySnapshot?: AgentFirewallDenySnapshot; meshAssignment?: AgentMeshAssignment; meshIdentity?: NetworkMeshIdentity; meshLink?: NetworkMeshLink; cacheStats?: NetworkCacheStats; heartbeatHealthStatus?: AgentHeartbeat["health"]["status"] };
export const AgentNodeStateSchema = AgentNodeRecordSchema.extend({
  physicalHostId: PhysicalHostIdSchema.optional(),
  telemetry: AgentTelemetrySnapshotSchema.optional(),
  siteSnapshot: AgentSiteSnapshotSchema.optional(),
  databaseSnapshot: AgentHeartbeatDatabaseSnapshotSchema.optional(),
  systemdSnapshot: AgentSystemdSnapshotSchema.optional(),
  firewallDenySnapshot: AgentFirewallDenySnapshotSchema.optional(),
  meshAssignment: z.object({ overlayAddress: NetworkMeshOverlayAddressSchema, revision: z.number().int().min(0).max(2_147_483_647) }).strict().optional(),
  meshIdentity: NetworkMeshIdentitySchema.optional(),
  meshLink: NetworkMeshLinkSchema.optional(),
  cacheStats: NetworkCacheStatsSchema.optional(),
  heartbeatHealthStatus: AgentHealthSchema.shape.status.optional(),
});
export type AgentNonceConsumption = "accepted" | "replayed" | "unauthorized";
export type AgentNonceRequest = {
  nodeId: string;
  credentialId: string;
  nonce: string;
  expiresAt: string;
  allowRevokedCredential: boolean;
};
export type AuditEvent = { eventId: string; timestamp: string; requester: string; nodeId: string | null; taskId: string | null; event: string; taskType: string | null; parameters: Record<string, unknown> | null; fromStatus: string | null; toStatus: string | null; resultSummary: string | null; traceId: string };
export type AgentControlState = {
  enrollments: EnrollmentState[];
  credentials: AgentCredentialState[];
  nodes: AgentNodeState[];
  nonces: Array<{ credentialId: string; nonce: string; expiresAt: string }>;
  tasks: RemoteTaskRecord[];
  audits: AuditEvent[];
};

/** A projection is a unit of work: omitted sections are neither loaded nor replaced. */
export type AgentControlQuery = {
  sections?: readonly (keyof AgentControlState)[];
  nodeId?: string;
  nodeIds?: readonly string[];
  credentialId?: string;
  taskId?: string;
  activeTasks?: boolean;
  taskStatus?: RemoteTaskRecord["status"];
  taskLimit?: number;
};

export function projectAgentControlState(state: AgentControlState, query: AgentControlQuery = {}): AgentControlState {
  const result = emptyState();
  const allowed = (nodeId: string) => (!query.nodeId || query.nodeId === nodeId) && (!query.nodeIds || query.nodeIds.includes(nodeId));
  for (const section of query.sections ?? Object.keys(result) as Array<keyof AgentControlState>) {
    Object.assign(result, { [section]: structuredClone(state[section]) });
  }
  result.nodes = result.nodes.filter((node) => allowed(node.nodeId));
  result.credentials = result.credentials.filter((credential) => allowed(credential.nodeId) && (!query.credentialId || credential.credentialId === query.credentialId));
  result.nonces = result.nonces.filter((nonce) => !query.credentialId || nonce.credentialId === query.credentialId);
  result.tasks = result.tasks.filter((task) => allowed(task.targetNodeId) && (!query.taskId || task.taskId === query.taskId)
    && (!query.activeTasks || ["queued", "dispatched", "running"].includes(task.status)) && (!query.taskStatus || task.status === query.taskStatus));
  if (query.taskLimit !== undefined) result.tasks = result.tasks.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.taskId.localeCompare(left.taskId)).slice(0, query.taskLimit);
  result.audits = result.audits.filter((event) => !query.nodeId && !query.nodeIds || event.nodeId !== null && allowed(event.nodeId)).slice(-10_000);
  return result;
}

export function agentControlKey(section: keyof AgentControlState, row: AgentControlState[keyof AgentControlState][number]): string {
  if (section === "nonces") { const nonce = row as AgentControlState["nonces"][number]; return JSON.stringify([nonce.credentialId, nonce.nonce]); }
  const key = { enrollments: "enrollmentId", credentials: "credentialId", nodes: "nodeId", tasks: "taskId", audits: "eventId", nonces: "" }[section];
  return (row as unknown as Record<string, string>)[key]!;
}

function mergeProjection(state: AgentControlState, before: AgentControlState, after: AgentControlState) {
  for (const section of Object.keys(state) as Array<keyof AgentControlState>) {
    const replaced = new Set(before[section].map((row) => agentControlKey(section, row)));
    Object.assign(state, { [section]: [...state[section].filter((row) => !replaced.has(agentControlKey(section, row))), ...after[section]] });
  }
}

const AgentControlStateSchema: z.ZodType<AgentControlState> = z.object({
  enrollments: z.array(z.object({ enrollmentId: z.string().uuid(), tokenDigest: z.string().regex(/^[a-f0-9]{64}$/), nodeName: z.string(), expiresAt: z.string().datetime(), usedAt: z.string().datetime().nullable(), revokedAt: z.string().datetime().nullable() })),
  credentials: z.array(z.object({ credentialId: z.string().uuid(), nodeId: z.string().uuid(), publicKey: z.string(), createdAt: z.string().datetime(), revokedAt: z.string().datetime().nullable(), replacedBy: z.string().uuid().nullable(), rotationId: z.string().uuid().nullable() })),
  nodes: z.array(AgentNodeStateSchema),
  nonces: z.array(z.object({ credentialId: z.string().uuid(), nonce: z.string(), expiresAt: z.string().datetime() })),
  tasks: z.array(RemoteTaskRecordSchema),
  audits: z.array(z.object({ eventId: z.string().uuid(), timestamp: z.string().datetime(), requester: z.string(), nodeId: z.string().uuid().nullable(), taskId: z.string().uuid().nullable(), event: z.string(), taskType: z.string().nullable(), parameters: z.record(z.string(), z.unknown()).nullable(), fromStatus: z.string().nullable(), toStatus: z.string().nullable(), resultSummary: z.string().nullable(), traceId: z.string().uuid() })),
});

const emptyState = (): AgentControlState => ({ enrollments: [], credentials: [], nodes: [], nonces: [], tasks: [], audits: [] });
const sensitiveAuditKey = /authorization|cookie|token|secret|password|private|key|environment|stdout|stderr/i;
function redactAuditValue(value: unknown): unknown { if (Array.isArray(value)) return value.map(redactAuditValue); if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, sensitiveAuditKey.test(key) ? "[REDACTED]" : redactAuditValue(nested)])); return value; }
export function sanitizeAgentControlState(state: AgentControlState) { state.audits = state.audits.map((event) => ({ ...event, parameters: event.parameters ? redactAuditValue(event.parameters) as Record<string, unknown> : null, resultSummary: event.resultSummary?.slice(0, 1024) ?? null })); }

export interface AgentControlRepository {
  read(query?: AgentControlQuery): Promise<AgentControlState>;
  update(mutate: (state: AgentControlState) => void, query?: AgentControlQuery): Promise<AgentControlState>;
  consumeNonce(request: AgentNonceRequest): Promise<AgentNonceConsumption>;
  updateNodeWithAudit(nodeId: string, mutate: (node: AgentNodeState) => AuditEvent): Promise<AgentNodeState | null>;
}

function consumeNonce(state: AgentControlState, request: AgentNonceRequest): AgentNonceConsumption {
  state.nonces = state.nonces.filter((item) => Date.parse(item.expiresAt) > Date.now());
  const node = state.nodes.find((item) => item.nodeId === request.nodeId);
  const credential = state.credentials.find((item) => item.credentialId === request.credentialId && item.nodeId === request.nodeId);
  const revokedCredentialAllowed = request.allowRevokedCredential && Boolean(credential?.revokedAt && credential.replacedBy && credential.rotationId);
  if (!node || node.revokedAt || !credential || (credential.revokedAt && !revokedCredentialAllowed)) return "unauthorized";
  if (state.nonces.some((item) => item.credentialId === request.credentialId && item.nonce === request.nonce)) return "replayed";
  state.nonces.push({ credentialId: request.credentialId, nonce: request.nonce, expiresAt: request.expiresAt });
  return "accepted";
}

export class MemoryAgentControlRepository implements AgentControlRepository {
  private state = emptyState();
  async read(query?: AgentControlQuery) { return projectAgentControlState(this.state, query); }
  async update(mutate: (state: AgentControlState) => void, query?: AgentControlQuery) {
    const before = projectAgentControlState(this.state, query), next = structuredClone(before);
    mutate(next); sanitizeAgentControlState(next); mergeProjection(this.state, before, next); this.state.audits = this.state.audits.slice(-10_000); return structuredClone(next);
  }
  async consumeNonce(request: AgentNonceRequest) {
    let result: AgentNonceConsumption = "unauthorized";
    await this.update((state) => { result = consumeNonce(state, request); });
    return result;
  }
  async updateNodeWithAudit(nodeId: string, mutate: (node: AgentNodeState) => AuditEvent) {
    let updated: AgentNodeState | undefined;
    await this.update((state) => {
      const node = state.nodes.find((item) => item.nodeId === nodeId);
      if (!node) return;
      state.audits.push(mutate(node));
      updated = node;
    });
    return updated ? structuredClone(updated) : null;
  }
}

export class FileAgentControlRepository implements AgentControlRepository {
  private queue = Promise.resolve();
  constructor(private readonly filePath: string) {}

  async read(query?: AgentControlQuery): Promise<AgentControlState> {
    try { return projectAgentControlState(AgentControlStateSchema.parse(JSON.parse(await readFile(this.filePath, "utf8"))), query); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyState(); throw error; }
  }

  async update(mutate: (state: AgentControlState) => void, query?: AgentControlQuery): Promise<AgentControlState> {
    const operation = this.queue.catch(() => undefined).then(async () => {
      const state = await this.read();
      const before = projectAgentControlState(state, query), next = structuredClone(before);
      mutate(next);
      sanitizeAgentControlState(next);
      mergeProjection(state, before, next);
      state.nonces = state.nonces.filter((item) => Date.parse(item.expiresAt) > Date.now());
      state.audits = state.audits.slice(-10_000);
      await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
      await chmod(dirname(this.filePath), 0o700);
      const temporary = `${this.filePath}.${process.pid}.tmp`;
      await writeFile(temporary, JSON.stringify(state, null, 2), { encoding: "utf8", mode: 0o600 });
      await rename(temporary, this.filePath);
      await chmod(this.filePath, 0o600);
      return structuredClone(next);
    });
    this.queue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async consumeNonce(request: AgentNonceRequest) {
    let result: AgentNonceConsumption = "unauthorized";
    await this.update((state) => { result = consumeNonce(state, request); });
    return result;
  }

  async updateNodeWithAudit(nodeId: string, mutate: (node: AgentNodeState) => AuditEvent) {
    let updated: AgentNodeState | undefined;
    await this.update((state) => {
      const node = state.nodes.find((item) => item.nodeId === nodeId);
      if (!node) return;
      state.audits.push(mutate(node));
      updated = node;
    });
    return updated ? structuredClone(updated) : null;
  }
}

export const CONTROLLER_SUPPORTED_AGENT_CAPABILITIES: readonly AgentCapability[] = [
  "system.summary.read", "service.status.read", "sites.inventory.read", "sites.logs.read",
  "terminal.command.execute", "sites.deploy", "sites.lifecycle.manage", "sites.certificates.renew", "runtime.install", "databases.inventory.read",
  "database.inventory.read", "database.sql.read", "database.backup", "database.operate", "database.install", "database.restore",
  "network.mesh.read", "network.mesh.configure", "network.cache.read", "network.transfer",
];
export const DEFAULT_AGENT_CAPABILITIES: readonly AgentCapability[] = ["system.summary.read", "service.status.read", "sites.inventory.read", "databases.inventory.read"];
