-- ==========================================
-- 014: Removing staff accounts (Accounts tab "Remove")
--
--   * users.removed_at / removed_by: an Owner or Admin may REMOVE a Staff or Production account.
--     Removing = deactivated (cannot log in, signed out everywhere) + hidden from the everyday
--     Accounts list. The row is KEPT, so the person's name stays on every payment, status change,
--     expense and audit entry they made. "Show removed" lists them; Restore brings one back
--     (still deactivated, so the manager decides whether to reactivate it).
--     Owner and Admin accounts can never be removed.
--
-- No backfill: every existing account is simply not removed (NULL).
-- SAFE TO RUN MORE THAN ONCE (IF NOT EXISTS).
-- Applied automatically on server start-up, or with:  npm run migrate
-- ==========================================

ALTER TABLE users ADD COLUMN IF NOT EXISTS removed_at TIMESTAMP;
ALTER TABLE users ADD COLUMN IF NOT EXISTS removed_by VARCHAR(50);   -- user_id; no FK, like the trails
