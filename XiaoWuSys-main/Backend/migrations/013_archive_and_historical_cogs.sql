-- ==========================================
-- 013: Archiving (PB 23, D2) and historical unit costs for the P&L (PB 22)
--
--   * order_profiles / customers .archived_at / archived_by: closed orders and customers with
--     no open orders can be archived by the Owner or Admin. Archived records are hidden from
--     the everyday lists, refuse every change, and are KEPT FOREVER (never purged, D2).
--     Restoring clears both columns. Every archive / restore is written to audit_log.
--   * order_items.unit_cost: the blank's unit cost at the moment the order was Completed.
--   * order_consumables_log.unit_cost: the consumable's unit cost when it was taken.
--     Both NULL on older rows, where the P&L falls back to today's catalog cost, so changing a
--     cost in the catalog later never changes a past P&L statement.
--
-- No backfill on purpose (no row's version moves, so no offline edit becomes a conflict).
-- SAFE TO RUN MORE THAN ONCE (IF NOT EXISTS, DO blocks).
-- Applied automatically on server start-up, or with:  npm run migrate
-- ==========================================

-- ---------- 1. Archiving (PB 23, D2) ----------
ALTER TABLE order_profiles ADD COLUMN IF NOT EXISTS archived_at TIMESTAMP;
ALTER TABLE order_profiles ADD COLUMN IF NOT EXISTS archived_by VARCHAR(50);   -- user_id; no FK, like the trails
ALTER TABLE customers ADD COLUMN IF NOT EXISTS archived_at TIMESTAMP;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS archived_by VARCHAR(50);
-- The everyday lists read only the records that are not archived
CREATE INDEX IF NOT EXISTS idx_order_profiles_active ON order_profiles (date_created DESC) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_customers_active ON customers (full_name) WHERE archived_at IS NULL;

-- ---------- 2. Unit cost at the time (PB 22) ----------
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS unit_cost NUMERIC(10,2);
ALTER TABLE order_consumables_log ADD COLUMN IF NOT EXISTS unit_cost NUMERIC(10,2);
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'order_items_unit_cost_check') THEN
    ALTER TABLE order_items ADD CONSTRAINT order_items_unit_cost_check CHECK (unit_cost IS NULL OR unit_cost >= 0) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'order_consumables_log_unit_cost_check') THEN
    ALTER TABLE order_consumables_log ADD CONSTRAINT order_consumables_log_unit_cost_check CHECK (unit_cost IS NULL OR unit_cost >= 0) NOT VALID;
  END IF;
END $$;
-- Older rows are all NULL, so validating cannot fail
ALTER TABLE order_items VALIDATE CONSTRAINT order_items_unit_cost_check;
ALTER TABLE order_consumables_log VALIDATE CONSTRAINT order_consumables_log_unit_cost_check;
