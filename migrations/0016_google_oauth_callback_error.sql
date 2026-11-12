-- Keep only a short allowlisted OAuth failure code, never provider payloads,
-- authorization codes, personal data, tokens, or client secrets.
-- Single production document-assistant D1 only; no extra resources.
ALTER TABLE google_oauth_pending ADD COLUMN error_code TEXT;
