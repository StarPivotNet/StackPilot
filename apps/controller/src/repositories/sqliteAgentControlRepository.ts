import type Database from "better-sqlite3";
import { AgentNodeStateSchema, sanitizeAgentControlState, type AgentControlQuery, type AgentControlRepository, type AgentControlState, type AgentNodeState, type AgentNonceRequest, type AuditEvent } from "./agentControlRepository.js";
import type { AuditRepository } from "../audit/auditRepository.js";
import type { RemoteTaskRecord } from "@stackpilot/contracts";
import type { SecretStore } from "../security/secretStore.js";

const empty = (): AgentControlState => ({ enrollments: [], credentials: [], nodes: [], nonces: [], tasks: [], audits: [] });
function changes<T>(before: T[], after: T[], key: (row: T) => string) {
  const previous = new Map(before.map((row) => [key(row), JSON.stringify(row)]));
  const current = new Set(after.map(key));
  return { removed: before.filter((row) => !current.has(key(row))), changed: after.filter((row) => previous.get(key(row)) !== JSON.stringify(row)) };
}

export class SqliteAgentControlRepository implements AgentControlRepository {
  private queue = Promise.resolve();
  constructor(private readonly database: Database.Database, private readonly audit?: AuditRepository, private readonly secrets?: SecretStore) {}

  private enqueue<T>(run: () => T): Promise<T> {
    const operation = this.queue.then(run, run);
    this.queue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private task(row: { payload: string }): RemoteTaskRecord {
    const payload = JSON.parse(row.payload) as { encryptedTaskKey: string } | RemoteTaskRecord;
    if (!("encryptedTaskKey" in payload)) return payload;
    const decrypted = this.secrets?.get(payload.encryptedTaskKey);
    if (!decrypted) throw new Error("Encrypted remote task payload is unavailable");
    return JSON.parse(decrypted.toString("utf8")) as RemoteTaskRecord;
  }

  private taskPayload(task: RemoteTaskRecord): string {
    if (!this.secrets) return JSON.stringify(task);
    const encryptedTaskKey = `remote-task:${task.taskId}`;
    this.secrets.set(encryptedTaskKey, Buffer.from(JSON.stringify(task)));
    return JSON.stringify({ encryptedTaskKey });
  }

  private readState(query: AgentControlQuery = {}): AgentControlState {
    const state = empty();
    const includes = (section: keyof AgentControlState) => !query.sections || query.sections.includes(section);
    const nodeClauses: string[] = [], nodeValues: string[] = [];
    if (query.nodeId) { nodeClauses.push("node_id=?"); nodeValues.push(query.nodeId); }
    if (query.nodeIds) {
      nodeClauses.push(query.nodeIds.length ? `node_id IN (${query.nodeIds.map(() => "?").join(",")})` : "0");
      nodeValues.push(...query.nodeIds);
    }
    const where = (clauses: string[]) => clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    if (includes("enrollments")) state.enrollments = (this.database.prepare("SELECT * FROM agent_enrollments").all() as Array<Record<string, unknown>>).map((r) => ({ enrollmentId: r.enrollment_id as string, tokenDigest: r.token_digest as string, nodeName: r.node_name as string, expiresAt: r.expires_at as string, usedAt: r.used_at as string | null, revokedAt: r.revoked_at as string | null }));
    if (includes("credentials")) {
      const clauses = [...nodeClauses], values = [...nodeValues];
      if (query.credentialId) { clauses.push("credential_id=?"); values.push(query.credentialId); }
      state.credentials = (this.database.prepare(`SELECT * FROM agent_credentials${where(clauses)}`).all(...values) as Array<Record<string, unknown>>).map((r) => ({ credentialId: r.credential_id as string, nodeId: r.node_id as string, publicKey: r.public_key as string, createdAt: r.created_at as string, revokedAt: r.revoked_at as string | null, replacedBy: r.replaced_by as string | null, rotationId: r.rotation_id as string | null }));
    }
    if (includes("nodes")) state.nodes = (this.database.prepare(`SELECT payload FROM agent_nodes${where(nodeClauses)}`).all(...nodeValues) as Array<{ payload: string }>).map((r) => JSON.parse(r.payload));
    if (includes("nonces")) {
      const clauses = ["expires_at>?"], values = [new Date().toISOString()];
      if (query.credentialId) { clauses.push("credential_id=?"); values.push(query.credentialId); }
      state.nonces = (this.database.prepare(`SELECT credential_id,nonce,expires_at FROM agent_nonces${where(clauses)}`).all(...values) as Array<{ credential_id: string; nonce: string; expires_at: string }>).map((r) => ({ credentialId: r.credential_id, nonce: r.nonce, expiresAt: r.expires_at }));
    }
    if (includes("tasks")) {
      const clauses = [...nodeClauses], values: Array<string | number> = [...nodeValues];
      if (query.taskId) { clauses.push("task_id=?"); values.push(query.taskId); }
      if (query.activeTasks) clauses.push("status IN ('queued','dispatched','running')");
      if (query.taskStatus) { clauses.push("status=?"); values.push(query.taskStatus); }
      let limit = "";
      if (query.taskLimit !== undefined) { limit = " ORDER BY updated_at DESC,task_id DESC LIMIT ?"; values.push(query.taskLimit); }
      state.tasks = (this.database.prepare(`SELECT payload FROM remote_tasks${where(clauses)}${limit}`).all(...values) as Array<{ payload: string }>).map((r) => this.task(r));
    }
    if (includes("audits")) {
      const clauses = nodeClauses.map((clause) => clause.replaceAll("node_id", "json_extract(payload,'$.nodeId')"));
      state.audits = (this.database.prepare(`SELECT payload FROM agent_protocol_audits${where(clauses)} ORDER BY rowid DESC LIMIT 10000`).all(...nodeValues) as Array<{ payload: string }>).reverse().map((r) => JSON.parse(r.payload));
    }
    return state;
  }

  async read(query?: AgentControlQuery): Promise<AgentControlState> { return this.readState(query); }

  async update(mutate: (state: AgentControlState) => void, query?: AgentControlQuery): Promise<AgentControlState> {
    return this.enqueue(() => this.database.transaction(() => {
      const before = this.readState(query), state = structuredClone(before);
      mutate(state);
      sanitizeAgentControlState(state);
      state.nonces = state.nonces.filter((nonce) => Date.parse(nonce.expiresAt) > Date.now());
      const nodes = changes(before.nodes, state.nodes, (row) => row.nodeId);
      const credentials = changes(before.credentials, state.credentials, (row) => row.credentialId);
      const enrollments = changes(before.enrollments, state.enrollments, (row) => row.enrollmentId);
      const nonces = changes(before.nonces, state.nonces, (row) => JSON.stringify([row.credentialId, row.nonce]));
      const tasks = changes(before.tasks, state.tasks, (row) => row.taskId);
      for (const row of credentials.removed) this.database.prepare("DELETE FROM agent_credentials WHERE credential_id=?").run(row.credentialId);
      for (const row of nodes.removed) this.database.prepare("DELETE FROM agent_nodes WHERE node_id=?").run(row.nodeId);
      for (const row of enrollments.removed) this.database.prepare("DELETE FROM agent_enrollments WHERE enrollment_id=?").run(row.enrollmentId);
      for (const row of nonces.removed) this.database.prepare("DELETE FROM agent_nonces WHERE credential_id=? AND nonce=?").run(row.credentialId, row.nonce);
      for (const row of tasks.removed) {
        this.database.prepare("DELETE FROM remote_tasks WHERE task_id=?").run(row.taskId);
        this.database.prepare("DELETE FROM encrypted_secrets WHERE key=?").run(`remote-task:${row.taskId}`);
      }
      for (const row of nodes.changed) this.database.prepare(`INSERT INTO agent_nodes(node_id,payload,revoked_at,updated_at) VALUES(?,?,?,?)
        ON CONFLICT(node_id) DO UPDATE SET payload=excluded.payload,revoked_at=excluded.revoked_at,updated_at=excluded.updated_at`).run(row.nodeId, JSON.stringify(row), row.revokedAt, row.lastSeenAt ?? row.enrolledAt);
      for (const row of credentials.changed) this.database.prepare(`INSERT INTO agent_credentials VALUES(?,?,?,?,?,?,?)
        ON CONFLICT(credential_id) DO UPDATE SET node_id=excluded.node_id,public_key=excluded.public_key,created_at=excluded.created_at,revoked_at=excluded.revoked_at,replaced_by=excluded.replaced_by,rotation_id=excluded.rotation_id`).run(row.credentialId, row.nodeId, row.publicKey, row.createdAt, row.revokedAt, row.replacedBy, row.rotationId);
      for (const row of enrollments.changed) this.database.prepare(`INSERT INTO agent_enrollments VALUES(?,?,?,?,?,?)
        ON CONFLICT(enrollment_id) DO UPDATE SET token_digest=excluded.token_digest,node_name=excluded.node_name,expires_at=excluded.expires_at,used_at=excluded.used_at,revoked_at=excluded.revoked_at`).run(row.enrollmentId, row.tokenDigest, row.nodeName, row.expiresAt, row.usedAt, row.revokedAt);
      for (const row of nonces.changed) this.database.prepare("INSERT INTO agent_nonces VALUES(?,?,?) ON CONFLICT(credential_id,nonce) DO UPDATE SET expires_at=excluded.expires_at").run(row.credentialId, row.nonce, row.expiresAt);
      for (const row of tasks.changed) this.database.prepare(`INSERT INTO remote_tasks(task_id,node_id,payload,status,updated_at) VALUES(?,?,?,?,?)
        ON CONFLICT(task_id) DO UPDATE SET node_id=excluded.node_id,payload=excluded.payload,status=excluded.status,updated_at=excluded.updated_at,version=remote_tasks.version+1`).run(row.taskId, row.targetNodeId, this.taskPayload(row), row.status, row.updatedAt);
      const previousAudits = new Set(before.audits.map((event) => event.eventId));
      for (const event of state.audits) if (!previousAudits.has(event.eventId)) this.storeAudit(event);
      if (state.audits.some((event) => !previousAudits.has(event.eventId))) this.pruneProtocolAudits();
      state.audits = state.audits.slice(-10_000);
      return state;
    }).immediate());
  }

  async consumeNonce(request: AgentNonceRequest) {
    return this.enqueue(() => this.database.transaction(() => {
      this.database.prepare("DELETE FROM agent_nonces WHERE expires_at<=?").run(new Date().toISOString());
      const node = this.database.prepare("SELECT revoked_at FROM agent_nodes WHERE node_id=?").get(request.nodeId) as { revoked_at: string | null } | undefined;
      const credential = this.database.prepare("SELECT revoked_at,replaced_by,rotation_id FROM agent_credentials WHERE credential_id=? AND node_id=?").get(request.credentialId, request.nodeId) as { revoked_at: string | null; replaced_by: string | null; rotation_id: string | null } | undefined;
      const revokedCredentialAllowed = request.allowRevokedCredential && Boolean(credential?.revoked_at && credential.replaced_by && credential.rotation_id);
      if (!node || node.revoked_at || !credential || (credential.revoked_at && !revokedCredentialAllowed)) return "unauthorized" as const;
      try {
        this.database.prepare("INSERT INTO agent_nonces VALUES(?,?,?)").run(request.credentialId, request.nonce, request.expiresAt);
        return "accepted" as const;
      } catch (error) {
        if ((error as { code?: string }).code?.startsWith("SQLITE_CONSTRAINT")) return "replayed" as const;
        throw error;
      }
    }).immediate());
  }

  async updateNodeWithAudit(nodeId: string, mutate: (node: AgentNodeState) => AuditEvent): Promise<AgentNodeState | null> {
    return this.enqueue(() => this.database.transaction(() => {
      const row = this.database.prepare("SELECT payload FROM agent_nodes WHERE node_id=?").get(nodeId) as { payload: string } | undefined;
      if (!row) return null;
      const node = AgentNodeStateSchema.parse(JSON.parse(row.payload)) as AgentNodeState;
      const state = empty(); state.audits.push(mutate(node)); sanitizeAgentControlState(state);
      this.database.prepare("UPDATE agent_nodes SET payload=?,revoked_at=?,updated_at=? WHERE node_id=?").run(JSON.stringify(node), node.revokedAt, node.lastSeenAt ?? node.enrolledAt, nodeId);
      this.storeAudit(state.audits[0]!);
      this.pruneProtocolAudits();
      return node;
    }).immediate());
  }

  private storeAudit(event: AuditEvent) {
    this.database.prepare("INSERT INTO agent_protocol_audits VALUES(?,?,?)").run(event.eventId, JSON.stringify(event), event.timestamp);
    this.audit?.append({ actorType: event.requester.startsWith("agent:") ? "agent" : "user", actorId: event.requester, source: "controller-agent", targetType: event.taskId ? "remote-task" : "node", targetId: event.taskId ?? event.nodeId, action: event.event, parameters: event.parameters, outcome: event.toStatus ?? "recorded", authorization: "controller-agent-policy", requestId: event.traceId, traceId: event.traceId });
  }

  private pruneProtocolAudits() {
    this.database.prepare("DELETE FROM agent_protocol_audits WHERE rowid IN (SELECT rowid FROM agent_protocol_audits ORDER BY rowid DESC LIMIT -1 OFFSET 10000)").run();
  }
}
