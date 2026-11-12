CREATE TABLE ssh_helper_enrollments (
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL REFERENCES agent_nodes(node_id),
  token_digest TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  revoked_at TEXT
);
CREATE TABLE ssh_helper_credentials (
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL REFERENCES agent_nodes(node_id),
  public_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  report TEXT
);
CREATE UNIQUE INDEX ssh_helper_active_node ON ssh_helper_credentials(node_id) WHERE revoked_at IS NULL;
CREATE TABLE ssh_helper_nonces (
  credential_id TEXT NOT NULL REFERENCES ssh_helper_credentials(id),
  nonce TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY(credential_id,nonce)
);
