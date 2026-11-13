-- Persistent AI jobs share the existing production D1 database.
-- No Queues, new Workers or Preview resources.
CREATE TABLE IF NOT EXISTS document_ai_jobs (
  document_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK(provider IN ('gemini','cloudflare')),
  source_sha TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('queued','running','retry_wait','done','failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0),
  next_attempt_at TEXT NOT NULL,
  started_at TEXT,
  updated_at TEXT NOT NULL,
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_document_ai_jobs_due ON document_ai_jobs(state,next_attempt_at);
