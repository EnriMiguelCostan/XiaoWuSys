-- ==========================================
-- 012: Waste diagnostics (PB 18 / PB 19 / PB 20), voids (PB 23), overheads for the P&L (PB 22)
--
--   * material_loss.reason_code / loss_category / production_stage / is_statistical_anomaly:
--     a standard reason (misprint, scorch, supplier defect...), the diagnosed cause
--     ('Machine Failure' | 'Human Error' | 'Product Defect'), the order's status when the loss
--     happened, and whether the item's losses are far above the other items' (> 2 standard
--     deviations). The rules are in services/domain/wasteDiagnostics.js.
--   * order_profiles.cancellation_reason: why the Owner cancelled (voided) the order.
--   * payments.voids_payment_id / void_reason: a payment is never edited or deleted (D3). It is
--     voided by a NEGATIVE reversing payment that points at it, once (uq_payments_voids_once).
--     The reversal gets its own AR-YYYY-NNNN number from the migration 008 trigger.
--   * overhead_expenses: rent, electricity, wages... per month, for the true-cost P&L.
--
-- No backfill on purpose: older losses keep NULL codes (shown as "Not classified"), so no
-- row's version (last_modified) moves and no offline edit waiting to sync becomes a conflict.
--
-- SAFE TO RUN MORE THAN ONCE (IF NOT EXISTS, CREATE OR REPLACE, DROP ... IF EXISTS).
-- Applied automatically on server start-up, or with:  npm run migrate
-- ==========================================

-- ---------- 1. Loss reason codes and diagnostics (PB 18 / PB 19) ----------
ALTER TABLE material_loss ADD COLUMN IF NOT EXISTS reason_code VARCHAR(50);
ALTER TABLE material_loss ADD COLUMN IF NOT EXISTS loss_category VARCHAR(50);
ALTER TABLE material_loss ADD COLUMN IF NOT EXISTS production_stage VARCHAR(50);
ALTER TABLE material_loss ADD COLUMN IF NOT EXISTS is_statistical_anomaly BOOLEAN NOT NULL DEFAULT FALSE;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'material_loss_reason_code_check') THEN
    ALTER TABLE material_loss ADD CONSTRAINT material_loss_reason_code_check CHECK (reason_code IS NULL OR reason_code IN (
      'misprint_alignment', 'sizing_encoding_error', 'heat_press_scorch', 'printer_head_banding',
      'supplier_defect', 'damaged_in_storage')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'material_loss_category_check') THEN
    ALTER TABLE material_loss ADD CONSTRAINT material_loss_category_check
      CHECK (loss_category IS NULL OR loss_category IN ('Machine Failure', 'Human Error', 'Product Defect')) NOT VALID;
  END IF;
END $$;
-- Older rows are all NULL, so validating cannot fail
ALTER TABLE material_loss VALIDATE CONSTRAINT material_loss_reason_code_check;
ALTER TABLE material_loss VALIDATE CONSTRAINT material_loss_category_check;
CREATE INDEX IF NOT EXISTS idx_material_loss_recorded ON material_loss (date_recorded);
CREATE INDEX IF NOT EXISTS idx_material_loss_order ON material_loss (order_id);

-- ---------- 2. Cancellation reason (PB 23) ----------
ALTER TABLE order_profiles ADD COLUMN IF NOT EXISTS cancellation_reason TEXT;

-- ---------- 3. Payment voids as reversing entries (PB 23, D3) ----------
ALTER TABLE payments ADD COLUMN IF NOT EXISTS voids_payment_id VARCHAR(50) REFERENCES payments(payment_id) ON DELETE RESTRICT;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS void_reason TEXT;
-- A payment can be reversed only once
CREATE UNIQUE INDEX IF NOT EXISTS uq_payments_voids_once ON payments (voids_payment_id) WHERE voids_payment_id IS NOT NULL;
DO $$
BEGIN
  -- A reversal is negative, gives a reason and never points at itself. Ordinary payments are
  -- untouched (no CHECK on their amount, see migration 008).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payments_void_shape_check') THEN
    ALTER TABLE payments ADD CONSTRAINT payments_void_shape_check CHECK (
      voids_payment_id IS NULL
      OR (amount < 0 AND void_reason IS NOT NULL AND btrim(void_reason) <> '' AND voids_payment_id <> payment_id)) NOT VALID;
  END IF;
END $$;
ALTER TABLE payments VALIDATE CONSTRAINT payments_void_shape_check;

-- ---------- 4. Monthly overhead expenses (PB 22) ----------
CREATE TABLE IF NOT EXISTS overhead_expenses (
    expense_id    VARCHAR(50) PRIMARY KEY,
    expense_date  TIMESTAMP NOT NULL,             -- the shop day it belongs to (Manila wall time)
    category      VARCHAR(100) NOT NULL,          -- 'Rent', 'Electricity & Utilities', ... (OVERHEAD_CATEGORIES)
    description   TEXT NOT NULL,
    amount        NUMERIC(10,2) NOT NULL CHECK (amount > 0),
    recorded_by   VARCHAR(50),                    -- user_id from the login token; no FK, like the trails
    sync_status   VARCHAR(50) DEFAULT 'synced' CHECK (sync_status IN ('synced', 'pending_insert', 'pending_update')),
    last_modified TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_overhead_expenses_date ON overhead_expenses (expense_date);

-- set_last_modified() comes from migration 001
DROP TRIGGER IF EXISTS trg_overhead_expenses_last_modified ON overhead_expenses;
CREATE TRIGGER trg_overhead_expenses_last_modified
  BEFORE UPDATE ON overhead_expenses
  FOR EACH ROW EXECUTE FUNCTION set_last_modified();
