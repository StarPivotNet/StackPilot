import { createHash } from "node:crypto";
import { SiteRuntimePayloadSchema } from "@stackpilot/contracts";
import type {
  AgentSiteSnapshotRecord, RemoteTaskRecord, SiteCertificate, SiteRuntimePayload, SiteRuntimeRecord,
} from "@stackpilot/contracts";
import type { AgentControlRepository, AgentNodeState } from "../../repositories/agentControlRepository.js";

type SiteCollector = { collectSites(): Promise<SiteRuntimePayload> };
export type SiteAccess = { nodeScope: "all" | string[] };

const STALE_AFTER_MS = 150_000;

export function publicSiteId(nodeId: string, siteId: string) {
  return `site-${createHash("sha256").update(`${nodeId}\0${siteId}`).digest("hex").slice(0, 32)}`;
}

function certificateStatus(expiresAt: string | null): SiteCertificate["status"] {
  if (!expiresAt) return "unavailable";
  const remaining = Date.parse(expiresAt) - Date.now();
  if (remaining <= 0) return "expired";
  if (remaining <= 7 * 86_400_000) return "critical";
  if (remaining < 14 * 86_400_000) return "expiring";
  return "valid";
}

function renewalState(siteId: string, tasks: RemoteTaskRecord[]): SiteRuntimeRecord["renewal"] {
  const task = tasks
    .filter((item) => item.type === "sites.certificates.renew" && taskSiteIds(item).includes(siteId))
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0];
  if (!task) return { batchId: null, taskId: null, status: "idle", message: null, updatedAt: null };
  const status = task.status === "dispatched" ? "queued" : task.status;
  return {
    batchId: taskBatchId(task), taskId: task.taskId, status,
    message: (task.result?.message ?? task.errorCode)?.slice(0, 512) ?? null, updatedAt: task.updatedAt,
  };
}

function taskParameters(task: RemoteTaskRecord) {
  return task.parameters as { batchId?: unknown; certificates?: Array<{ certificateId?: unknown; siteIds?: unknown }> };
}

export function taskBatchId(task: RemoteTaskRecord) {
  const value = taskParameters(task).batchId;
  return typeof value === "string" ? value : null;
}

export function taskSiteIds(task: RemoteTaskRecord) {
  return (taskParameters(task).certificates ?? []).flatMap((certificate) =>
    Array.isArray(certificate.siteIds) ? certificate.siteIds.filter((siteId): siteId is string => typeof siteId === "string") : [],
  );
}

function remoteSite(node: AgentNodeState, site: AgentSiteSnapshotRecord, tasks: RemoteTaskRecord[]): SiteRuntimeRecord {
  const collectedAt = node.siteSnapshot!.collectedAt;
  const freshness = Date.now() - Date.parse(collectedAt) <= STALE_AFTER_MS ? "current" : "stale";
  const id = publicSiteId(node.nodeId, site.id);
  let unavailableReason = site.certificate.unavailableReason;
  const capabilityReady = node.platform === "linux"
    && node.declaredCapabilities.includes("sites.certificates.renew")
    && node.allowedCapabilities.includes("sites.certificates.renew");
  const renewable = site.certificate.renewable && freshness === "current" && capabilityReady;
  if (freshness !== "current") unavailableReason = "站点快照已过期";
  else if (node.platform !== "linux") unavailableReason = "证书续期首版仅支持 Linux";
  else if (!capabilityReady) unavailableReason = "节点未声明或未获授权执行证书续期";
  return {
    ...site, id, nodeId: node.nodeId, collectedAt, freshness,
    certificate: {
      ...site.certificate, status: certificateStatus(site.certificate.expiresAt), renewable,
      unavailableReason: renewable ? null : (unavailableReason ?? "证书不可续期"),
    },
    renewal: renewalState(id, tasks),
  };
}

function siteHostKey(site: Pick<SiteRuntimeRecord, "domain" | "host">) {
  return `${site.host.trim().toLowerCase()}\0${site.domain.trim().toLowerCase()}`;
}

function mergeLocalProbe(site: SiteRuntimeRecord, localByHost: ReadonlyMap<string, SiteRuntimeRecord>) {
  const local = localByHost.get(siteHostKey(site));
  return local ? { ...site, status: local.status, latencyMs: local.latencyMs } : site;
}

export class SiteMonitoringService {
  private cached: SiteRuntimePayload | null = null;
  private inFlight: Promise<SiteRuntimePayload> | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;

  private readonly repository?: AgentControlRepository;
  private readonly refreshMs: number;

  constructor(private readonly collector: SiteCollector, repositoryOrCache?: AgentControlRepository | number, refreshMs = 60_000) {
    this.repository = typeof repositoryOrCache === "number" ? undefined : repositoryOrCache;
    this.refreshMs = typeof repositoryOrCache === "number" ? repositoryOrCache : refreshMs;
  }

  async startup() {
    await this.refreshLocalSites();
    if (this.refreshTimer) return;
    this.refreshTimer = setInterval(() => { void this.refreshLocalSites().catch(() => undefined); }, this.refreshMs);
    this.refreshTimer.unref();
  }

  shutdown() {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
  }

  private refreshLocalSites() {
    if (this.inFlight) return this.inFlight;
    const request = this.collector.collectSites().then((payload) => {
      const parsed = SiteRuntimePayloadSchema.parse(payload);
      this.cached = parsed;
      return parsed;
    }).finally(() => { if (this.inFlight === request) this.inFlight = null; });
    this.inFlight = request;
    return request;
  }

  getLocalSites() {
    return this.cached ? Promise.resolve(this.cached) : this.refreshLocalSites();
  }

  async getSites(access: SiteAccess = { nodeScope: [] }) {
    const local = await this.getLocalSites();
    if (!this.repository) return local;
    const state = await this.repository.read({ sections: ["nodes"] });
    const permitted = state.nodes.filter((node) =>
      !node.revokedAt && node.siteSnapshot && (access.nodeScope === "all" || access.nodeScope.includes(node.nodeId)),
    );
    const localByHost = new Map(local.sites.map((site) => [siteHostKey(site), site]));
    const remoteSites = permitted.flatMap((node) => node.siteSnapshot!.sites
      .map((site) => mergeLocalProbe(remoteSite(node, site, state.tasks), localByHost)));
    const remoteHostKeys = new Set(remoteSites.map(siteHostKey));
    const localSites = local.sites
      .filter((site) => !remoteHostKeys.has(siteHostKey(site)))
      .map((site) => ({ ...site, renewal: renewalState(site.id, state.tasks) }));
    const snapshots = permitted.map((node) => node.siteSnapshot!);
    const staleNodes = permitted.filter((node) => Date.now() - Date.parse(node.siteSnapshot!.collectedAt) > STALE_AFTER_MS);
    const statuses = [local.collectionStatus, ...snapshots.map((snapshot) => snapshot.collectionStatus)];
    const collectionStatus = !staleNodes.length && statuses.every((status) => status === "complete") ? "complete"
      : statuses.every((status) => status === "unavailable") ? "unavailable" : "partial";
    const collectedAt = [local.collectedAt, ...snapshots.map((snapshot) => snapshot.collectedAt)]
      .sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? local.collectedAt;
    return SiteRuntimePayloadSchema.parse({
      collectedAt, collectionStatus,
      warnings: [...local.warnings, ...snapshots.flatMap((snapshot) => snapshot.warnings), ...staleNodes.map((node) => `节点 ${node.nodeName} 的站点快照已过期`)].slice(0, 20),
      sites: [...localSites, ...remoteSites],
    });
  }
}
