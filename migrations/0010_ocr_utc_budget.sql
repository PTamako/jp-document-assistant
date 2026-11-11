-- App-level UTC-day OCR reservation within ONE existing document assistant D1.
-- No separate Worker, R2 bucket, Cron, KV, queue or paid resource is introduced.
-- Cloudflare Workers AI Free quota resets 00:00 UTC across all apps; this
-- budget is only a local safeguard and MUST NOT be labeled account remaining.
CREATE TABLE IF NOT EXISTS ocr_app_utc_daily (
  day_utc TEXT PRIMARY KEY CHECK(length(day_utc)=10),
  calls INTEGER NOT NULL DEFAULT 0 CHECK(calls>=0),
  reserved INTEGER NOT NULL DEFAULT 0 CHECK(reserved>=0)
);
