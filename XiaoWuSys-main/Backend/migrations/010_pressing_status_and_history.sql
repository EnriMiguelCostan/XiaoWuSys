-- ==========================================
-- 010: "Pressing" step, status history and live order updates (PB 14)
--
--   * 'Pressing' joins the production_status CHECK. It is optional:
--       Printing -> Pressing -> Completed   (apparel)
--       Printing -> Completed               (tarpaulins, stickers)
--   * order_status_history: one row per status change (and per approval), written in the same
--     transaction as the change. Append-only: rows cannot be edited or deleted.
--   * Every committed change to order_profiles sends a NOTIFY on 'orders_changed', so each
--     branch server can tell its screens (Socket.io "order_updated") without polling.
--     Payload: {"order_id", "op", "tracking_no", "production_status", "version"}
--
-- SAFE TO RUN MORE THAN ONCE (IF NOT EXISTS, CREATE OR REPLACE, DROP ... IF EXISTS).
-- Applied automatically on server start-up, or with:  npm run migrate
-- ==========================================

-- ---------- 1. Add 'Pressing' to the production_status CHECK ----------
-- Same approach as migration 005: every CHECK on order_profiles that mentions
-- production_status is dropped (a legacy database may carry one under another name), then the
-- new one is added NOT VALID so an unexpected old row can never block this migration, and
-- validated when every existing row passes.
DO $$
DECLARE
  c record;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'order_profiles'::regclass AND contype = 'c'
       AND pg_get_constraintdef(oid) ILIKE '%production_status%'
  LOOP
    EXECUTE format('ALTER TABLE order_profiles DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;
ALTER TABLE order_profiles
  ADD CONSTRAINT order_profiles_production_status_check
  CHECK (production_status IN ('Pending', 'Approved', 'Printing', 'Pressing', 'Completed', 'Delayed', 'Cancelled')) NOT VALID;

DO $$
DECLARE
  bad TEXT;
BEGIN
  SELECT string_agg(DISTINCT production_status, ', ') INTO bad
    FROM order_profiles
   WHERE production_status IS NOT NULL
     AND production_status NOT IN ('Pending', 'Approved', 'Printing', 'Pressing', 'Completed', 'Delayed', 'Cancelled');
  IF bad IS NULL THEN
    ALTER TABLE order_profiles VALIDATE CONSTRAINT order_profiles_production_status_check;
  ELSE
    RAISE NOTICE 'Orders with an unknown status found (%). The CHECK applies to new writes only until they are fixed.', bad;
  END IF;
END $$;

-- ---------- 2. Status history (append-only) ----------
CREATE TABLE IF NOT EXISTS order_status_history (
    history_id    VARCHAR(50) PRIMARY KEY,
    order_id      VARCHAR(50) NOT NULL,          -- no FK: history rows can never be deleted
    from_status   VARCHAR(50),
    to_status     VARCHAR(50) NOT NULL,
    changed_by    VARCHAR(50),
    changed_role  VARCHAR(50),
    changed_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    sync_status   VARCHAR(50) DEFAULT 'synced' CHECK (sync_status IN ('synced', 'pending_insert', 'pending_update')),
    last_modified TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_order_status_history_order ON order_status_history (order_id, changed_at);

-- forbid_audit_change() comes from migration 009 (it names the table it protects)
DROP TRIGGER IF EXISTS trg_order_status_history_append_only ON order_status_history;
CREATE TRIGGER trg_order_status_history_append_only
  BEFORE UPDATE OR DELETE ON order_status_history
  FOR EACH ROW EXECUTE FUNCTION forbid_audit_change();

-- ---------- 3. Live order updates ----------
-- NOTIFY is transactional: it is delivered only if the transaction COMMITs. The version is
-- the same text the API returns as "version" (last_modified, microseconds).
CREATE OR REPLACE FUNCTION notify_orders_changed()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM pg_notify('orders_changed', json_build_object('order_id', OLD.order_id, 'op', TG_OP)::text);
    RETURN NULL;
  END IF;
  -- Skip no-op updates (same values), e.g. sync re-sending unchanged rows
  IF TG_OP = 'UPDATE' AND (to_jsonb(NEW) - 'last_modified') = (to_jsonb(OLD) - 'last_modified') THEN
    RETURN NULL;
  END IF;
  PERFORM pg_notify('orders_changed', json_build_object(
    'order_id', NEW.order_id,
    'op', TG_OP,
    'tracking_no', NEW.tracking_no,
    'production_status', NEW.production_status,
    'version', to_char(NEW.last_modified, 'YYYY-MM-DD"T"HH24:MI:SS.US')
  )::text);
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_order_profiles_notify ON order_profiles;
CREATE TRIGGER trg_order_profiles_notify
  AFTER INSERT OR UPDATE OR DELETE ON order_profiles
  FOR EACH ROW EXECUTE FUNCTION notify_orders_changed();
