-- Only for new document-assistant D1. Stores a digest, not PII.
ALTER TABLE integration_links ADD COLUMN request_fingerprint TEXT
  CHECK(request_fingerprint IS NULL OR (length(request_fingerprint)=64
    AND request_fingerprint NOT GLOB '*[^0-9a-f]*'));
