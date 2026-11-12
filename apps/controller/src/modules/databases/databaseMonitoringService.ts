import { createHash } from "node:crypto";
import { DatabaseInstancesPayloadSchema } from "@stackpilot/contracts";
import type { AgentDatabaseInstance, AgentDatabaseSnapshot, DatabaseInstanceRecord, DatabaseInstancesPayload } from "@stackpilot/contracts";
import type { AgentControlRepository, AgentNodeState } from "../../repositories/agentControlRepository.js";

export type DatabaseAccess = { nodeScope: "all" | string[] };
export type LocalDatabaseCollector = { collect(): Promise<AgentDatabaseSnapshot> };
const STALE_AFTER_MS = 150_000;
const MAX_DATABASE_INSTANCES = 10_000;
const LOCAL_NODE_ID = "00000000-0000-0000-0000-000000000000";
const LOCAL_NODE_NAME = "Controller";
const LOCAL_COLLECTION_INTERVAL_MS = 60_000;

function isStale(collectedAt: string, now = Date.now()) {
  const age = now - Date.parse(collectedAt);
  return age < 0 || age > STALE_AFTER_MS;
}

export function publicDatabaseId(nodeId: string, instanceId: string) {
  return `database-${createHash("sha256").update(`${nodeId}\0${instanceId}`).digest("hex").slice(0, 32)}`;
}

function runtimeRecord(node: AgentNodeState, instance: AgentDatabaseInstance): DatabaseInstanceRecord {
  const collectedAt = node.databaseSnapshot!.collectedAt;
  return {
    ...instance, managed: instance.managed ?? false,
    historicalSlowQueriesAvailable: instance.historicalSlowQueriesAvailable ?? false,
    volumes: instance.volumes ?? [],
    id: publicDatabaseId(node.nodeId, instance.id), nodeId: node.nodeId, nodeName: node.nodeName,
    address: node.telemetry?.primaryIp ?? null, collectedAt,
    freshness: isStale(collectedAt) ? "stale" : "current",
  };
}

function localRuntimeRecord(snapshot: AgentDatabaseSnapshot, instance: AgentDatabaseInstance): DatabaseInstanceRecord {
  return {
    ...instance, managed: instance.managed ?? false,
    historicalSlowQueriesAvailable: instance.historicalSlowQueriesAvailable ?? false,
    volumes: instance.volumes ?? [],
    id: publicDatabaseId(LOCAL_NODE_ID, instance.id),
    nodeId: LOCAL_NODE_ID,
    nodeName: instance.host || LOCAL_NODE_NAME,
    address: null,
    collectedAt: snapshot.collectedAt,
    freshness: isStale(snapshot.collectedAt) ? "stale" : "current",
  };
}

function snapshotInstances(snapshot: AgentDatabaseSnapshot) {
  const hasPostgresCluster = snapshot.instances.some((instance) => /^postgresql@.+\.service$/.test(instance.id));
  return snapshot.instances.filter((instance) => !(hasPostgresCluster && instance.id === "postgresql.service"));
}

function instanceIdentity(instance: AgentDatabaseInstance) {
  return `${instance.host.toLowerCase()}\0${instance.engine}\0${instance.source.toLowerCase()}`;
}

export class DatabaseMonitoringService {
  private localSnapshot: AgentDatabaseSnapshot | undefined;
  private localCollection: Promise<AgentDatabaseSnapshot> | undefined;
  private localCollectionStartedAt = 0;

  constructor(
    private readonly repository: AgentControlRepository,
    private readonly localCollector?: LocalDatabaseCollector,
    private readonly localCollectionIntervalMs = LOCAL_COLLECTION_INTERVAL_MS,
  ) {}

  private collectLocal(now = Date.now()) {
    if (!this.localCollector) return Promise.resolve<AgentDatabaseSnapshot | undefined>(undefined);
    if (this.localCollection) return this.localCollection;
    if (this.localSnapshot && now - this.localCollectionStartedAt < this.localCollectionIntervalMs) return Promise.resolve(this.localSnapshot);
    this.localCollectionStartedAt = now;
    this.localCollection = this.localCollector.collect().then((snapshot) => {
      this.localSnapshot = snapshot.collectionStatus === "unavailable" && this.localSnapshot?.instances.length
        ? { ...snapshot, collectedAt: this.localSnapshot.collectedAt, collectionStatus: "partial", instances: this.localSnapshot.instances, warnings: [...snapshot.warnings, "已保留 Controller 本机上次成功采集的数据库实例"].slice(0, 20) }
        : snapshot;
      return this.localSnapshot;
    }).finally(() => { this.localCollection = undefined; });
    return this.localCollection;
  }

  async getInstances(access: DatabaseAccess): Promise<DatabaseInstancesPayload> {
    const [state, localSnapshot] = await Promise.all([this.repository.read({ sections: ["nodes"] }), this.collectLocal()]);
    const authorizedNodes = state.nodes.filter((node) => !node.revokedAt && (access.nodeScope === "all" || access.nodeScope.includes(node.nodeId)));
    const nodes = authorizedNodes.filter((node) => node.databaseSnapshot);
    const pendingNodes = authorizedNodes.filter((node) => !node.databaseSnapshot);
    const snapshots = [...nodes.map((node) => node.databaseSnapshot!), ...(localSnapshot ? [localSnapshot] : [])];
    const staleNodes = nodes.filter((node) => isStale(node.databaseSnapshot!.collectedAt));
    const localStale = Boolean(localSnapshot && isStale(localSnapshot.collectedAt));
    const statuses = snapshots.map((snapshot) => snapshot.collectionStatus);
    let collectionStatus = !snapshots.length || statuses.every((status) => status === "unavailable") ? "unavailable"
      : !pendingNodes.length && !staleNodes.length && !localStale && statuses.every((status) => status === "complete") ? "complete" : "partial";
    const collectedAt = snapshots.map((snapshot) => snapshot.collectedAt).sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? new Date().toISOString();
    const localInstances = localSnapshot ? snapshotInstances(localSnapshot) : [];
    const localIdentities = new Set(localInstances.map(instanceIdentity));
    const allInstances = [
      ...(localSnapshot ? localInstances.map((instance) => localRuntimeRecord(localSnapshot, instance)) : []),
      ...nodes.flatMap((node) => snapshotInstances(node.databaseSnapshot!)
        .filter((instance) => !localIdentities.has(instanceIdentity(instance)))
        .map((instance) => runtimeRecord(node, instance))),
    ];
    const truncated = allInstances.length > MAX_DATABASE_INSTANCES;
    if (truncated) collectionStatus = "partial";
    const truncationWarning = truncated ? [`数据库实例超过 ${MAX_DATABASE_INSTANCES} 条，响应已截断`] : [];
    return DatabaseInstancesPayloadSchema.parse({
      collectedAt, collectionStatus,
      warnings: [...truncationWarning, ...snapshots.flatMap((snapshot) => snapshot.warnings), ...pendingNodes.map((node) => `节点 ${node.nodeName} 尚未上报数据库服务清单`), ...staleNodes.map((node) => `节点 ${node.nodeName} 的数据库清单已过期`), ...(localStale ? ["Controller 本机数据库清单已过期"] : []), ...(!snapshots.length ? ["授权节点尚未上报数据库服务清单"] : [])].slice(0, 20),
      instances: allInstances.slice(0, MAX_DATABASE_INSTANCES),
    });
  }
}
