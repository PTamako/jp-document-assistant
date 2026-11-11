-- OCR suggestions are private, unverified and tied to the exact R2 object.
-- They disappear when the last R2 object record is permanently deleted.
-- Never run against HomeFlow, kakebo or it-study-platform D1.
CREATE TABLE IF NOT EXISTS ocr_attempts (
 id TEXT PRIMARY KEY,
 owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 object_id TEXT NOT NULL REFERENCES storage_objects(id) ON DELETE CASCADE,
 model_id TEXT NOT NULL,
 prompt_version TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('pending','success','empty','failed')),
 candidate_text_ja TEXT,
 input_tokens INTEGER,
 output_tokens INTEGER,
 neurons_estimated REAL,
 provider_shape TEXT,
 attempt_count INTEGER NOT NULL DEFAULT 1,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 UNIQUE(owner_id,object_id,model_id,prompt_version),
 CHECK((state='success' AND candidate_text_ja IS NOT NULL)
    OR (state!='success' AND candidate_text_ja IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_ocr_owner_object ON ocr_attempts(owner_id,object_id,state);
