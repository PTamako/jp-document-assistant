# D1 migrations (initial schema for a NEW standalone application)

Order: `0001_init.sql`, `0002_indexes.sql`, `0003_password_auth.sql`, `0004_organize.sql`, `0005_single_household.sql`, `0006_document_version.sql`, `0007_ocr_attempts.sql`, `0008_bridge_fingerprint.sql`, `0009_calendar_subscriptions.sql`, `0010_ocr_utc_budget.sql`, `0011_document_ai_provider.sql`. These are additive migrations, **not** migrations for the three existing apps. Execute locally in SQLite (or `wrangler d1 execute --local` only after creating a local database) before any production proposal. Do not run against HomeFlow, 家計簿 or 知学 databases, and do not create preview Cloudflare resources.

**Production safety:** The SQL is tested against local `sqlite3`, **not yet against real D1**. Do not auto-run on production; confirm a backup, current schema, and a production migration plan, and get approval. App-level logic must enforce exactly two users, permissions, imports, 2-phase R2 cleanup, idempotency, and transactional CAS updates. The SQLite trigger additionally blocks a third non-left account in the same household.

Important state machine: `documents.lifecycle=active|trashed|deletion_pending`. Soft delete changes D1 only. Permanent delete marks records inaccessible, checks whether each R2 `storage_objects` key has other valid references, calls `R2.delete(key)` only for last references, then removes private rows and records a content-free tombstone. R2 and D1 do **not** share an atomic transaction. A failed R2 operation must keep `deletion_jobs`/`storage_objects` state for safe retry; source files on Google Drive or Gmail must never be deleted by this app. Deletion of a lone attachment follows the same rule. Existing entries in 家計簿, HomeFlow, 知学 are unaffected by source deletion by default.

The `storage_objects` unique(owner_id, sha256, mime, quality_profile) key is for within-owner dedupe. The app must track unfinished uploads and not link to a non-`ready` object. If two documents share one original, the last-reference rule prevents accidental loss. Privacy scope is enforced in every query and service call, not only UI.

The initial schema deliberately has **no FTS virtual table** because D1 support and query budgets must be proved before enabling it. Bounded per-user searchable lists can rely on indices; avoid unbounded scans. Dates are UTC ISO-8601, except explicitly named `local_day` in JST. All money and currencies live in JSON candidates/confirmed fields with integer minor units and explicit ISO currency; do not infer FX rates.

`0006_document_version.sql` saves **source_document_date** and original evidence separately from **official_current_verified_at**. The latter stays NULL until an actual trusted-source verification workflow is implemented; imports and ZIP restores must never forge a verification timestamp. No separate Cloudflare resources are created.

`0007_ocr_attempts.sql`: per-user, per-R2-object experimental OCR suggestion cache. Only `success` rows contain candidate text. Any result remains unverified until the owner explicitly edits and saves it. The row is deleted with the last private `storage_objects` record by FK cascade; failed/empty OCR does not fabricate source text. No extra Worker, Cron, KV or R2 request is needed.

`0008_bridge_fingerprint.sql` locks the canonical first transmitted cross-App request and prevents sending a different body with the same idempotency key; concurrent senders are serialized using D1 CAS. Legacy uncertain writes without a stored digest fail closed. No production migration has been run.

`0009_calendar_subscriptions.sql` stores a revocable per-user SHA-256 secret token for calendar subscription. Raw token is only revealed once; shared documents are included only when explicitly marked shared, and event titles default to generic. No Cron, KV, Queue or R2 traffic is necessary.

`0010_ocr_utc_budget.sql`: per-app UTC-day counter shared by the two household users (default one model call/day). This does not read Cloudflare account-wide free Neurons. No preview resource is created, no production migration was executed.


`0011_document_ai_provider.sql`: stores the AI selection independently for every document, never as a global preference. Historic documents default to rules-only. Explicit Gemini consent timestamp is stored per document. This migration **does not initiate any AI inference or send files to Gemini**; live AI analysis still needs separate implementation and verification.
