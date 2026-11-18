-- Expand the Gemini local safety cap to the project's verified 500 RPD / 15 RPM.
-- Preserve existing per-model Pacific-day counters; no user documents or secrets touched.
-- Apply as one D1 migration/transaction before increasing the application constants.
CREATE TABLE gemini_api_daily_expanded (
 model_id TEXT NOT NULL,
 day_pt TEXT NOT NULL,
 calls INTEGER NOT NULL DEFAULT 0 CHECK(calls BETWEEN 0 AND 500),
 minute_utc TEXT NOT NULL,
 minute_calls INTEGER NOT NULL DEFAULT 0 CHECK(minute_calls BETWEEN 0 AND 15),
 PRIMARY KEY(model_id,day_pt)
);
INSERT INTO gemini_api_daily_expanded(model_id,day_pt,calls,minute_utc,minute_calls)
 SELECT model_id,day_pt,calls,minute_utc,minute_calls FROM gemini_api_daily;
DROP TABLE gemini_api_daily;
ALTER TABLE gemini_api_daily_expanded RENAME TO gemini_api_daily;
