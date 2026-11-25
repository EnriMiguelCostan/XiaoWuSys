-- ==========================================
-- 018: allow the waste reason the system writes when an order is cancelled after printing
--
-- Migration 017 records the pieces already made for a cancelled order as waste with
-- reason_code 'cancelled_after_printing', but the CHECK from migration 012 only listed the six
-- reasons a person can choose, so cancelling a Printing (with printed pieces), Pressing or Ready
-- order was refused. The CHECK is replaced with the full list.
--
-- SAFE TO RUN MORE THAN ONCE.
-- ==========================================
ALTER TABLE material_loss DROP CONSTRAINT IF EXISTS material_loss_reason_code_check;
ALTER TABLE material_loss ADD CONSTRAINT material_loss_reason_code_check CHECK (reason_code IS NULL OR reason_code IN (
  'misprint_alignment', 'sizing_encoding_error', 'heat_press_scorch', 'printer_head_banding',
  'supplier_defect', 'damaged_in_storage', 'cancelled_after_printing'));
