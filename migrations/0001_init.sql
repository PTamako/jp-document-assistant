-- 日本生活文书助手 / D1 SQLite first-production migration
-- DO NOT run on HomeFlow / kakebo / it-study-platform D1 databases.
-- No Preview database, Worker, or R2 bucket is created by this file.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS households (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '家庭',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE RESTRICT,
  email_norm TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL CHECK(role IN ('owner','member')),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled','left')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (id, household_id)
);

CREATE TRIGGER IF NOT EXISTS trg_household_two_users
BEFORE INSERT ON users
WHEN (SELECT COUNT(*) FROM users WHERE household_id=NEW.household_id AND status!='left') >= 2
BEGIN SELECT RAISE(ABORT, 'HOUSEHOLD_FULL'); END;

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  secret_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS household_invites (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  inviter_user_id TEXT NOT NULL REFERENCES users(id),
  invitee_email_norm TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  accepted_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS external_connections (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK(provider IN ('google_drive','gmail','kakebo','homeflow','zhixue')),
  provider_subject_hash TEXT NOT NULL,
  scopes_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(scopes_json)),
  credential_ciphertext TEXT, -- encrypted only; key lives in Worker Secret, never in D1
  status TEXT NOT NULL CHECK(status IN ('connected','expired','revoked','blocked')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(user_id, provider, provider_subject_hash)
);

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE RESTRICT,
  visibility TEXT NOT NULL DEFAULT 'private' CHECK(visibility IN ('private','shared')),
  category TEXT NOT NULL DEFAULT 'other',
  subtype TEXT,
  title TEXT NOT NULL DEFAULT '',
  summary_zh TEXT,
  explanation_zh TEXT,
  extracted_text_ja TEXT, -- sensitive; never returned in list/search snippets
  import_mode TEXT NOT NULL DEFAULT 'summary' CHECK(import_mode IN ('analyze_only','summary','original')),
  analysis_status TEXT NOT NULL DEFAULT 'draft' CHECK(analysis_status IN ('draft','processing','needs_review','ready','failed')),
  lifecycle TEXT NOT NULL DEFAULT 'active' CHECK(lifecycle IN ('active','trashed','deletion_pending')),
  archived_at TEXT,
  trashed_at TEXT,
  trashed_by TEXT REFERENCES users(id),
  deletion_started_at TEXT,
  content_sha256 TEXT,
  extraction_version TEXT,
  confirmed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
  FOREIGN KEY(owner_id,household_id) REFERENCES users(id,household_id),
  CHECK((lifecycle='trashed' AND trashed_at IS NOT NULL) OR lifecycle!='trashed')
);

CREATE TABLE IF NOT EXISTS storage_objects (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  bucket TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  sha256 TEXT NOT NULL,
  bytes INTEGER NOT NULL CHECK(bytes >= 0),
  mime TEXT NOT NULL,
  quality_profile TEXT,
  state TEXT NOT NULL DEFAULT 'uploading' CHECK(state IN ('uploading','ready','deletion_pending','delete_failed','deleted')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(owner_id,sha256,mime,quality_profile)
);

CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE RESTRICT,
  object_id TEXT REFERENCES storage_objects(id) ON DELETE RESTRICT,
  file_label TEXT NOT NULL DEFAULT '',
  page_no INTEGER,
  sort_order INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','trashed','deletion_pending')),
  trashed_at TEXT,
  sha256 TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK(state!='trashed' OR trashed_at IS NOT NULL)
);
CREATE TRIGGER IF NOT EXISTS trg_attachment_owner_insert
BEFORE INSERT ON attachments WHEN NEW.object_id IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM documents d JOIN storage_objects o ON d.owner_id=o.owner_id
     WHERE d.id=NEW.document_id AND o.id=NEW.object_id AND o.state='ready'
  ) THEN RAISE(ABORT, 'OBJECT_OWNER_OR_STATE_INVALID') END;
END;
CREATE TRIGGER IF NOT EXISTS trg_attachment_owner_update
BEFORE UPDATE OF object_id,document_id ON attachments WHEN NEW.object_id IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM documents d JOIN storage_objects o ON d.owner_id=o.owner_id
     WHERE d.id=NEW.document_id AND o.id=NEW.object_id AND o.state='ready'
  ) THEN RAISE(ABORT, 'OBJECT_OWNER_OR_STATE_INVALID') END;
END;

CREATE TABLE IF NOT EXISTS document_sources (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL CHECK(source_type IN ('mail_forward','gmail','image','text','google_drive','local_file')),
  provider TEXT,
  external_ref_hmac TEXT,
  source_version TEXT,
  content_sha256 TEXT,
  received_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS document_fields (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  attachment_id TEXT REFERENCES attachments(id) ON DELETE SET NULL,
  field_key TEXT NOT NULL,
  raw_value TEXT,
  normalized_value TEXT,
  value_type TEXT NOT NULL DEFAULT 'text' CHECK(value_type IN ('text','money','date','datetime','boolean','json')),
  original_currency TEXT,
  source_quote TEXT,
  source_page INTEGER,
  source_location_json TEXT CHECK(source_location_json IS NULL OR json_valid(source_location_json)),
  review_state TEXT NOT NULL DEFAULT 'unreviewed' CHECK(review_state IN ('unreviewed','confirmed','corrected','rejected')),
  reviewed_by TEXT REFERENCES users(id),
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS event_groups (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id),
  event_type TEXT NOT NULL CHECK(event_type IN ('salary','payment','card_authorization','card_settlement','order','trip','hotel','refund','other')),
  event_ref_hmac TEXT,
  state TEXT NOT NULL DEFAULT 'candidate',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS document_events (
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL REFERENCES event_groups(id) ON DELETE CASCADE,
  PRIMARY KEY(document_id,event_id)
);

CREATE TABLE IF NOT EXISTS action_candidates (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  candidate_kind TEXT NOT NULL CHECK(candidate_kind IN ('finance','homeflow_task','vocabulary','sentence')),
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)), -- validated by API schemas before write
  source_field_id TEXT REFERENCES document_fields(id) ON DELETE SET NULL,
  state TEXT NOT NULL DEFAULT 'suggested' CHECK(state IN ('suggested','confirmed','skipped')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS integration_links (
  id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL REFERENCES action_candidates(id) ON DELETE RESTRICT,
  target TEXT NOT NULL CHECK(target IN ('kakebo','homeflow','zhixue')),
  idempotency_key TEXT NOT NULL UNIQUE,
  remote_id TEXT,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sending','synced','linked_existing','failed','skipped')),
  last_error_code TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
  synced_at TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE(candidate_id,target)
);

CREATE TABLE IF NOT EXISTS deletion_jobs (
  id TEXT PRIMARY KEY,
  object_id TEXT NOT NULL UNIQUE REFERENCES storage_objects(id) ON DELETE RESTRICT,
  requested_by TEXT NOT NULL REFERENCES users(id),
  state TEXT NOT NULL CHECK(state IN ('pending','running','failed','done')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS deletion_tombstones (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id),
  request_key TEXT NOT NULL UNIQUE,
  target_type TEXT NOT NULL CHECK(target_type IN ('document','attachment','object')),
  target_id TEXT NOT NULL,
  deleted_at TEXT NOT NULL
); -- no content or original R2 access credentials

CREATE TABLE IF NOT EXISTS backup_runs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  scope TEXT NOT NULL CHECK(scope IN ('selection','month','year','all')),
  includes_originals INTEGER NOT NULL DEFAULT 0 CHECK(includes_originals IN (0,1)),
  status TEXT NOT NULL CHECK(status IN ('planned','exported','failed')),
  item_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
); -- backup bytes are NOT stored in D1 or R2 by default

CREATE TABLE IF NOT EXISTS usage_daily (
  user_id TEXT NOT NULL REFERENCES users(id),
  local_day TEXT NOT NULL, -- Asia/Tokyo YYYY-MM-DD; Workers AI quota resets UTC
  ai_calls INTEGER NOT NULL DEFAULT 0 CHECK(ai_calls >= 0),
  ai_reserved INTEGER NOT NULL DEFAULT 0 CHECK(ai_reserved >= 0),
  imported_files INTEGER NOT NULL DEFAULT 0 CHECK(imported_files >= 0),
  PRIMARY KEY(user_id,local_day)
);
CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  created_at TEXT NOT NULL
); -- no raw OCR, amounts, file names or personal identifiers

CREATE TRIGGER IF NOT EXISTS trg_household_two_users_on_update
BEFORE UPDATE OF status,household_id ON users
WHEN NEW.status!='left' AND
  (SELECT COUNT(*) FROM users WHERE household_id=NEW.household_id AND status!='left' AND id!=OLD.id) >= 2
BEGIN SELECT RAISE(ABORT, 'HOUSEHOLD_FULL'); END;

CREATE TRIGGER IF NOT EXISTS trg_object_owner_immutable
BEFORE UPDATE OF owner_id,object_key ON storage_objects
WHEN NEW.owner_id!=OLD.owner_id OR NEW.object_key!=OLD.object_key
BEGIN SELECT RAISE(ABORT, 'OBJECT_IDENTITY_IMMUTABLE'); END;
