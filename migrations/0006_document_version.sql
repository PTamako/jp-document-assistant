-- Separate source document date from authoritative current-version verification.
-- These columns are nullable, non-sensitive metadata of a PRIVATE document.
-- Never migrate a different app's D1; apply only to a new jp-document-assistant database.
ALTER TABLE documents ADD COLUMN source_document_date TEXT
  CHECK(source_document_date IS NULL OR
    (length(source_document_date)=10 AND
      source_document_date GLOB '[12][0-9][0-9][0-9]-[01][0-9]-[0-3][0-9]'));
ALTER TABLE documents ADD COLUMN source_date_quote TEXT;
-- Only a future official-source verification flow may write this field.
ALTER TABLE documents ADD COLUMN official_current_verified_at TEXT DEFAULT NULL;
