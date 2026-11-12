-- One optional Google Gmail OAuth grant per local app user. All long-lived
-- refresh tokens are encrypted with Cloudflare-only AES-GCM key, scoped by
-- user ID as additional authenticated data. No mail body or access token is stored.
-- This migration changes only the existing jp-document-assistant D1 database.
CREATE TABLE IF NOT EXISTS google_oauth_grants (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  service TEXT NOT NULL CHECK (service IN ('gmail')),
  google_email TEXT NOT NULL,
  scope TEXT NOT NULL,
  refresh_cipher TEXT NOT NULL,
  refresh_iv TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('connected','reauth_required')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id,service)
);
