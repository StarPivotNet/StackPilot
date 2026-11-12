CREATE TABLE ssh_hosts (
  node_id TEXT PRIMARY KEY REFERENCES agent_nodes(node_id),
  payload TEXT NOT NULL,
  verification_id TEXT,
  helper_revoked_at TEXT
);
CREATE TABLE ssh_policies (
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL REFERENCES agent_nodes(node_id),
  user_id TEXT NOT NULL REFERENCES users(id),
  payload TEXT NOT NULL,
  UNIQUE(node_id,user_id)
);
CREATE TABLE ssh_credentials (
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL REFERENCES agent_nodes(node_id),
  user_id TEXT NOT NULL REFERENCES users(id),
  policy_id TEXT NOT NULL REFERENCES ssh_policies(id),
  digest TEXT NOT NULL UNIQUE,
  payload TEXT NOT NULL
);
CREATE INDEX ssh_credentials_owner ON ssh_credentials(user_id,node_id);
CREATE TABLE ssh_sessions (
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL REFERENCES agent_nodes(node_id),
  user_id TEXT NOT NULL REFERENCES users(id),
  credential_id TEXT NOT NULL UNIQUE REFERENCES ssh_credentials(id),
  connection_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  UNIQUE(node_id,connection_id)
);
CREATE TABLE ssh_takeover_plans (
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL REFERENCES agent_nodes(node_id),
  requested_by TEXT NOT NULL REFERENCES users(id),
  state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  payload TEXT NOT NULL
);
CREATE UNIQUE INDEX ssh_one_active_takeover ON ssh_takeover_plans(node_id)
  WHERE state IN ('prechecked','applying','awaiting-verification','rolling-back');
