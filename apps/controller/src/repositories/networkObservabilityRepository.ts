import type Database from "better-sqlite3";

/** One `network.cache.fetch` task as the panel and the monthly meter see it; no byte is estimated. */
export type DownloadJobRecord = {
  taskId: string;
  nodeId: string;
  url: string;
  host: string;
  digest: string | null;
  status: string;
  bytesReceived: number;
  totalBytes: number | null;
  partsDone: number;
  partsTotal: number;
  segmented: boolean;
  segmentCount: number;
  segmentSources: number;
  bytesPerSecond: number | null;
  resumedBytes: number;
  hit: boolean | null;
  viaEgress: boolean | null;
  originBytes: number | null;
  sizeBytes: number | null;
  failureReason: string | null;
  attempt: number;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
};

/** Which peer served which part of one job. */
export type DownloadSegmentRecord = { jobId: string; partIndex: number; sourceNodeId: string; bytes: number; resumed: boolean };

/** Month-to-date totals per node: what it pulled in, what it read from the origin, what it served. */
export type NodeTrafficRecord = { nodeId: string; receivedBytes: number; originBytes: number; servedBytes: number };

/** How many peers one node was told about at one revision. */
export type MeshPeerCountRecord = { nodeId: string; revision: number; peerCount: number };

/**
 * Durable view of the mesh's own traffic. The task records stay authoritative; these rows are the
 * index the panel and the meter read, so neither has to decrypt every task payload to answer.
 */
export interface NetworkObservabilityRepository {
  saveJob(job: DownloadJobRecord): void;
  listJobs(limit: number, nodeIds?: readonly string[]): DownloadJobRecord[];
  saveSegments(jobId: string, segments: readonly DownloadSegmentRecord[]): void;
  trafficSince(monthStart: string, nodeIds?: readonly string[]): NodeTrafficRecord[];
  saveMeshPeers(nodeId: string, revision: number, peerNodeIds: readonly string[], createdAt: string): void;
  meshPeerCounts(nodeIds?: readonly string[]): MeshPeerCountRecord[];
  pruneJobs(cutoff: string): void;
}

const flag = (value: boolean) => (value ? 1 : 0);

export class MemoryNetworkObservabilityRepository implements NetworkObservabilityRepository {
  private readonly jobs = new Map<string, DownloadJobRecord>();
  private readonly segments = new Map<string, DownloadSegmentRecord[]>();
  private readonly meshPeers = new Map<string, { revision: number; peerNodeIds: string[]; createdAt: string }>();

  saveJob(job: DownloadJobRecord) { this.jobs.set(job.taskId, { ...job }); }

  listJobs(limit: number, nodeIds?: readonly string[]) {
    const scope = nodeIds === undefined ? null : new Set(nodeIds);
    return [...this.jobs.values()]
      .filter((job) => scope === null || scope.has(job.nodeId))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.taskId.localeCompare(left.taskId))
      .slice(0, limit)
      .map((job) => ({ ...job }));
  }

  saveSegments(jobId: string, segments: readonly DownloadSegmentRecord[]) {
    this.segments.set(jobId, segments.map((segment) => ({ ...segment })));
  }

  trafficSince(monthStart: string, nodeIds?: readonly string[]) {
    const scope = nodeIds === undefined ? null : new Set(nodeIds);
    const inScope = (nodeId: string) => scope === null || scope.has(nodeId);
    const received = new Map<string, { receivedBytes: number; originBytes: number }>();
    for (const job of this.jobs.values()) {
      if (job.createdAt < monthStart || !inScope(job.nodeId)) continue;
      const entry = received.get(job.nodeId) ?? { receivedBytes: 0, originBytes: 0 };
      // A cache hit reads the object from local disk; the meter counts what crossed the network.
      entry.receivedBytes += job.hit === true ? 0 : job.sizeBytes ?? job.bytesReceived;
      entry.originBytes += job.originBytes ?? 0;
      received.set(job.nodeId, entry);
    }
    const served = new Map<string, number>();
    for (const [jobId, rows] of this.segments) {
      const job = this.jobs.get(jobId);
      if (!job || job.createdAt < monthStart) continue;
      for (const row of rows) if (inScope(row.sourceNodeId)) served.set(row.sourceNodeId, (served.get(row.sourceNodeId) ?? 0) + row.bytes);
    }
    return [...new Set([...received.keys(), ...served.keys()])].sort().map((nodeId) => ({
      nodeId,
      receivedBytes: received.get(nodeId)?.receivedBytes ?? 0,
      originBytes: received.get(nodeId)?.originBytes ?? 0,
      servedBytes: served.get(nodeId) ?? 0,
    }));
  }

  saveMeshPeers(nodeId: string, revision: number, peerNodeIds: readonly string[], createdAt: string) {
    this.meshPeers.set(nodeId, { revision, peerNodeIds: [...new Set(peerNodeIds)], createdAt });
  }

  meshPeerCounts(nodeIds?: readonly string[]) {
    const scope = nodeIds === undefined ? null : new Set(nodeIds);
    return [...this.meshPeers.entries()]
      .filter(([nodeId]) => scope === null || scope.has(nodeId))
      .map(([nodeId, entry]) => ({ nodeId, revision: entry.revision, peerCount: entry.peerNodeIds.length }))
      .sort((left, right) => left.nodeId.localeCompare(right.nodeId));
  }

  pruneJobs(cutoff: string) {
    for (const [taskId, job] of this.jobs) {
      if (job.createdAt >= cutoff) continue;
      this.jobs.delete(taskId); this.segments.delete(taskId);
    }
  }
}

type JobRow = {
  task_id: string; node_id: string; url: string; host: string; digest: string | null; status: string;
  bytes_received: number; total_bytes: number | null; parts_done: number; parts_total: number;
  segmented: number; segment_count: number; segment_sources: number; bytes_per_second: number | null; resumed_bytes: number;
  hit: number | null; via_egress: number | null;
  origin_bytes: number | null; size_bytes: number | null; failure_reason: string | null; attempt: number;
  created_at: string; updated_at: string; expires_at: string;
};

const nullableFlag = (value: boolean | null) => (value === null ? null : flag(value));

function fromRow(row: JobRow): DownloadJobRecord {
  return {
    taskId: row.task_id, nodeId: row.node_id, url: row.url, host: row.host, digest: row.digest, status: row.status,
    bytesReceived: row.bytes_received, totalBytes: row.total_bytes, partsDone: row.parts_done, partsTotal: row.parts_total,
    segmented: row.segmented === 1, segmentCount: row.segment_count, segmentSources: row.segment_sources,
    bytesPerSecond: row.bytes_per_second, resumedBytes: row.resumed_bytes,
    hit: row.hit === null ? null : row.hit === 1, viaEgress: row.via_egress === null ? null : row.via_egress === 1,
    originBytes: row.origin_bytes, sizeBytes: row.size_bytes, failureReason: row.failure_reason, attempt: row.attempt,
    createdAt: row.created_at, updatedAt: row.updated_at, expiresAt: row.expires_at,
  };
}

const inClause = (column: string, values: readonly string[]) => `${column} IN (${values.map(() => "?").join(",")})`;

export class SqliteNetworkObservabilityRepository implements NetworkObservabilityRepository {
  constructor(private readonly database: Database.Database) {}

  saveJob(job: DownloadJobRecord) {
    this.database.prepare(`INSERT INTO download_jobs(task_id,node_id,url,host,digest,status,bytes_received,total_bytes,
      parts_done,parts_total,segmented,segment_count,segment_sources,bytes_per_second,resumed_bytes,hit,via_egress,origin_bytes,size_bytes,failure_reason,attempt,created_at,updated_at,expires_at)
      VALUES(@taskId,@nodeId,@url,@host,@digest,@status,@bytesReceived,@totalBytes,@partsDone,@partsTotal,@segmented,
      @segmentCount,@segmentSources,@bytesPerSecond,@resumedBytes,@hit,@viaEgress,@originBytes,@sizeBytes,@failureReason,@attempt,@createdAt,@updatedAt,@expiresAt)
      ON CONFLICT(task_id) DO UPDATE SET node_id=excluded.node_id,url=excluded.url,host=excluded.host,digest=excluded.digest,
      status=excluded.status,bytes_received=excluded.bytes_received,total_bytes=excluded.total_bytes,parts_done=excluded.parts_done,
      parts_total=excluded.parts_total,segmented=excluded.segmented,segment_count=excluded.segment_count,segment_sources=excluded.segment_sources,
      bytes_per_second=excluded.bytes_per_second,resumed_bytes=excluded.resumed_bytes,hit=excluded.hit,
      via_egress=excluded.via_egress,origin_bytes=excluded.origin_bytes,size_bytes=excluded.size_bytes,
      failure_reason=excluded.failure_reason,attempt=excluded.attempt,updated_at=excluded.updated_at,expires_at=excluded.expires_at`)
      .run({
        taskId: job.taskId, nodeId: job.nodeId, url: job.url, host: job.host, digest: job.digest, status: job.status,
        bytesReceived: job.bytesReceived, totalBytes: job.totalBytes, partsDone: job.partsDone, partsTotal: job.partsTotal,
        segmented: flag(job.segmented), segmentCount: job.segmentCount, segmentSources: job.segmentSources,
        bytesPerSecond: job.bytesPerSecond, resumedBytes: job.resumedBytes,
        hit: nullableFlag(job.hit), viaEgress: nullableFlag(job.viaEgress),
        originBytes: job.originBytes, sizeBytes: job.sizeBytes, failureReason: job.failureReason, attempt: job.attempt,
        createdAt: job.createdAt, updatedAt: job.updatedAt, expiresAt: job.expiresAt,
      });
  }

  listJobs(limit: number, nodeIds?: readonly string[]) {
    const where = nodeIds === undefined ? "" : ` WHERE ${inClause("node_id", nodeIds)}`;
    const values = nodeIds === undefined ? [limit] : [...nodeIds, limit];
    return (this.database.prepare(`SELECT * FROM download_jobs${where} ORDER BY created_at DESC,task_id DESC LIMIT ?`).all(...values) as JobRow[]).map(fromRow);
  }

  /** One job reports its parts once; a repeat report replaces the set instead of doubling the bytes. */
  saveSegments(jobId: string, segments: readonly DownloadSegmentRecord[]) {
    const insert = this.database.prepare("INSERT INTO download_segments(job_id,part_index,source_node_id,bytes,resumed) VALUES(?,?,?,?,?) ON CONFLICT(job_id,part_index) DO UPDATE SET source_node_id=excluded.source_node_id,bytes=excluded.bytes,resumed=excluded.resumed");
    this.database.transaction(() => {
      this.database.prepare("DELETE FROM download_segments WHERE job_id=?").run(jobId);
      for (const segment of segments) insert.run(jobId, segment.partIndex, segment.sourceNodeId, segment.bytes, flag(segment.resumed));
    })();
  }

  trafficSince(monthStart: string, nodeIds?: readonly string[]) {
    const scope = nodeIds === undefined ? null : new Set(nodeIds);
    const where = nodeIds === undefined ? "" : ` AND ${inClause("node_id", nodeIds)}`;
    const received = this.database.prepare(`SELECT node_id,
        SUM(CASE WHEN hit=1 THEN 0 ELSE COALESCE(size_bytes,bytes_received) END) AS received, SUM(COALESCE(origin_bytes,0)) AS origin
      FROM download_jobs WHERE created_at>=?${where} GROUP BY node_id`).all(monthStart, ...(nodeIds ?? [])) as Array<{ node_id: string; received: number; origin: number }>;
    const servedWhere = nodeIds === undefined ? "" : ` AND ${inClause("download_segments.source_node_id", nodeIds)}`;
    const served = this.database.prepare(`SELECT download_segments.source_node_id AS node_id, SUM(download_segments.bytes) AS served
      FROM download_segments JOIN download_jobs ON download_jobs.task_id=download_segments.job_id
      WHERE download_jobs.created_at>=?${servedWhere} GROUP BY download_segments.source_node_id`).all(monthStart, ...(nodeIds ?? [])) as Array<{ node_id: string; served: number }>;
    const servedByNode = new Map(served.map((row) => [row.node_id, row.served]));
    const totals = new Map<string, NodeTrafficRecord>();
    for (const row of received) totals.set(row.node_id, { nodeId: row.node_id, receivedBytes: row.received, originBytes: row.origin, servedBytes: servedByNode.get(row.node_id) ?? 0 });
    for (const row of served) if (!totals.has(row.node_id) && (scope === null || scope.has(row.node_id))) totals.set(row.node_id, { nodeId: row.node_id, receivedBytes: 0, originBytes: 0, servedBytes: row.served });
    return [...totals.values()].sort((left, right) => left.nodeId.localeCompare(right.nodeId));
  }

  saveMeshPeers(nodeId: string, revision: number, peerNodeIds: readonly string[], createdAt: string) {
    const insert = this.database.prepare("INSERT INTO mesh_peers(node_id,peer_node_id,revision,created_at) VALUES(?,?,?,?) ON CONFLICT(node_id,peer_node_id) DO UPDATE SET revision=excluded.revision,created_at=excluded.created_at");
    this.database.transaction(() => {
      this.database.prepare("DELETE FROM mesh_peers WHERE node_id=?").run(nodeId);
      for (const peerNodeId of new Set(peerNodeIds)) insert.run(nodeId, peerNodeId, revision, createdAt);
    })();
  }

  meshPeerCounts(nodeIds?: readonly string[]) {
    const where = nodeIds === undefined ? "" : ` WHERE ${inClause("node_id", nodeIds)}`;
    return (this.database.prepare(`SELECT node_id,revision,COUNT(*) AS peer_count FROM mesh_peers${where} GROUP BY node_id,revision`)
      .all(...(nodeIds ?? [])) as Array<{ node_id: string; revision: number; peer_count: number }>)
      .map((row) => ({ nodeId: row.node_id, revision: row.revision, peerCount: row.peer_count }))
      .sort((left, right) => left.nodeId.localeCompare(right.nodeId));
  }

  pruneJobs(cutoff: string) {
    this.database.prepare("DELETE FROM download_jobs WHERE created_at<?").run(cutoff);
  }
}

export const downloadTrafficTotal = (record: NodeTrafficRecord) => record.receivedBytes + record.servedBytes;
