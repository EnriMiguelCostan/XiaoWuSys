-- ==========================================
-- 003: Real-time stock change notifications
-- Every INSERT / UPDATE / DELETE on inventory_items sends a NOTIFY on the
-- 'inventory_changed' channel. Each backend LISTENs (services/inventoryEvents.js) and
-- pushes a fresh snapshot to its browsers over Socket.io, so a stock change made by
-- ANY branch, script or SQL editor session reaches every connected screen.
--
-- NOTIFY is transactional: it is only delivered if the transaction COMMITs.
-- Payload: {"inventory_id": "...", "op": "INSERT|UPDATE|DELETE"}
-- Idempotent. Apply with:  npm run migrate
-- ==========================================

CREATE OR REPLACE FUNCTION notify_inventory_changed()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  changed_id VARCHAR(50);
BEGIN
  IF TG_OP = 'DELETE' THEN
    changed_id := OLD.inventory_id;
  ELSE
    changed_id := NEW.inventory_id;
    -- Skip no-op updates (same values), e.g. sync re-sending unchanged rows
    IF TG_OP = 'UPDATE' AND (to_jsonb(NEW) - 'last_modified') = (to_jsonb(OLD) - 'last_modified') THEN
      RETURN NULL;
    END IF;
  END IF;
  PERFORM pg_notify('inventory_changed', json_build_object('inventory_id', changed_id, 'op', TG_OP)::text);
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_inventory_items_notify ON inventory_items;
CREATE TRIGGER trg_inventory_items_notify
  AFTER INSERT OR UPDATE OR DELETE ON inventory_items
  FOR EACH ROW EXECUTE FUNCTION notify_inventory_changed();
