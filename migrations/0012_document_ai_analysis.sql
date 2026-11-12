-- One analysis cache row per document; do not send private text to logs.
-- No separate Cloudflare database, Worker, R2 or Preview resource.
CREATE TABLE IF NOT EXISTS document_ai_analyses (
  document_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK(provider IN ('cloudflare','gemini')),
  source_sha TEXT NOT NULL,
  model_id TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','success','failed')),
  result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)),
  updated_at TEXT NOT NULL
);
-- This counter is only a local request ceiling, not proof of provider's
-- remaining free tier or Cloudflare account-wide invoice amount.
CREATE TABLE IF NOT EXISTS ai_analysis_daily (
  day_utc TEXT PRIMARY KEY CHECK(length(day_utc)=10),
  calls INTEGER NOT NULL DEFAULT 0 CHECK(calls>=0)
);
