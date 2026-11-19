-- Prevent simultaneous Google translation requests for one document.
-- Lock is scoped to the source document, not to a browser/isolate.
-- No private text or tokens are persisted in this table.
CREATE TABLE IF NOT EXISTS document_translation_jobs (
  document_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  source_sha TEXT NOT NULL CHECK(length(source_sha)=64),
  claim_id TEXT NOT NULL CHECK(length(claim_id)=32),
  state TEXT NOT NULL CHECK(state IN ('running','done','failed')),
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_document_translation_jobs_state
  ON document_translation_jobs(state,updated_at);
