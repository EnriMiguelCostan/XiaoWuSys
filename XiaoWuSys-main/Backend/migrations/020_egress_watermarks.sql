-- ==========================================
-- 020: support for the incremental cache refresh (egress fix, November 2026)
--
-- 1. Every table the shop computers copy into their offline cache gets an index on
--    last_modified. Each sync now asks "how many rows, and what is the newest change?" and then
--    reads only the rows changed since the last sync; the index keeps both questions cheap.
-- 2. pg_stat_statements is turned on where the database allows it (Neon does), so the queries
--    that send the most data can be measured:
--      SELECT query, calls, rows FROM pg_stat_statements ORDER BY rows DESC LIMIT 20;
--    A database without the extension (or without permission to add it) skips this step.
--
-- SAFE TO RUN MORE THAN ONCE.
-- ==========================================
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'users', 'customers', 'customer_branches', 'suppliers', 'inventory_items', 'consumable_rates',
    'order_profiles', 'order_items', 'order_print_details', 'order_delivery_plans', 'order_deliveries',
    'payments', 'material_loss', 'order_status_history', 'order_consumables_log', 'overhead_expenses'
  ]
  LOOP
    IF EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = current_schema() AND table_name = t AND column_name = 'last_modified') THEN
      EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I (last_modified)', 'idx_' || t || '_last_modified', t);
    END IF;
  END LOOP;
END;
$$;

DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_stat_statements is not available here (%); skipped.', SQLERRM;
END;
$$;
