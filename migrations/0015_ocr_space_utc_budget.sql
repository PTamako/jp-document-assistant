-- Keep third-party OCR.space Engine 3 requests separate from Workers AI OCR.
-- One existing private document assistant D1; no Cron, new Worker or R2 resource.
-- Free OCR.space Engine 3 has 1,000 conversions per month; 20 per UTC day
-- caps application traffic below that even across a 31-day month.
CREATE TABLE IF NOT EXISTS ocr_space_utc_daily (
  day_utc TEXT PRIMARY KEY CHECK(length(day_utc)=10),
  calls INTEGER NOT NULL DEFAULT 0 CHECK(calls>=0)
);
