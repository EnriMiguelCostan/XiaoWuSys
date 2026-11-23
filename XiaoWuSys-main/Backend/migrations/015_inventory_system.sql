-- ==========================================
-- 015: A full inventory system (adviser consultation, November 2026)
--
--   1. suppliers: supplier profiles. inventory_items.supplier_id links an item to its usual
--      supplier; the old free-text inventory_items.supplier is kept in step (the name).
--   2. inventory_items.has_sizes: garments (shirts, jerseys...). Only their print details have
--      sizes; a mug or tarpaulin gets a name/text line instead.
--   3. Stock documents, each with its own number (per shop year, gapless like AR- receipts):
--        SI-YYYY-NNNN  stock in    (a delivery / purchase received from a supplier)
--        SO-YYYY-NNNN  stock out   (returned to a supplier, used in the shop, sample, expired...)
--        SC-YYYY-NNNN  stock count (a physical count that corrects the system count)
--      They replace the old "Add / Subtract stock" buttons: every quantity change now has a
--      document, a date, a supplier or reason, and who recorded it.
--   4. stock_movements: the stock card. A trigger on inventory_items writes one row for EVERY
--      change of quantity_available (whatever code made it), with the running balance. What
--      the change was (stock in, order used, loss...) is passed by the transaction through
--      set_config('xiaowu.stock_movement', <json>, true). Append-only. Every existing item gets
--      an opening-balance row with its current quantity.
--   5. order_print_details: sizes / names / numbers of an order, kept apart from its materials.
--      Before this, print lines were order_items without stock, which blocked both the quote
--      and the approval ("every item must be linked to stock"). Existing lines are moved here.
--   6. order_profiles: order_description (instructions), labor_amount and incidental_amount
--      (the quote = materials + labor / services + incidental charges - discount).
--   7. order_deliveries: an order delivered or picked up in batches. An order is Completed only
--      when every piece was delivered and nothing is left to pay.
--   8. payments: more methods (Maya, PayPal, cheque, card...) with the details each needs, the
--      payer's name, the date it was paid (may be earlier than when it was recorded), refunds
--      (negative entries with a reason) and who verified a non-cash payment.
--   9. customers: client profile (contact person, email, address, social media, type, notes).
--  10. material_loss.loss_batch_id: several materials wasted in one go (bulk waste).
--
-- SAFE TO RUN MORE THAN ONCE (IF NOT EXISTS, CREATE OR REPLACE, DROP ... IF EXISTS).
-- Applied automatically on server start-up, or with:  npm run migrate
-- ==========================================

-- ---------- 1. Suppliers ----------
CREATE TABLE IF NOT EXISTS suppliers (
    supplier_id     VARCHAR(50) PRIMARY KEY,
    supplier_name   VARCHAR(255) NOT NULL,
    contact_person  VARCHAR(255),
    contact_number  VARCHAR(50),
    email           VARCHAR(255),
    address         TEXT,
    notes           TEXT,
    archived_at     TIMESTAMP,
    archived_by     VARCHAR(50),
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    sync_status     VARCHAR(50) DEFAULT 'synced' CHECK (sync_status IN ('synced', 'pending_insert', 'pending_update')),
    last_modified   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
-- Same name rule as the catalog: case and spaces are ignored ("Deli Supply" = "deli  supply")
CREATE UNIQUE INDEX IF NOT EXISTS uq_suppliers_name ON suppliers (LOWER(REGEXP_REPLACE(supplier_name, '\s', '', 'g')));
DROP TRIGGER IF EXISTS trg_suppliers_last_modified ON suppliers;
CREATE TRIGGER trg_suppliers_last_modified BEFORE UPDATE ON suppliers
  FOR EACH ROW EXECUTE FUNCTION set_last_modified();

ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS supplier_id VARCHAR(50);
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inventory_items_supplier') THEN
    ALTER TABLE inventory_items ADD CONSTRAINT fk_inventory_items_supplier
      FOREIGN KEY (supplier_id) REFERENCES suppliers(supplier_id) ON DELETE SET NULL;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_inventory_items_supplier ON inventory_items (supplier_id);

-- One supplier per distinct free-text name already in the catalog, linked to its items.
-- The backfills below must not move last_modified (an offline edit waiting to sync compares
-- against it), so the item's last_modified trigger is paused for them.
ALTER TABLE inventory_items DISABLE TRIGGER trg_inventory_items_last_modified;
INSERT INTO suppliers (supplier_id, supplier_name)
SELECT 'SUP-' || UPPER(SUBSTR(MD5(LOWER(REGEXP_REPLACE(supplier, '\s', '', 'g'))), 1, 8)),
       MIN(REGEXP_REPLACE(BTRIM(supplier), '\s+', ' ', 'g') COLLATE "C")   -- "Deli Supply" before "deli  supply"
  FROM inventory_items
 WHERE supplier IS NOT NULL AND BTRIM(supplier) <> ''
 GROUP BY LOWER(REGEXP_REPLACE(supplier, '\s', '', 'g'))
ON CONFLICT DO NOTHING;
UPDATE inventory_items ii
   SET supplier_id = s.supplier_id
  FROM suppliers s
 WHERE ii.supplier_id IS NULL AND ii.supplier IS NOT NULL
   AND LOWER(REGEXP_REPLACE(ii.supplier, '\s', '', 'g')) = LOWER(REGEXP_REPLACE(s.supplier_name, '\s', '', 'g'));

-- ---------- 2. Garments ----------
ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS has_sizes BOOLEAN NOT NULL DEFAULT FALSE;
UPDATE inventory_items SET has_sizes = TRUE
 WHERE has_sizes = FALSE
   AND (item_category ~* '(apparel|garment|shirt|jersey|clothing|uniform)'
        OR item_name ~* '(shirt|jersey|polo|hoodie|jacket|uniform|sando|shorts)');
ALTER TABLE inventory_items ENABLE TRIGGER trg_inventory_items_last_modified;

-- ---------- 3. Document numbers (SI- / SO- / SC-), one counter per prefix and shop year ----------
CREATE TABLE IF NOT EXISTS document_counters (
    prefix        VARCHAR(10) NOT NULL,
    year          INTEGER NOT NULL,
    last_number   INTEGER NOT NULL DEFAULT 0 CHECK (last_number >= 0),
    last_modified TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (prefix, year)
);
DROP TRIGGER IF EXISTS trg_document_counters_last_modified ON document_counters;
CREATE TRIGGER trg_document_counters_last_modified BEFORE UPDATE ON document_counters
  FOR EACH ROW EXECUTE FUNCTION set_last_modified();

-- Next number for the shop-time year of p_at (a UTC timestamp). The counter row stays locked
-- until the calling transaction ends, so two documents saved at once get different numbers,
-- and a rollback leaves no gap.
CREATE OR REPLACE FUNCTION next_document_no(p_prefix TEXT, p_at TIMESTAMP)
RETURNS TEXT
LANGUAGE plpgsql
AS $$
DECLARE
  yr INTEGER;
  n  INTEGER;
BEGIN
  yr := EXTRACT(YEAR FROM ((COALESCE(p_at, NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Manila'))::INTEGER;
  INSERT INTO document_counters AS c (prefix, year, last_number) VALUES (p_prefix, yr, 1)
  ON CONFLICT (prefix, year) DO UPDATE SET last_number = c.last_number + 1
  RETURNING c.last_number INTO n;
  RETURN p_prefix || '-' || yr::TEXT || '-' || CASE WHEN n < 10000 THEN LPAD(n::TEXT, 4, '0') ELSE n::TEXT END;
END;
$$;

-- ---------- 3b. Stock documents and their lines ----------
CREATE TABLE IF NOT EXISTS stock_documents (
    document_id     VARCHAR(50) PRIMARY KEY,
    document_type   VARCHAR(20) NOT NULL CHECK (document_type IN ('stock_in', 'stock_out', 'stock_count')),
    document_no     VARCHAR(20),
    reason          VARCHAR(100),          -- stock out: why (STOCK_OUT_REASONS); stock in: 'Purchase' ...
    supplier_id     VARCHAR(50) REFERENCES suppliers(supplier_id) ON DELETE SET NULL,
    order_id        VARCHAR(50),           -- optional: the order a stock out was for (no FK, like the trails)
    reference_type  VARCHAR(50),           -- 'Delivery receipt', 'Sales invoice', 'Official receipt', ...
    reference_no    VARCHAR(100),          -- the supplier's own number on that paper
    occurred_at     TIMESTAMP NOT NULL,    -- when it was received / taken out / counted (UTC)
    notes           TEXT,
    total_cost      NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (total_cost >= 0),
    recorded_by     VARCHAR(50),
    recorded_role   VARCHAR(50),
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    edited_at       TIMESTAMP,
    edited_by       VARCHAR(50),
    voided_at       TIMESTAMP,
    voided_by       VARCHAR(50),
    void_reason     TEXT,
    last_modified   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT stock_documents_void_shape_check CHECK (voided_at IS NULL OR (void_reason IS NOT NULL AND BTRIM(void_reason) <> ''))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_stock_documents_no ON stock_documents (document_no) WHERE document_no IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_stock_documents_type_date ON stock_documents (document_type, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_stock_documents_supplier ON stock_documents (supplier_id);
DROP TRIGGER IF EXISTS trg_stock_documents_last_modified ON stock_documents;
CREATE TRIGGER trg_stock_documents_last_modified BEFORE UPDATE ON stock_documents
  FOR EACH ROW EXECUTE FUNCTION set_last_modified();

CREATE OR REPLACE FUNCTION assign_stock_document_no()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.document_no := next_document_no(
      CASE NEW.document_type WHEN 'stock_in' THEN 'SI' WHEN 'stock_out' THEN 'SO' ELSE 'SC' END,
      COALESCE(NEW.created_at, NOW() AT TIME ZONE 'UTC'));
  ELSE
    NEW.document_no := OLD.document_no;   -- a number never changes once given
    NEW.document_type := OLD.document_type;
  END IF;
  RETURN NEW;
END;
$$;
-- Named so it fires before trg_stock_documents_last_modified (triggers run in name order)
DROP TRIGGER IF EXISTS trg_stock_documents_assign_no ON stock_documents;
CREATE TRIGGER trg_stock_documents_assign_no BEFORE INSERT OR UPDATE ON stock_documents
  FOR EACH ROW EXECUTE FUNCTION assign_stock_document_no();

CREATE TABLE IF NOT EXISTS stock_document_lines (
    line_id          VARCHAR(50) PRIMARY KEY,
    document_id      VARCHAR(50) NOT NULL REFERENCES stock_documents(document_id) ON DELETE CASCADE,
    line_no          INTEGER NOT NULL DEFAULT 1,
    inventory_id     VARCHAR(50) NOT NULL,   -- no FK: the paper trail outlives a permanent delete
    item_name        VARCHAR(255),           -- the name when it was recorded
    unit             VARCHAR(30),
    quantity         INTEGER NOT NULL CHECK (quantity >= 0),   -- in / out: moved; count: counted
    system_quantity  INTEGER,                                  -- count: what the system had
    unit_cost        NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (unit_cost >= 0),
    last_modified    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_stock_document_lines_doc ON stock_document_lines (document_id, line_no);
CREATE INDEX IF NOT EXISTS idx_stock_document_lines_item ON stock_document_lines (inventory_id);

-- ---------- 4. Stock movements (the stock card) ----------
CREATE TABLE IF NOT EXISTS stock_movements (
    movement_id      VARCHAR(50) PRIMARY KEY,
    inventory_id     VARCHAR(50) NOT NULL,   -- no FK: survives a permanent delete
    item_name        VARCHAR(255),
    movement_type    VARCHAR(30) NOT NULL,
    quantity_change  INTEGER NOT NULL,       -- + in, - out
    balance_after    INTEGER NOT NULL,       -- on hand right after this movement
    unit_cost        NUMERIC(10,2),
    reference_type   VARCHAR(30),            -- 'stock_document' | 'order' | 'material_loss' | ...
    reference_id     VARCHAR(50),
    reference_no     VARCHAR(30),            -- SI-2026-0001, XM-2026-0012 ...
    note             TEXT,
    performed_by     VARCHAR(50),
    performed_role   VARCHAR(50),
    occurred_at      TIMESTAMP,              -- business date (e.g. the delivery date)
    created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    sync_status      VARCHAR(50) DEFAULT 'synced' CHECK (sync_status IN ('synced', 'pending_insert', 'pending_update')),
    last_modified    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_stock_movements_item ON stock_movements (inventory_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stock_movements_time ON stock_movements (created_at DESC);
DROP TRIGGER IF EXISTS trg_stock_movements_append_only ON stock_movements;
CREATE TRIGGER trg_stock_movements_append_only
  BEFORE UPDATE OR DELETE ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION forbid_audit_change();

-- Opening balances: one row per existing item (only once: items that already have a movement are skipped)
INSERT INTO stock_movements (movement_id, inventory_id, item_name, movement_type, quantity_change, balance_after, unit_cost, note, occurred_at)
SELECT 'OPEN-' || ii.inventory_id, ii.inventory_id, ii.item_name, 'opening', ii.quantity_available, ii.quantity_available, ii.unit_cost,
       'Balance when the stock card started', NOW() AT TIME ZONE 'UTC'
  FROM inventory_items ii
 WHERE ii.purged_at IS NULL
   AND NOT EXISTS (SELECT 1 FROM stock_movements m WHERE m.inventory_id = ii.inventory_id)
ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION record_stock_movement()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  ctx   JSONB;
  delta INTEGER;
BEGIN
  IF TG_OP = 'INSERT' THEN
    delta := NEW.quantity_available;
  ELSE
    delta := NEW.quantity_available - OLD.quantity_available;
  END IF;
  IF delta = 0 AND TG_OP = 'UPDATE' THEN
    RETURN NEW;
  END IF;
  BEGIN
    ctx := NULLIF(current_setting('xiaowu.stock_movement', true), '')::jsonb;
  EXCEPTION WHEN others THEN
    ctx := NULL;
  END;
  INSERT INTO stock_movements (movement_id, inventory_id, item_name, movement_type, quantity_change, balance_after, unit_cost,
                               reference_type, reference_id, reference_no, note, performed_by, performed_role, occurred_at)
  VALUES (md5(random()::text || clock_timestamp()::text || NEW.inventory_id), NEW.inventory_id, NEW.item_name,
          COALESCE(ctx->>'type', CASE WHEN TG_OP = 'INSERT' THEN 'opening' ELSE 'sync' END),
          delta, NEW.quantity_available,
          COALESCE(NULLIF(ctx->>'unit_cost', '')::numeric, NEW.unit_cost),
          ctx->>'reference_type', ctx->>'reference_id', ctx->>'reference_no', ctx->>'note',
          ctx->>'performed_by', ctx->>'performed_role',
          COALESCE(NULLIF(ctx->>'occurred_at', '')::timestamp, NOW() AT TIME ZONE 'UTC'));
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_inventory_items_stock_movement ON inventory_items;
CREATE TRIGGER trg_inventory_items_stock_movement
  AFTER INSERT OR UPDATE OF quantity_available ON inventory_items
  FOR EACH ROW EXECUTE FUNCTION record_stock_movement();

-- ---------- 5. Print details, apart from the materials ----------
CREATE TABLE IF NOT EXISTS order_print_details (
    print_detail_id  VARCHAR(50) PRIMARY KEY,
    order_id         VARCHAR(50) NOT NULL REFERENCES order_profiles(order_id) ON DELETE CASCADE,
    line_item_id     VARCHAR(50),            -- the material (garment) it is printed on; null = the whole order
    print_type       VARCHAR(100) NOT NULL,  -- 'Jersey print', 'Name on mug', ...
    quantity         INTEGER NOT NULL CHECK (quantity > 0),
    size             VARCHAR(50),
    custom_name      VARCHAR(255),
    custom_number    VARCHAR(50),
    notes            VARCHAR(500),
    created_by       VARCHAR(50),
    created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    sync_status      VARCHAR(50) DEFAULT 'synced' CHECK (sync_status IN ('synced', 'pending_insert', 'pending_update')),
    last_modified    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_order_print_details_order ON order_print_details (order_id);
DROP TRIGGER IF EXISTS trg_order_print_details_last_modified ON order_print_details;
CREATE TRIGGER trg_order_print_details_last_modified BEFORE UPDATE ON order_print_details
  FOR EACH ROW EXECUTE FUNCTION set_last_modified();

-- Lines without stock were print details: move them (same id), then take them out of the materials
INSERT INTO order_print_details (print_detail_id, order_id, print_type, quantity, size, custom_name, custom_number)
SELECT line_item_id, order_id, LEFT(COALESCE(NULLIF(BTRIM(product_type), ''), 'Print'), 100), GREATEST(quantity, 1),
       size, custom_name, custom_number
  FROM order_items
 WHERE inventory_id IS NULL AND order_id IS NOT NULL
ON CONFLICT DO NOTHING;
DELETE FROM order_items oi
 WHERE oi.inventory_id IS NULL
   AND EXISTS (SELECT 1 FROM order_print_details p WHERE p.print_detail_id = oi.line_item_id);

-- ---------- 6. Order description and the quote's parts ----------
ALTER TABLE order_profiles ADD COLUMN IF NOT EXISTS order_description TEXT;
ALTER TABLE order_profiles ADD COLUMN IF NOT EXISTS labor_amount NUMERIC(10,2) NOT NULL DEFAULT 0.00;
ALTER TABLE order_profiles ADD COLUMN IF NOT EXISTS incidental_amount NUMERIC(10,2) NOT NULL DEFAULT 0.00;
-- A price cut after approval (late delivery, a production error): lowers the bill, with a reason.
-- If more was paid than the new bill, the order shows Overpaid and the difference is refunded.
ALTER TABLE order_profiles ADD COLUMN IF NOT EXISTS adjustment_amount NUMERIC(10,2) NOT NULL DEFAULT 0.00;
ALTER TABLE order_profiles ADD COLUMN IF NOT EXISTS adjustment_reason TEXT;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'order_profiles_quote_parts_check') THEN
    ALTER TABLE order_profiles ADD CONSTRAINT order_profiles_quote_parts_check
      CHECK (labor_amount >= 0 AND incidental_amount >= 0 AND adjustment_amount >= 0) NOT VALID;
  END IF;
END $$;
ALTER TABLE order_profiles VALIDATE CONSTRAINT order_profiles_quote_parts_check;

-- ---------- 7. Deliveries / pick-ups in batches ----------
CREATE TABLE IF NOT EXISTS order_deliveries (
    delivery_id      VARCHAR(50) PRIMARY KEY,
    order_id         VARCHAR(50) NOT NULL REFERENCES order_profiles(order_id) ON DELETE CASCADE,
    batch_no         INTEGER NOT NULL CHECK (batch_no > 0),
    quantity         INTEGER NOT NULL CHECK (quantity > 0),
    delivered_at     TIMESTAMP NOT NULL,     -- UTC
    method           VARCHAR(30) NOT NULL DEFAULT 'Pick-up' CHECK (method IN ('Pick-up', 'Delivery', 'Courier')),
    received_by_name VARCHAR(255),           -- who took the pieces
    notes            VARCHAR(500),
    recorded_by      VARCHAR(50),
    created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    sync_status      VARCHAR(50) DEFAULT 'synced' CHECK (sync_status IN ('synced', 'pending_insert', 'pending_update')),
    last_modified    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_order_deliveries_batch UNIQUE (order_id, batch_no)
);
CREATE INDEX IF NOT EXISTS idx_order_deliveries_order ON order_deliveries (order_id);
DROP TRIGGER IF EXISTS trg_order_deliveries_last_modified ON order_deliveries;
CREATE TRIGGER trg_order_deliveries_last_modified BEFORE UPDATE ON order_deliveries
  FOR EACH ROW EXECUTE FUNCTION set_last_modified();

-- ---------- 8. Payments: methods, details, paid date, refunds, verification ----------
DO $$
DECLARE
  c record;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'payments'::regclass AND contype = 'c'
       AND pg_get_constraintdef(oid) ILIKE '%payment_type%'
  LOOP
    EXECUTE format('ALTER TABLE payments DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;
ALTER TABLE payments ADD CONSTRAINT payments_payment_type_check
  CHECK (payment_type IN ('Cash', 'GCash', 'Maya', 'PayPal', 'Bank Transfer', 'Cheque', 'Credit/Debit Card', 'Other'));

ALTER TABLE payments ADD COLUMN IF NOT EXISTS payer_name VARCHAR(255);
ALTER TABLE payments ADD COLUMN IF NOT EXISTS reference_no VARCHAR(100);
ALTER TABLE payments ADD COLUMN IF NOT EXISTS bank_name VARCHAR(100);
ALTER TABLE payments ADD COLUMN IF NOT EXISTS account_name VARCHAR(255);
ALTER TABLE payments ADD COLUMN IF NOT EXISTS cheque_no VARCHAR(50);
ALTER TABLE payments ADD COLUMN IF NOT EXISTS cheque_date DATE;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS payment_notes VARCHAR(500);
ALTER TABLE payments ADD COLUMN IF NOT EXISTS is_refund BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS refund_reason TEXT;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS verified_by VARCHAR(50);
ALTER TABLE payments ADD COLUMN IF NOT EXISTS verified_at TIMESTAMP;
-- When it was typed in (payment_date is when it was paid). Older payments keep NULL: they were
-- recorded when they were paid. Added without a default first, so no existing row is touched.
ALTER TABLE payments ADD COLUMN IF NOT EXISTS recorded_at TIMESTAMP;
ALTER TABLE payments ALTER COLUMN recorded_at SET DEFAULT CURRENT_TIMESTAMP;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payments_refund_shape_check') THEN
    ALTER TABLE payments ADD CONSTRAINT payments_refund_shape_check CHECK (
      NOT is_refund
      OR (amount < 0 AND voids_payment_id IS NULL AND refund_reason IS NOT NULL AND BTRIM(refund_reason) <> '')) NOT VALID;
  END IF;
END $$;
ALTER TABLE payments VALIDATE CONSTRAINT payments_refund_shape_check;

-- ---------- 9. Client profile ----------
ALTER TABLE customers ADD COLUMN IF NOT EXISTS customer_type VARCHAR(30) NOT NULL DEFAULT 'Individual';
ALTER TABLE customers ADD COLUMN IF NOT EXISTS contact_person VARCHAR(255);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS email VARCHAR(255);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS address TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS social_media VARCHAR(255);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS notes TEXT;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'customers_type_check') THEN
    ALTER TABLE customers ADD CONSTRAINT customers_type_check
      CHECK (customer_type IN ('Individual', 'School', 'Company', 'Organization', 'Government', 'Reseller')) NOT VALID;
  END IF;
END $$;
ALTER TABLE customers VALIDATE CONSTRAINT customers_type_check;

-- ---------- 10. Bulk waste ----------
ALTER TABLE material_loss ADD COLUMN IF NOT EXISTS loss_batch_id VARCHAR(50);
CREATE INDEX IF NOT EXISTS idx_material_loss_batch ON material_loss (loss_batch_id) WHERE loss_batch_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_material_loss_date ON material_loss (date_recorded);
