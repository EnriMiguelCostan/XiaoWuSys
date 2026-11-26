-- ==========================================
-- 019: Printing and Pressing become one status (November 2026)
--
-- The order is "In production" (stored as 'Printing') until every piece is ready; how many of each
-- item are printed and pressed is counted per item (order_items.qty_printed / qty_pressed,
-- migration 017). Orders that are Pressing now move back to Printing with every piece counted as
-- printed, which is what Pressing meant. 'Pressing' stays an allowed value for the history rows.
--
-- SAFE TO RUN MORE THAN ONCE.
-- ==========================================
UPDATE order_items oi SET qty_printed = oi.quantity
  FROM order_profiles op
 WHERE op.order_id = oi.order_id AND op.production_status = 'Pressing' AND oi.qty_printed < oi.quantity;
UPDATE order_profiles SET production_status = 'Printing' WHERE production_status = 'Pressing';
