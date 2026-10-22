-- ==========================================
-- 004: Job order approval & stock reservation (Sprint 11 / PB 13)
--
-- Adds the columns and constraints the approval flow needs:
--   * order_profiles.approved_by / approved_at  (who approved a job order, and when)
--   * 'Approved' added to the production_status CHECK constraint
--     Lifecycle becomes: Pending -> Approved -> Printing -> Completed, plus Delayed / Cancelled
--   * a defence-in-depth CHECK on inventory_items so reserved/available can never go negative
--
-- SAFE TO RUN MORE THAN ONCE. Columns use IF NOT EXISTS; constraints are dropped by name
-- with IF EXISTS before being (re)added, so re-running never errors or duplicates.
--
-- The approved_by FK and the status CHECK are rebuilt rather than patched because Postgres
-- cannot ALTER an existing CHECK in place. Dropping by a known name keeps this idempotent.
--
-- Paste into the Neon SQL Editor, or run:  npm run migrate
-- ==========================================

-- ---------- 1. Approval columns on order_profiles ----------
ALTER TABLE order_profiles ADD COLUMN IF NOT EXISTS approved_by VARCHAR(50);
ALTER TABLE order_profiles ADD COLUMN IF NOT EXISTS approved_at TIMESTAMP;

-- FK approved_by -> users(user_id). Rebuilt by name so re-running is a no-op.
ALTER TABLE order_profiles DROP CONSTRAINT IF EXISTS order_profiles_approved_by_fkey;
ALTER TABLE order_profiles
  ADD CONSTRAINT order_profiles_approved_by_fkey
  FOREIGN KEY (approved_by) REFERENCES users(user_id) ON DELETE SET NULL;

-- ---------- 2. Add 'Approved' to the production_status CHECK ----------
-- The constraint name below is the default Postgres assigns to the inline CHECK in
-- schema.sql / migration 002 (<table>_<column>_check). Drop-if-exists first, then re-add
-- with the extended allow-list.
ALTER TABLE order_profiles DROP CONSTRAINT IF EXISTS order_profiles_production_status_check;
ALTER TABLE order_profiles
  ADD CONSTRAINT order_profiles_production_status_check
  CHECK (production_status IN ('Pending', 'Approved', 'Printing', 'Completed', 'Delayed', 'Cancelled'));

-- ---------- 3. Defence-in-depth stock guard on inventory_items ----------
-- The approval transaction already guards reservations in SQL; this makes it impossible for
-- any path (route, sync, manual SQL) to leave negative reserved/available counts.
ALTER TABLE inventory_items DROP CONSTRAINT IF EXISTS inventory_items_nonnegative_check;
ALTER TABLE inventory_items
  ADD CONSTRAINT inventory_items_nonnegative_check
  CHECK (quantity_reserved >= 0 AND quantity_available >= 0);
