-- ==========================================
-- 004: Catalog Recycle Bin, backend-only audit trail, duplicate guard, order stock link
-- Idempotent (IF NOT EXISTS / guarded). Applied automatically on server start-up, or with:
--   npm run migrate
-- ==========================================

-- 1. Recycle Bin (soft delete). Deleted items keep every value and can be restored.
--    purged_at = "permanently deleted" but kept because past orders/losses still reference it.
ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP;
ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS deleted_by VARCHAR(50);
ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS purged_at  TIMESTAMP;

-- Partial indexes: the catalog and the bin each scan only their own rows, so a large
-- Recycle Bin never slows the main catalog down.
CREATE INDEX IF NOT EXISTS idx_inventory_items_active
  ON inventory_items (item_name) WHERE deleted_at IS NULL AND purged_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_inventory_items_recycle_bin
  ON inventory_items (deleted_at DESC) WHERE deleted_at IS NOT NULL AND purged_at IS NULL;

-- 2. No duplicate item names (case and spaces ignored: "Deli A4" = "deli  a4" = "DeliA4").
--    Only created when the existing data has no duplicates yet; otherwise the backend's own
--    check still blocks new duplicates and this NOTICE says which rows to merge first.
DO $$
DECLARE
  dupes TEXT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'uq_inventory_items_name') THEN
    SELECT string_agg(names, '; ') INTO dupes FROM (
      SELECT string_agg(item_name, ' / ') AS names
        FROM inventory_items WHERE purged_at IS NULL
       GROUP BY LOWER(REGEXP_REPLACE(item_name, '\s', '', 'g')) HAVING COUNT(*) > 1
    ) d;
    IF dupes IS NULL THEN
      CREATE UNIQUE INDEX uq_inventory_items_name
        ON inventory_items (LOWER(REGEXP_REPLACE(item_name, '\s', '', 'g'))) WHERE purged_at IS NULL;
    ELSE
      RAISE NOTICE 'Duplicate inventory names exist (%). Unique index skipped; merge them, then re-run.', dupes;
    END IF;
  END IF;
END $$;

-- 3. Audit trail (track / trace). Written by the backend in the SAME transaction as every
--    catalog change. Not exposed on the website. Append-only: rows cannot be edited or deleted.
CREATE TABLE IF NOT EXISTS inventory_audit_log (
    audit_id       VARCHAR(50) PRIMARY KEY,
    inventory_id   VARCHAR(50) NOT NULL,          -- no FK: survives a permanent delete
    action         VARCHAR(30) NOT NULL CHECK (action IN
                     ('created', 'edited', 'stock_added', 'stock_subtracted', 'deleted', 'restored', 'purged')),
    item_name      VARCHAR(255),
    details        TEXT,                          -- JSON: full item snapshot / before-after values
    performed_by   VARCHAR(50),
    performed_role VARCHAR(50),
    created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    sync_status    VARCHAR(50) DEFAULT 'synced' CHECK (sync_status IN ('synced', 'pending_insert', 'pending_update')),
    last_modified  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_inventory_audit_item ON inventory_audit_log (inventory_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_inventory_audit_time ON inventory_audit_log (created_at DESC);

CREATE OR REPLACE FUNCTION forbid_audit_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'inventory_audit_log is append-only';
END;
$$;
DROP TRIGGER IF EXISTS trg_inventory_audit_log_append_only ON inventory_audit_log;
CREATE TRIGGER trg_inventory_audit_log_append_only
  BEFORE UPDATE OR DELETE ON inventory_audit_log
  FOR EACH ROW EXECUTE FUNCTION forbid_audit_change();

-- 4. Orders hold their materials: stock_reserved = this order's items are counted in
--    inventory_items.quantity_reserved (released on Cancel, consumed on Complete).
ALTER TABLE order_profiles ADD COLUMN IF NOT EXISTS stock_reserved BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items (order_id);
CREATE INDEX IF NOT EXISTS idx_order_profiles_created ON order_profiles (date_created DESC);
