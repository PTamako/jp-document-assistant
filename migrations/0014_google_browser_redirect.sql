-- Upgrade the single production D1 Google grants table for Drive and Gmail.
-- No change to HomeFlow, 家計簿, 知学, Workers, or R2.
CREATE TABLE google_oauth_grants_next (
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 service TEXT NOT NULL CHECK(service IN ('gmail','drive')),
 google_email TEXT NOT NULL,
 scope TEXT NOT NULL,
 refresh_cipher TEXT NOT NULL,
 refresh_iv TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('connected','reauth_required')),
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 PRIMARY KEY(user_id,service)
);
INSERT INTO google_oauth_grants_next(user_id,service,google_email,scope,refresh_cipher,refresh_iv,status,created_at,updated_at)
 SELECT user_id,service,google_email,scope,refresh_cipher,refresh_iv,status,created_at,updated_at
 FROM google_oauth_grants;
DROP TABLE google_oauth_grants;
ALTER TABLE google_oauth_grants_next RENAME TO google_oauth_grants;
CREATE TABLE google_oauth_pending (
 state_hash TEXT PRIMARY KEY,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 service TEXT NOT NULL CHECK(service IN ('gmail','drive')),
 pkce_verifier TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('pending','processing','done','failed')),
 expires_at TEXT NOT NULL,
 created_at TEXT NOT NULL
);
CREATE INDEX idx_google_oauth_pending_user ON google_oauth_pending(user_id,service);
