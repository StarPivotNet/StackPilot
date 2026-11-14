-- What the Controller actually handed each node at a revision. Node payloads only keep the current
-- revision per node, so a later membership change cannot reconstruct what an earlier broadcast said.
CREATE TABLE mesh_peers (
  node_id TEXT NOT NULL,
  peer_node_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(node_id, peer_node_id)
);
CREATE INDEX mesh_peers_revision ON mesh_peers(node_id, revision);

-- One row per `network.cache.fetch` task, so the panel and the monthly meter read an index instead
-- of decrypting every task payload. Byte figures are the Agent's own report or absent.
CREATE TABLE download_jobs (
  task_id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL,
  url TEXT NOT NULL,
  host TEXT NOT NULL,
  digest TEXT,
  status TEXT NOT NULL,
  bytes_received INTEGER NOT NULL DEFAULT 0,
  total_bytes INTEGER,
  parts_done INTEGER NOT NULL DEFAULT 0,
  parts_total INTEGER NOT NULL DEFAULT 0,
  segmented INTEGER NOT NULL DEFAULT 0,
  segment_count INTEGER NOT NULL DEFAULT 0,
  segment_sources INTEGER NOT NULL DEFAULT 0,
  bytes_per_second INTEGER,
  resumed_bytes INTEGER NOT NULL DEFAULT 0,
  hit INTEGER,
  via_egress INTEGER,
  origin_bytes INTEGER,
  size_bytes INTEGER,
  failure_reason TEXT,
  attempt INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX download_jobs_created ON download_jobs(created_at DESC);
CREATE INDEX download_jobs_node ON download_jobs(node_id, created_at DESC);

-- Which peer served which part, so traffic a node streams to its peers is attributable too.
CREATE TABLE download_segments (
  job_id TEXT NOT NULL REFERENCES download_jobs(task_id) ON DELETE CASCADE,
  part_index INTEGER NOT NULL,
  source_node_id TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  resumed INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(job_id, part_index)
);
CREATE INDEX download_segments_source ON download_segments(source_node_id);
