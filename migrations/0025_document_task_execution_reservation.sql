-- P0-2 (UNEXECUTED DRAFT): document-side task source reservation.
-- Enforces no source document/candidate mutation while target confirmation
-- is unknown; receipts are durable and immutable after actual HomeFlow apply.
CREATE TABLE IF NOT EXISTS document_task_execution_reservations (
 candidate_id TEXT PRIMARY KEY REFERENCES document_member_sync_intents(candidate_id) ON DELETE RESTRICT,
 approval_id TEXT NOT NULL UNIQUE,
 document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE RESTRICT,
 requester_user_id TEXT NOT NULL,
 household_id TEXT NOT NULL,
 payload_sha256 TEXT NOT NULL CHECK(length(payload_sha256)=64),
 operation_sha256 TEXT NOT NULL CHECK(length(operation_sha256)=64),
 status TEXT NOT NULL CHECK(status IN('executing','applied')),
 task_id TEXT UNIQUE,
 approver_user_id TEXT,
 applied_at INTEGER,
 reserved_at INTEGER NOT NULL,
 CHECK((status='executing' AND task_id IS NULL AND applied_at IS NULL AND approver_user_id IS NULL)
   OR (status='applied' AND length(task_id)=36 AND applied_at>0 AND approver_user_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_document_task_reservations_approval
 ON document_task_execution_reservations(approval_id,status);
CREATE TRIGGER IF NOT EXISTS trg_doc_task_reservation_identity_immutable
 BEFORE UPDATE OF candidate_id,approval_id,document_id,requester_user_id,
 household_id,payload_sha256,operation_sha256,reserved_at
 ON document_task_execution_reservations
 BEGIN SELECT RAISE(ABORT,'DOC_TASK_SOURCE_IDENTITY_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS trg_doc_task_reservation_applied_immutable
 BEFORE UPDATE ON document_task_execution_reservations WHEN OLD.status='applied'
 BEGIN SELECT RAISE(ABORT,'DOC_TASK_SOURCE_RECEIPT_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS trg_doc_task_reservation_no_delete
 BEFORE DELETE ON document_task_execution_reservations
 BEGIN SELECT RAISE(ABORT,'DOC_TASK_SOURCE_RESERVATION_NO_DELETE'); END;
CREATE TRIGGER IF NOT EXISTS trg_doc_task_reservation_lock_document
 BEFORE UPDATE OF version,lifecycle,visibility,owner_id,household_id ON documents
 WHEN EXISTS(SELECT 1 FROM document_task_execution_reservations r
   WHERE r.document_id=OLD.id AND r.status='executing')
 BEGIN SELECT RAISE(ABORT,'DOC_TASK_SOURCE_EXECUTING'); END;
CREATE TRIGGER IF NOT EXISTS trg_doc_task_reservation_lock_delete_document
 BEFORE DELETE ON documents
 WHEN EXISTS(SELECT 1 FROM document_task_execution_reservations r
   WHERE r.document_id=OLD.id AND r.status='executing')
 BEGIN SELECT RAISE(ABORT,'DOC_TASK_SOURCE_EXECUTING'); END;
CREATE TRIGGER IF NOT EXISTS trg_doc_task_reservation_lock_candidate
 BEFORE UPDATE OF updated_at,payload_json,state ON action_candidates
 WHEN EXISTS(SELECT 1 FROM document_task_execution_reservations r
   WHERE r.candidate_id=OLD.id AND r.status='executing')
 BEGIN SELECT RAISE(ABORT,'DOC_TASK_SOURCE_EXECUTING'); END;
CREATE TRIGGER IF NOT EXISTS trg_doc_task_reservation_lock_delete_candidate
 BEFORE DELETE ON action_candidates
 WHEN EXISTS(SELECT 1 FROM document_task_execution_reservations r
   WHERE r.candidate_id=OLD.id AND r.status='executing')
 BEGIN SELECT RAISE(ABORT,'DOC_TASK_SOURCE_EXECUTING'); END;
