-- ==========================================
-- 017: Shop policies, production progress and print-based quotes (November 2026)
--
--   1. Production progress per item: order_items.qty_printed / qty_pressed. An item is ready when
--      it is printed (and pressed, for items that need the heat press). The order moves to
--      Pressing when everything is printed, to Ready when everything is ready, and is Completed
--      only from Ready. Orders already past a step are filled in from their status.
--   2. Print-based quotes: inventory_items.print_pricing
--        'included'  the selling price is the finished piece (mugs, tarpaulin, sublimation jerseys)
--        'per_area'  the selling price is the blank; each print area on the order line adds its
--                    own charge (front A4, back A3, left-chest logo, names and numbers...)
--      order_items.print_areas: the line's print areas, JSON [{ "placement": "Front", "size": "A4" }].
--   3. Cancellation: order_profiles.cancellation_fee (what the shop keeps, by the stage the order
--      was cancelled at), cancelled_stage, cancel_shop_fault (the shop's fault: nothing is kept).
--   4. Late delivery: order_profiles.client_delay_reason. When the client caused the delay (late
--      design, late payment, changes) no late-delivery price cut is suggested.
--   5. Add-ons after approval: order_items.added_after_approval marks lines added to an approved
--      order (priced and added to the bill on their own).
--
-- SAFE TO RUN MORE THAN ONCE (IF NOT EXISTS).
-- ==========================================

-- ---------- 1. Production progress ----------
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS qty_printed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS qty_pressed INTEGER NOT NULL DEFAULT 0;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'order_items_progress_check') THEN
    ALTER TABLE order_items ADD CONSTRAINT order_items_progress_check
      CHECK (qty_pressed >= 0 AND qty_printed >= qty_pressed AND qty_printed <= quantity) NOT VALID;
  END IF;
END $$;

-- Orders already past a step: everything up to that step is done
UPDATE order_items oi SET qty_printed = oi.quantity
  FROM order_profiles op
 WHERE op.order_id = oi.order_id AND op.production_status IN ('Pressing', 'Ready', 'Completed') AND oi.qty_printed = 0;
UPDATE order_items oi SET qty_pressed = oi.quantity
  FROM order_profiles op, inventory_items ii
 WHERE op.order_id = oi.order_id AND ii.inventory_id = oi.inventory_id AND ii.requires_pressing
   AND op.production_status IN ('Ready', 'Completed') AND oi.qty_pressed = 0;

-- ---------- 2. Print-based quotes ----------
ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS print_pricing VARCHAR(20) NOT NULL DEFAULT 'included';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inventory_items_print_pricing_check') THEN
    ALTER TABLE inventory_items ADD CONSTRAINT inventory_items_print_pricing_check CHECK (print_pricing IN ('included', 'per_area'));
  END IF;
END $$;
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS print_areas TEXT;
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS added_after_approval BOOLEAN NOT NULL DEFAULT FALSE;

-- ---------- 3. / 4. Cancellation and late delivery ----------
ALTER TABLE order_profiles ADD COLUMN IF NOT EXISTS cancellation_fee NUMERIC(10,2);
ALTER TABLE order_profiles ADD COLUMN IF NOT EXISTS cancelled_stage VARCHAR(50);
ALTER TABLE order_profiles ADD COLUMN IF NOT EXISTS cancel_shop_fault BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE order_profiles ADD COLUMN IF NOT EXISTS client_delay_reason TEXT;
