-- Each document chooses its own AI engine. Do not create a global/user preference.
-- No AI request is launched by this migration; it only persists explicit choice.
ALTER TABLE documents ADD COLUMN ai_provider TEXT NOT NULL DEFAULT 'none'
  CHECK(ai_provider IN ('none','cloudflare','gemini'));
ALTER TABLE documents ADD COLUMN ai_consent_at TEXT;
