-- Japanese full-text translation: same production D1, no new databases.
-- Cached machine translation is private document-derived text; restrict access
-- through the existing document visibility/lifecycle checks in the Worker.
CREATE TABLE IF NOT EXISTS document_translations (
  document_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  source_sha TEXT NOT NULL CHECK(length(source_sha)=64),
  translation_zh TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'zhixue_gas' CHECK(provider='zhixue_gas'),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS document_translation_daily_budget (
  japan_day TEXT PRIMARY KEY,
  calls INTEGER NOT NULL DEFAULT 0 CHECK(calls>=0 AND calls<=80)
);
