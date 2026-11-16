-- 0026: private study document execution reservation and immutable target receipt.
-- Draft ONLY. Never run this on production without separately authorized F stage.
-- Original source document and candidate remain the immutable reference.
CREATE TABLE IF NOT EXISTS document_study_execution_reservations (
 candidate_id TEXT PRIMARY KEY NOT NULL REFERENCES action_candidates(id) ON DELETE RESTRICT,
 approval_id TEXT UNIQUE NOT NULL,
 document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE RESTRICT,
 requester_user_id TEXT NOT NULL,
 household_id TEXT NOT NULL,
 payload_sha256 TEXT NOT NULL CHECK(length(payload_sha256)=64),
 nonce_sha256 TEXT NOT NULL CHECK(length(nonce_sha256)=64),
 candidate_kind TEXT NOT NULL CHECK(candidate_kind IN('vocabulary','sentence')),
 status TEXT NOT NULL CHECK(status IN('executing','applied')),
 target_remote_id TEXT,
 approver_user_id TEXT,
 applied_at INTEGER,
 reserved_at INTEGER NOT NULL,
 CHECK((status='executing' AND target_remote_id IS NULL AND approver_user_id IS NULL AND applied_at IS NULL) OR
       (status='applied' AND length(target_remote_id)>0 AND approver_user_id IS NOT NULL AND applied_at>0))
);
CREATE INDEX IF NOT EXISTS idx_document_study_reservation_request
 ON document_study_execution_reservations(approval_id,status);
CREATE TRIGGER IF NOT EXISTS trg_doc_study_identity_immutable
 BEFORE UPDATE OF candidate_id,approval_id,document_id,requester_user_id,household_id,
 payload_sha256,candidate_kind,reserved_at ON document_study_execution_reservations
 BEGIN SELECT RAISE(ABORT,'DOC_STUDY_RESERVATION_IDENTITY_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS trg_doc_study_receipt_immutable
 BEFORE UPDATE ON document_study_execution_reservations WHEN OLD.status='applied'
 BEGIN SELECT RAISE(ABORT,'DOC_STUDY_RECEIPT_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS trg_doc_study_no_delete
 BEFORE DELETE ON document_study_execution_reservations
 BEGIN SELECT RAISE(ABORT,'DOC_STUDY_RESERVATION_NO_DELETE'); END;
CREATE TRIGGER IF NOT EXISTS trg_doc_study_document_lock
 BEFORE UPDATE OF version,lifecycle,visibility,owner_id,household_id ON documents
 WHEN EXISTS(SELECT 1 FROM document_study_execution_reservations r
   WHERE r.document_id=OLD.id AND r.status='executing')
 BEGIN SELECT RAISE(ABORT,'DOC_STUDY_SOURCE_EXECUTING'); END;
CREATE TRIGGER IF NOT EXISTS trg_doc_study_document_delete
 BEFORE DELETE ON documents
 WHEN EXISTS(SELECT 1 FROM document_study_execution_reservations r
   WHERE r.document_id=OLD.id AND r.status='executing')
 BEGIN SELECT RAISE(ABORT,'DOC_STUDY_SOURCE_EXECUTING'); END;
CREATE TRIGGER IF NOT EXISTS trg_doc_study_candidate_lock
 BEFORE UPDATE OF updated_at,payload_json,state ON action_candidates
 WHEN EXISTS(SELECT 1 FROM document_study_execution_reservations r
   WHERE r.candidate_id=OLD.id AND r.status='executing')
 BEGIN SELECT RAISE(ABORT,'DOC_STUDY_SOURCE_EXECUTING'); END;
CREATE TRIGGER IF NOT EXISTS trg_doc_study_candidate_delete
 BEFORE DELETE ON action_candidates
 WHEN EXISTS(SELECT 1 FROM document_study_execution_reservations r
   WHERE r.candidate_id=OLD.id AND r.status='executing')
 BEGIN SELECT RAISE(ABORT,'DOC_STUDY_SOURCE_EXECUTING'); END;
