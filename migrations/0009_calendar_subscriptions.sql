-- Revocable per-person ICS subscription token. Never store raw token or use email/private credentials.
CREATE TABLE IF NOT EXISTS calendar_subscriptions (
 id TEXT PRIMARY KEY,
 user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
 token_hash TEXT NOT NULL UNIQUE,
 include_titles INTEGER NOT NULL DEFAULT 0 CHECK(include_titles IN (0,1)),
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 revoked_at TEXT
);
