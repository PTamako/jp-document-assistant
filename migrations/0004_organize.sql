-- v0.11 incremental D1 extension: metadata-only organization, no new database.
ALTER TABLE documents ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0 CHECK(favorite IN (0,1));
ALTER TABLE documents ADD COLUMN tags_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(tags_json));
CREATE INDEX IF NOT EXISTS idx_documents_user_organization ON documents(owner_id,lifecycle,archived_at,favorite,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_attachments_state ON attachments(document_id,state,sort_order);
