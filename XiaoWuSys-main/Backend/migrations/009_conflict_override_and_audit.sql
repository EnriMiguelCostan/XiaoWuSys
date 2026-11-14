-- ==========================================
-- 009: Owner override and the general audit trail (PB 5)
--
--   * order_profiles.last_edited_by / last_edited_role: the account (and its role at that
--     moment) that last changed the order. When two people change the same order, the higher
--     rank may replace the other's change (Owner > Admin > Production > Staff). Orders changed
--     before this migration have no value: an unknown editor ranks below everyone.
--   * audit_log: append-only record of decisions that replaced or discarded someone's work
--     (an online override, an offline change that won or lost by rank, a conflict settled by
--     hand). Later backlog items (discount overrides, voids) write here too.
--     details is JSON: the values before and after. Rows cannot be edited or deleted.
--     inventory_audit_log stays separate.
--
-- SAFE TO RUN MORE THAN ONCE (IF NOT EXISTS, CREATE OR REPLACE, DROP ... IF EXISTS).
-- Applied automatically on server start-up, or with:  npm run migrate
-- ==========================================

-- ---------- 1. Who last changed an order ----------
-- No foreign key on purpose: an offline edit is pushed with the editor's id, and an account
-- removed in the meantime must not block that sync.
ALTER TABLE order_profiles ADD COLUMN IF NOT EXISTS last_edited_by VARCHAR(50);
ALTER TABLE order_profiles ADD COLUMN IF NOT EXISTS last_edited_role VARCHAR(50);

-- ---------- 2. General audit trail ----------
CREATE TABLE IF NOT EXISTS audit_log (
    audit_id       VARCHAR(50) PRIMARY KEY,
    entity         VARCHAR(50) NOT NULL,          -- table the record lives in, e.g. 'order_profiles'
    entity_id      VARCHAR(50) NOT NULL,          -- no FK: the trail outlives the record
    action         VARCHAR(50) NOT NULL,          -- e.g. 'conflict_override'
    details        TEXT,                          -- JSON: before / after values
    performed_by   VARCHAR(50),
    performed_role VARCHAR(50),
    created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    sync_status    VARCHAR(50) DEFAULT 'synced' CHECK (sync_status IN ('synced', 'pending_insert', 'pending_update')),
    last_modified  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_audit_log_entity ON audit_log (entity, entity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_time ON audit_log (created_at DESC);

-- Shared by every append-only table (it named only inventory_audit_log in migration 004)
CREATE OR REPLACE FUNCTION forbid_audit_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$;
DROP TRIGGER IF EXISTS trg_audit_log_append_only ON audit_log;
CREATE TRIGGER trg_audit_log_append_only
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION forbid_audit_change();
