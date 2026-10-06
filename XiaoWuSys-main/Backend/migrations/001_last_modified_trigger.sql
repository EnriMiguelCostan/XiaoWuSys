-- ==========================================
-- 001: Automatic last_modified on every UPDATE (Neon / PostgreSQL)
--
-- The C3 conflict check (services/sync.js, PATCH /orders/:id/design) compares
-- last_modified versions. Any UPDATE that forgets "last_modified = NOW()" would be
-- invisible to that check, so this trigger sets it in the database itself.
--
-- Rules:
--  * Fires BEFORE UPDATE on every public table that has a last_modified column.
--  * Only bumps the timestamp when a real column value changed. A no-op UPDATE keeps
--    the old version, so it cannot cause false "edited by someone else" conflicts.
--  * Ignores any last_modified value supplied by the UPDATE (the server clock wins).
--
-- Idempotent: safe to run more than once. Apply with:  npm run migrate
-- ==========================================

CREATE OR REPLACE FUNCTION set_last_modified()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF (to_jsonb(NEW) - 'last_modified') IS DISTINCT FROM (to_jsonb(OLD) - 'last_modified') THEN
    NEW.last_modified := NOW();
  ELSE
    NEW.last_modified := OLD.last_modified;
  END IF;
  RETURN NEW;
END;
$$;

DO $$
DECLARE
  t record;
BEGIN
  FOR t IN
    SELECT c.table_name
      FROM information_schema.columns c
      JOIN information_schema.tables tb
        ON tb.table_schema = c.table_schema AND tb.table_name = c.table_name
     WHERE c.table_schema = 'public'
       AND c.column_name = 'last_modified'
       AND tb.table_type = 'BASE TABLE'
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%s_last_modified ON %I', t.table_name, t.table_name);
    EXECUTE format(
      'CREATE TRIGGER trg_%s_last_modified BEFORE UPDATE ON %I
         FOR EACH ROW EXECUTE FUNCTION set_last_modified()',
      t.table_name, t.table_name
    );
    RAISE NOTICE 'last_modified trigger installed on %', t.table_name;
  END LOOP;
END;
$$;
