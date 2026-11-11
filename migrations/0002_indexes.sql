-- Additive D1 indexes: keep only fields actually needed by bounded UI queries.
PRAGMA foreign_keys = ON;
CREATE INDEX IF NOT EXISTS idx_users_household ON users(household_id,status);
CREATE INDEX IF NOT EXISTS idx_sessions_user_expire ON sessions(user_id,expires_at);
CREATE INDEX IF NOT EXISTS idx_documents_private ON documents(owner_id,lifecycle,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_documents_shared ON documents(household_id,visibility,lifecycle,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_documents_category ON documents(owner_id,category,lifecycle,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_documents_trash ON documents(owner_id,trashed_at DESC) WHERE lifecycle='trashed';
CREATE INDEX IF NOT EXISTS idx_objects_owner_state ON storage_objects(owner_id,state);
CREATE INDEX IF NOT EXISTS idx_attachments_document ON attachments(document_id,state,sort_order);
CREATE INDEX IF NOT EXISTS idx_attachments_object ON attachments(object_id,state);
CREATE UNIQUE INDEX IF NOT EXISTS ux_source_version ON document_sources(document_id,source_type,external_ref_hmac,source_version) WHERE external_ref_hmac IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sources_reference ON document_sources(source_type,external_ref_hmac,source_version);
CREATE INDEX IF NOT EXISTS idx_fields_document ON document_fields(document_id,review_state,field_key);
CREATE INDEX IF NOT EXISTS idx_events_owner_reference ON event_groups(owner_id,event_type,event_ref_hmac);
CREATE INDEX IF NOT EXISTS idx_candidates_document ON action_candidates(document_id,candidate_kind,state);
CREATE INDEX IF NOT EXISTS idx_integrations_state ON integration_links(target,state,updated_at);
CREATE INDEX IF NOT EXISTS idx_deletion_jobs_state ON deletion_jobs(state,updated_at);
CREATE INDEX IF NOT EXISTS idx_audit_actor_time ON audit_events(actor_user_id,created_at DESC);
-- FTS5 omitted intentionally until proven available AND safe on actual D1 and private scope.
