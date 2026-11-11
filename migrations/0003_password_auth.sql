-- Local-first application authentication. NOT a migration for any existing app.
CREATE TABLE IF NOT EXISTS password_credentials (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  password_salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  iterations INTEGER NOT NULL CHECK(iterations >= 100000),
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS auth_throttle (
  identity_hash TEXT PRIMARY KEY,
  failures INTEGER NOT NULL DEFAULT 0,
  blocked_until TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auth_throttle_updated ON auth_throttle(updated_at);

-- Single household (user contract: private two-member family only).
CREATE TRIGGER IF NOT EXISTS trg_single_household
BEFORE INSERT ON households
WHEN (SELECT COUNT(*) FROM households) >= 1
BEGIN SELECT RAISE(ABORT, 'ONLY_ONE_HOUSEHOLD'); END;
