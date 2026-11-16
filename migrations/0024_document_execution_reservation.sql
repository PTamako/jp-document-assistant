-- 0024 Draft: durable source execution reservation and exact target receipt.
-- UNEXECUTED in production. An uncertain remote write holds its source
-- locked until the same approval is reconciled; never assume timeout = fail.
CREATE TABLE IF NOT EXISTS document_member_execution_reservations (
 candidate_id TEXT PRIMARY KEY REFERENCES document_member_sync_intents(candidate_id) ON DELETE RESTRICT,
 approval_id TEXT NOT NULL UNIQUE,
 document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE RESTRICT,
 requester_user_id TEXT NOT NULL,
 household_id TEXT NOT NULL,
 payload_sha256 TEXT NOT NULL CHECK(length(payload_sha256)=64),
 status TEXT NOT NULL CHECK(status IN('executing','applied')),
 target_entry_id INTEGER,
 approver_user_id TEXT,
 applied_at INTEGER,
 reserved_at INTEGER NOT NULL,
 CHECK((status='executing' AND target_entry_id IS NULL AND applied_at IS NULL)
 OR (status='applied' AND target_entry_id>0 AND applied_at>0 AND approver_user_id IS NOT NULL))
);
CREATE TRIGGER IF NOT EXISTS trg_doc_exec_identity_immutable
 BEFORE UPDATE OF candidate_id,approval_id,document_id,requester_user_id,
 household_id,payload_sha256,reserved_at ON document_member_execution_reservations
 BEGIN SELECT RAISE(ABORT,'DOCUMENT_EXECUTION_IDENTITY_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS trg_doc_exec_receipt_immutable
 BEFORE UPDATE ON document_member_execution_reservations WHEN OLD.status='applied'
 BEGIN SELECT RAISE(ABORT,'DOCUMENT_EXECUTION_RECEIPT_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS trg_doc_exec_no_delete
 BEFORE DELETE ON document_member_execution_reservations
 BEGIN SELECT RAISE(ABORT,'DOCUMENT_EXECUTION_RESERVATION_NO_DELETE'); END;
CREATE TRIGGER IF NOT EXISTS trg_doc_exec_lock_document
 BEFORE UPDATE OF version,lifecycle,visibility,owner_id,household_id ON documents
 WHEN EXISTS(SELECT 1 FROM document_member_execution_reservations r
 WHERE r.document_id=OLD.id AND r.status='executing')
 BEGIN SELECT RAISE(ABORT,'DOCUMENT_EXECUTION_IN_FLIGHT'); END;
CREATE TRIGGER IF NOT EXISTS trg_doc_exec_lock_delete_document
 BEFORE DELETE ON documents
 WHEN EXISTS(SELECT 1 FROM document_member_execution_reservations r
 WHERE r.document_id=OLD.id AND r.status='executing')
 BEGIN SELECT RAISE(ABORT,'DOCUMENT_EXECUTION_IN_FLIGHT'); END;
CREATE TRIGGER IF NOT EXISTS trg_doc_exec_lock_candidate
 BEFORE UPDATE OF updated_at,payload_json,state ON action_candidates
 WHEN EXISTS(SELECT 1 FROM document_member_execution_reservations r
 WHERE r.candidate_id=OLD.id AND r.status='executing')
 BEGIN SELECT RAISE(ABORT,'DOCUMENT_EXECUTION_IN_FLIGHT'); END;
CREATE TRIGGER IF NOT EXISTS trg_doc_exec_lock_delete_candidate
 BEFORE DELETE ON action_candidates
 WHEN EXISTS(SELECT 1 FROM document_member_execution_reservations r
 WHERE r.candidate_id=OLD.id AND r.status='executing')
 BEGIN SELECT RAISE(ABORT,'DOCUMENT_EXECUTION_IN_FLIGHT'); END;
