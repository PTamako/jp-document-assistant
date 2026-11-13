-- Stage B HomeFlow source-session liveness for app sessions (UNEXECUTED).
-- Strictly additive. Do not apply until all production D1/R2 backups have
-- been durably encrypted, verified and restored in an isolated environment.
-- A proof is tied to an existing local app session; deleting/revoking the
-- local session or source HomeFlow session ends access.
CREATE TABLE IF NOT EXISTS homeflow_session_proofs (
  session_id TEXT PRIMARY KEY NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  homeflow_user_id TEXT NOT NULL,
  state_hash TEXT NOT NULL,
  proof_cipher TEXT NOT NULL,
  proof_iv TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (homeflow_user_id) REFERENCES homeflow_identity_links(homeflow_user_id)
);
CREATE INDEX IF NOT EXISTS idx_homeflow_session_proofs_expiry
  ON homeflow_session_proofs(expires_at);
