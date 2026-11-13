-- 0020: Safe, additive HomeFlow subject -> legacy document-assistant user link.
-- Production application is BLOCKED until four-app Phase A durable D1/R2 backups
-- and secure HomeFlow owner proof have been verified. No existing user/document/
-- Google OAuth grant or R2 object is updated by this migration.
--
-- HomeFlow is the sole subject/household/role authority. The local users.id is
-- deliberately retained because documents, grants, and audit records refer to it.
-- DO NOT seed a guessed owner UUID, infer identity from nickname/email or
-- copy admin tokens. Create links only after a server-validated HomeFlow OAuth
-- code exchange and additional linking checks.
CREATE TABLE IF NOT EXISTS homeflow_identity_links (
  homeflow_user_id TEXT PRIMARY KEY NOT NULL,
  homeflow_household_id TEXT NOT NULL,
  local_user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE RESTRICT,
  state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','revoked')),
  verified_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_at TEXT,
  CHECK(length(homeflow_user_id)>0 AND length(homeflow_household_id)>0),
  CHECK((state='active' AND revoked_at IS NULL)
    OR (state='revoked' AND revoked_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_homeflow_identity_links_household_state
  ON homeflow_identity_links(homeflow_household_id,state);

-- Relinking a local owner to a different HomeFlow subject, or a HomeFlow
-- subject to a different legacy local account, is NOT an account-switch
-- operation. It requires a separately reviewed recovery procedure.
CREATE TRIGGER IF NOT EXISTS trg_homeflow_identity_link_immutable
BEFORE UPDATE OF homeflow_user_id,homeflow_household_id,local_user_id
ON homeflow_identity_links
WHEN NEW.homeflow_user_id!=OLD.homeflow_user_id
  OR NEW.homeflow_household_id!=OLD.homeflow_household_id
  OR NEW.local_user_id!=OLD.local_user_id
BEGIN
  SELECT RAISE(ABORT,'HOMEFLOW_IDENTITY_LINK_IMMUTABLE');
END;
