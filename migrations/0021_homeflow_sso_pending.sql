-- 0021: HomeFlow SSO short-lived authorization transaction.
-- UNEXECUTED. Apply only after separately verified durable backups and owner
-- account proof. Neither original users nor documents are rewritten.
CREATE TABLE IF NOT EXISTS homeflow_oauth_pending (
  state_hash TEXT PRIMARY KEY NOT NULL,
  verifier_cipher TEXT NOT NULL,
  verifier_iv TEXT NOT NULL,
  nonce TEXT NOT NULL,
  origin TEXT NOT NULL,
  local_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  local_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  -- Proof stays in the originating PWA; never placed in OAuth redirects.
  resume_secret_hash TEXT NOT NULL,
  -- OAuth callback parks only an AES-GCM sealed code. No session issued in Safari.
  code_cipher TEXT,
  code_iv TEXT,
  callback_received_at TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','processing','consumed','failed')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_homeflow_oauth_pending_expiry
  ON homeflow_oauth_pending(expires_at);
CREATE INDEX IF NOT EXISTS idx_homeflow_oauth_pending_local_user
  ON homeflow_oauth_pending(local_user_id,status);
