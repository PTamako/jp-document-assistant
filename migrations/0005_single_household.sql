-- v0.11 hard boundary: this is one family's private application, not a tenant platform.
-- Additive migration; safe for a freshly initialized or existing single household DB.
-- A second concurrent bootstrap request cannot create a second household.
CREATE TRIGGER IF NOT EXISTS trg_one_household
BEFORE INSERT ON households
WHEN (SELECT COUNT(*) FROM households) >= 1
BEGIN
  SELECT RAISE(ABORT, 'SINGLE_HOUSEHOLD_ONLY');
END;
