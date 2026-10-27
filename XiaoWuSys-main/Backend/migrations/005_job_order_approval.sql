-- ==========================================
-- 005: Job order approval (Sprint 11 / PB 13)
--
--   * order_profiles.approved_by / approved_at  (who approved a job order, and when)
--   * 'Approved' added to the production_status CHECK constraint
--     Lifecycle: Pending -> Approved -> Printing -> Completed, plus Delayed / Cancelled
--   * defence-in-depth CHECK on inventory_items: reserved and available never negative
--
-- Stock reservation itself uses order_profiles.stock_reserved from migration 004.
--
-- SAFE TO RUN MORE THAN ONCE. Columns use IF NOT EXISTS; constraints are dropped by name
-- with IF EXISTS before being re-added. Applied automatically on server start-up, or with:
--   npm run migrate
-- ==========================================

-- ---------- 1. Approval columns on order_profiles ----------
ALTER TABLE order_profiles ADD COLUMN IF NOT EXISTS approved_by VARCHAR(50);
ALTER TABLE order_profiles ADD COLUMN IF NOT EXISTS approved_at TIMESTAMP;

ALTER TABLE order_profiles DROP CONSTRAINT IF EXISTS order_profiles_approved_by_fkey;
ALTER TABLE order_profiles
  ADD CONSTRAINT order_profiles_approved_by_fkey
  FOREIGN KEY (approved_by) REFERENCES users(user_id) ON DELETE SET NULL;

-- ---------- 2. Add 'Approved' to the production_status CHECK ----------
-- Postgres cannot edit a CHECK in place, so drop and re-add. The inline CHECK from schema.sql
-- is named order_profiles_production_status_check, but a legacy database may carry one under
-- another name, so every CHECK on order_profiles that mentions production_status is dropped.
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
  CHECK (production_status IN ('Pending', 'Approved', 'Printing', 'Completed', 'Delayed', 'Cancelled'));

-- ---------- 3. Defence-in-depth stock guard on inventory_items ----------
-- Added NOT VALID so it always applies to new writes, then validated against existing rows.
-- If an existing row is already negative, validation is skipped with a NOTICE naming the
-- rows, instead of failing this migration on every server start. Fix them, then re-run
-- "ALTER TABLE inventory_items VALIDATE CONSTRAINT inventory_items_nonnegative_check".
ALTER TABLE inventory_items DROP CONSTRAINT IF EXISTS inventory_items_nonnegative_check;
ALTER TABLE inventory_items
  ADD CONSTRAINT inventory_items_nonnegative_check
  CHECK (quantity_reserved >= 0 AND quantity_available >= 0) NOT VALID;

DO $$
DECLARE
  bad TEXT;
BEGIN
  SELECT string_agg(inventory_id || ' (' || item_name || ')', ', ') INTO bad
    FROM inventory_items WHERE quantity_reserved < 0 OR quantity_available < 0;
  IF bad IS NULL THEN
    ALTER TABLE inventory_items VALIDATE CONSTRAINT inventory_items_nonnegative_check;
  ELSE
    RAISE NOTICE 'Negative stock found in: %. The CHECK applies to new writes only until these rows are fixed.', bad;
  END IF;
END $$;
