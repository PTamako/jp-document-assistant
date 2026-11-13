-- 0023: document-assistant member approval intent, NOT a target write.
-- Stage D/E Draft. UNEXECUTED in production; depends on 0020-0022.
-- Original documents/candidates/integration links and R2 objects are untouched.
-- HomeFlow stores only the hash; private, validated target payload stays here.
CREATE TABLE IF NOT EXISTS document_member_sync_intents (
 candidate_id TEXT PRIMARY KEY NOT NULL REFERENCES action_candidates(id) ON DELETE RESTRICT,
 document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE RESTRICT,
 local_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 homeflow_user_id TEXT NOT NULL REFERENCES homeflow_identity_links(homeflow_user_id) ON DELETE RESTRICT,
 homeflow_household_id TEXT NOT NULL,
 target_app TEXT NOT NULL CHECK(target_app IN('kakebo','homeflow','it-study-platform')),
 candidate_kind TEXT NOT NULL CHECK(candidate_kind IN('finance','homeflow_task','vocabulary','sentence')),
 document_version INTEGER NOT NULL CHECK(document_version>=1),
 candidate_updated_at TEXT NOT NULL,
 payload_sha256 TEXT NOT NULL CHECK(length(payload_sha256)=64),
 payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
 status TEXT NOT NULL DEFAULT 'prepared' CHECK(status IN('prepared','submitted')),
 approval_id TEXT UNIQUE,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 CHECK((status='prepared' AND approval_id IS NULL) OR
       (status='submitted' AND approval_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_document_member_sync_actor
 ON document_member_sync_intents(local_user_id,created_at DESC);
CREATE TRIGGER IF NOT EXISTS trg_document_member_sync_identity_immutable
 BEFORE UPDATE OF candidate_id,document_id,local_user_id,homeflow_user_id,
 homeflow_household_id,target_app,candidate_kind,document_version,
 candidate_updated_at,payload_sha256,payload_json,created_at
 ON document_member_sync_intents
 BEGIN SELECT RAISE(ABORT,'DOCUMENT_APPROVAL_INTENT_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS trg_document_member_sync_submitted_final
 BEFORE UPDATE ON document_member_sync_intents
 WHEN OLD.status='submitted' AND (
  NEW.status!='submitted' OR NEW.approval_id IS NOT OLD.approval_id)
 BEGIN SELECT RAISE(ABORT,'DOCUMENT_APPROVAL_SUBMISSION_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS trg_document_member_sync_no_delete
 BEFORE DELETE ON document_member_sync_intents
 BEGIN SELECT RAISE(ABORT,'DOCUMENT_APPROVAL_INTENT_NO_DELETE'); END;
