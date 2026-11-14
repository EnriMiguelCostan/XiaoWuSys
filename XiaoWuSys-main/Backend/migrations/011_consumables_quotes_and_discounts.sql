-- ==========================================
-- 011: Consumables deduction (PB 15), volume quotes and discounts (PB 11 / PB 12)
--
--   * consumable_rates: how much of a consumable (ink, transfer paper, thread...) one piece of a
--     blank uses, and at which status it is taken from stock ('Pressing' or 'Completed').
--     Consumables are ordinary inventory_items, so they get the low-stock warning, the catalog,
--     the audit trail and the Recycle Bin for free.
--   * order_consumables_log: one row per (order, trigger status, consumable) actually deducted.
--     The UNIQUE key is the exactly-once guard: a retried request or a repeated transition can
--     never take the same consumable twice. Append-only, like the other trails.
--     quantity_deducted + shortfall = what the rate said was needed; shortfall > 0 means the
--     stock ran out and was clamped at 0 (a status change is never blocked by an estimate).
--   * inventory_items.selling_price: what the shop charges per piece before volume discounts
--     (unit_cost stays what the shop pays for it).
--   * order_profiles.subtotal_amount / discount_amount / discount_reason: the quote's breakdown.
--     total_quote_amount = subtotal_amount - discount_amount (a quote typed in by hand is its
--     own subtotal, with no discount).
--
-- SAFE TO RUN MORE THAN ONCE (IF NOT EXISTS, CREATE OR REPLACE, DROP ... IF EXISTS).
-- Applied automatically on server start-up, or with:  npm run migrate
-- ==========================================

-- ---------- 1. Usage rates per blank (PB 15) ----------
CREATE TABLE IF NOT EXISTS consumable_rates (
    rate_id                 VARCHAR(50) PRIMARY KEY,
    product_inventory_id    VARCHAR(50) NOT NULL REFERENCES inventory_items(inventory_id) ON DELETE CASCADE,
    consumable_inventory_id VARCHAR(50) NOT NULL REFERENCES inventory_items(inventory_id) ON DELETE CASCADE,
    quantity_per_piece      NUMERIC(10,3) NOT NULL CHECK (quantity_per_piece > 0),
    trigger_status          VARCHAR(50) NOT NULL DEFAULT 'Pressing' CHECK (trigger_status IN ('Pressing', 'Completed')),
    sync_status             VARCHAR(50) DEFAULT 'synced' CHECK (sync_status IN ('synced', 'pending_insert', 'pending_update')),
    last_modified           TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_consumable_rates UNIQUE (product_inventory_id, consumable_inventory_id, trigger_status),
    CONSTRAINT consumable_rates_not_itself CHECK (product_inventory_id <> consumable_inventory_id)
);
CREATE INDEX IF NOT EXISTS idx_consumable_rates_consumable ON consumable_rates (consumable_inventory_id);

-- set_last_modified() comes from migration 001
DROP TRIGGER IF EXISTS trg_consumable_rates_last_modified ON consumable_rates;
CREATE TRIGGER trg_consumable_rates_last_modified
  BEFORE UPDATE ON consumable_rates
  FOR EACH ROW EXECUTE FUNCTION set_last_modified();

-- ---------- 2. What each order already used (exactly-once guard, append-only) ----------
CREATE TABLE IF NOT EXISTS order_consumables_log (
    log_id                  VARCHAR(50) PRIMARY KEY,
    order_id                VARCHAR(50) NOT NULL,     -- no FK: the trail outlives the order
    trigger_status          VARCHAR(50) NOT NULL,
    consumable_inventory_id VARCHAR(50) NOT NULL,     -- no FK: survives a permanent delete
    quantity_deducted       INTEGER NOT NULL CHECK (quantity_deducted >= 0),
    shortfall               INTEGER NOT NULL DEFAULT 0 CHECK (shortfall >= 0),
    deducted_at             TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    sync_status             VARCHAR(50) DEFAULT 'synced' CHECK (sync_status IN ('synced', 'pending_insert', 'pending_update')),
    last_modified           TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_order_consumables_once UNIQUE (order_id, trigger_status, consumable_inventory_id)
);

-- forbid_audit_change() comes from migration 009 (it names the table it protects)
DROP TRIGGER IF EXISTS trg_order_consumables_log_append_only ON order_consumables_log;
CREATE TRIGGER trg_order_consumables_log_append_only
  BEFORE UPDATE OR DELETE ON order_consumables_log
  FOR EACH ROW EXECUTE FUNCTION forbid_audit_change();

-- ---------- 3. Selling price per piece (PB 11) ----------
ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS selling_price NUMERIC(10,2) NOT NULL DEFAULT 0.00;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inventory_items_selling_price_check') THEN
    ALTER TABLE inventory_items ADD CONSTRAINT inventory_items_selling_price_check CHECK (selling_price >= 0) NOT VALID;
  END IF;
END $$;
ALTER TABLE inventory_items VALIDATE CONSTRAINT inventory_items_selling_price_check;

-- ---------- 4. Quote breakdown and discount (PB 11 / PB 12) ----------
ALTER TABLE order_profiles ADD COLUMN IF NOT EXISTS subtotal_amount NUMERIC(10,2) NOT NULL DEFAULT 0.00;
ALTER TABLE order_profiles ADD COLUMN IF NOT EXISTS discount_amount NUMERIC(10,2) NOT NULL DEFAULT 0.00;
ALTER TABLE order_profiles ADD COLUMN IF NOT EXISTS discount_reason TEXT;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'order_profiles_quote_breakdown_check') THEN
    ALTER TABLE order_profiles ADD CONSTRAINT order_profiles_quote_breakdown_check
      CHECK (subtotal_amount >= 0 AND discount_amount >= 0) NOT VALID;
  END IF;
END $$;
ALTER TABLE order_profiles VALIDATE CONSTRAINT order_profiles_quote_breakdown_check;

-- No backfill on purpose: rewriting every priced order would move its version (last_modified)
-- and turn every offline edit waiting to sync into a conflict. An order priced before this
-- migration (subtotal 0, discount 0, quote > 0) is shown as "set by hand" by the API
-- (quoteBreakdown in services/domain/pricing.js).
