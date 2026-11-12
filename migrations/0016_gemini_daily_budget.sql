-- Dedicated per-model, Pacific-day Gemini budget for both household users.
-- No API keys or document contents are stored. Fail closed if this table is unavailable.
CREATE TABLE IF NOT EXISTS gemini_api_daily (
 model_id TEXT NOT NULL,
 day_pt TEXT NOT NULL,
 calls INTEGER NOT NULL DEFAULT 0 CHECK(calls BETWEEN 0 AND 20),
 minute_utc TEXT NOT NULL,
 minute_calls INTEGER NOT NULL DEFAULT 0 CHECK(minute_calls BETWEEN 0 AND 5),
 PRIMARY KEY(model_id,day_pt)
);
