-- ==========================================
-- 002: Bring an older Neon database up to schema.sql
--
-- Fixes startup errors such as:
--   Failed to refresh ... from cloud: column "last_modified" does not exist
--   Failed to refresh order_items from cloud: column "inventory_id" does not exist
--
-- SAFE TO RUN MORE THAN ONCE. Every statement is "IF NOT EXISTS" or checks first:
--   * missing tables are created (exact copy of schema.sql)
--   * missing columns are added; existing columns and data are never changed or dropped
--   * existing rows get last_modified = time of this migration
--   * the last_modified trigger (001) is (re)installed on every table, because 001 skips
--     tables that did not have last_modified yet when it ran
--
-- NOT done here (would fail or rewrite data on a legacy database; handle separately):
--   * CHECK constraints (role, status, payment_type, sync_status) on pre-existing tables
--   * changing existing column types (e.g. REAL -> NUMERIC(10,2) for money)
--   * NOT NULL on columns this migration adds (added as nullable when no default exists)
--
-- Paste into the Neon SQL Editor, or run:  npm run migrate
-- ==========================================

-- ---------- 1. Missing tables (no-op for tables that exist) ----------
CREATE TABLE IF NOT EXISTS users (
    user_id VARCHAR(50) PRIMARY KEY,
    username VARCHAR(100) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role VARCHAR(50) NOT NULL CHECK (role IN ('Owner', 'Admin', 'Production', 'Staff')),
    sync_status VARCHAR(50) DEFAULT 'synced' CHECK (sync_status IN ('synced', 'pending_insert', 'pending_update')),
    last_modified TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS inventory_items (
    inventory_id VARCHAR(50) PRIMARY KEY,
    item_name VARCHAR(255) NOT NULL,
    item_category VARCHAR(100) NOT NULL,
    quantity_available INTEGER NOT NULL DEFAULT 0,
    quantity_reserved INTEGER NOT NULL DEFAULT 0,
    minimum_threshold INTEGER NOT NULL DEFAULT 0,
    unit_cost NUMERIC(10,2) NOT NULL,
    sync_status VARCHAR(50) DEFAULT 'synced' CHECK (sync_status IN ('synced', 'pending_insert', 'pending_update')),
    last_modified TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS customers (
    customer_id VARCHAR(50) PRIMARY KEY,
    full_name VARCHAR(255) NOT NULL,
    contact_number VARCHAR(50),
    platform_source VARCHAR(100),
    sync_status VARCHAR(50) DEFAULT 'synced' CHECK (sync_status IN ('synced', 'pending_insert', 'pending_update')),
    last_modified TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS order_profiles (
    order_id VARCHAR(50) PRIMARY KEY,
    customer_id VARCHAR(50) REFERENCES customers(customer_id) ON DELETE RESTRICT,
    date_created TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    production_deadline TIMESTAMP NOT NULL,
    production_status VARCHAR(50) DEFAULT 'Pending' CHECK (production_status IN ('Pending', 'Printing', 'Completed', 'Delayed', 'Cancelled')),
    design_drive_link TEXT,
    total_quote_amount NUMERIC(10,2) DEFAULT 0.00,
    sync_status VARCHAR(50) DEFAULT 'synced' CHECK (sync_status IN ('synced', 'pending_insert', 'pending_update')),
    last_modified TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS order_items (
    line_item_id VARCHAR(50) PRIMARY KEY,
    order_id VARCHAR(50) REFERENCES order_profiles(order_id) ON DELETE CASCADE,
    inventory_id VARCHAR(50) REFERENCES inventory_items(inventory_id) ON DELETE RESTRICT,
    product_type VARCHAR(100) NOT NULL,
    quantity INTEGER NOT NULL,
    size VARCHAR(50),
    custom_name VARCHAR(255),
    custom_number VARCHAR(50),
    price NUMERIC(10,2) DEFAULT 0.00,
    sync_status VARCHAR(50) DEFAULT 'synced' CHECK (sync_status IN ('synced', 'pending_insert', 'pending_update')),
    last_modified TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS payments (
    payment_id VARCHAR(50) PRIMARY KEY,
    order_id VARCHAR(50) REFERENCES order_profiles(order_id) ON DELETE CASCADE,
    amount NUMERIC(10,2) NOT NULL,
    payment_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    payment_type VARCHAR(50) NOT NULL CHECK (payment_type IN ('Cash', 'GCash', 'Bank Transfer')),
    sync_status VARCHAR(50) DEFAULT 'synced' CHECK (sync_status IN ('synced', 'pending_insert', 'pending_update')),
    last_modified TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS material_loss (
    loss_id VARCHAR(50) PRIMARY KEY,
    order_id VARCHAR(50) REFERENCES order_profiles(order_id) ON DELETE SET NULL,
    inventory_id VARCHAR(50) REFERENCES inventory_items(inventory_id) ON DELETE RESTRICT,
    quantity_lost INTEGER NOT NULL,
    loss_reason TEXT NOT NULL,
    date_recorded TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    financial_cost NUMERIC(10,2) NOT NULL DEFAULT 0.00,
    sync_status VARCHAR(50) DEFAULT 'synced' CHECK (sync_status IN ('synced', 'pending_insert', 'pending_update')),
    last_modified TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ---------- 2. Missing columns on tables that already existed ----------
-- users
ALTER TABLE users ADD COLUMN IF NOT EXISTS sync_status   VARCHAR(50) DEFAULT 'synced';
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_modified TIMESTAMP   DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE users ADD COLUMN IF NOT EXISTS created_at    TIMESTAMP   DEFAULT CURRENT_TIMESTAMP;

-- inventory_items
ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS item_category      VARCHAR(100);
ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS quantity_available INTEGER NOT NULL DEFAULT 0;
ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS quantity_reserved  INTEGER NOT NULL DEFAULT 0;
ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS minimum_threshold  INTEGER NOT NULL DEFAULT 0;
ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS unit_cost          NUMERIC(10,2) NOT NULL DEFAULT 0.00;
ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS sync_status        VARCHAR(50) DEFAULT 'synced';
ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS last_modified      TIMESTAMP   DEFAULT CURRENT_TIMESTAMP;

-- customers
ALTER TABLE customers ADD COLUMN IF NOT EXISTS contact_number  VARCHAR(50);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS platform_source VARCHAR(100);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS sync_status     VARCHAR(50) DEFAULT 'synced';
ALTER TABLE customers ADD COLUMN IF NOT EXISTS last_modified   TIMESTAMP   DEFAULT CURRENT_TIMESTAMP;

-- order_profiles
ALTER TABLE order_profiles ADD COLUMN IF NOT EXISTS date_created       TIMESTAMP     DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE order_profiles ADD COLUMN IF NOT EXISTS production_status  VARCHAR(50)   DEFAULT 'Pending';
ALTER TABLE order_profiles ADD COLUMN IF NOT EXISTS design_drive_link  TEXT;
ALTER TABLE order_profiles ADD COLUMN IF NOT EXISTS total_quote_amount NUMERIC(10,2) DEFAULT 0.00;
ALTER TABLE order_profiles ADD COLUMN IF NOT EXISTS sync_status        VARCHAR(50)   DEFAULT 'synced';
ALTER TABLE order_profiles ADD COLUMN IF NOT EXISTS last_modified      TIMESTAMP     DEFAULT CURRENT_TIMESTAMP;

-- order_items (D4: link to inventory + price)
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS inventory_id  VARCHAR(50);
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS size          VARCHAR(50);
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS custom_name   VARCHAR(255);
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS custom_number VARCHAR(50);
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS price         NUMERIC(10,2) DEFAULT 0.00;
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS sync_status   VARCHAR(50)   DEFAULT 'synced';
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS last_modified TIMESTAMP     DEFAULT CURRENT_TIMESTAMP;

-- payments
ALTER TABLE payments ADD COLUMN IF NOT EXISTS payment_date  TIMESTAMP   DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS sync_status   VARCHAR(50) DEFAULT 'synced';
ALTER TABLE payments ADD COLUMN IF NOT EXISTS last_modified TIMESTAMP   DEFAULT CURRENT_TIMESTAMP;

-- material_loss
ALTER TABLE material_loss ADD COLUMN IF NOT EXISTS order_id       VARCHAR(50);
ALTER TABLE material_loss ADD COLUMN IF NOT EXISTS date_recorded  TIMESTAMP     DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE material_loss ADD COLUMN IF NOT EXISTS financial_cost NUMERIC(10,2) NOT NULL DEFAULT 0.00;
ALTER TABLE material_loss ADD COLUMN IF NOT EXISTS sync_status    VARCHAR(50)   DEFAULT 'synced';
ALTER TABLE material_loss ADD COLUMN IF NOT EXISTS last_modified  TIMESTAMP     DEFAULT CURRENT_TIMESTAMP;

-- Rows inserted while last_modified was missing/NULL get a real version
UPDATE users           SET last_modified = CURRENT_TIMESTAMP WHERE last_modified IS NULL;
UPDATE inventory_items SET last_modified = CURRENT_TIMESTAMP WHERE last_modified IS NULL;
UPDATE customers       SET last_modified = CURRENT_TIMESTAMP WHERE last_modified IS NULL;
UPDATE order_profiles  SET last_modified = CURRENT_TIMESTAMP WHERE last_modified IS NULL;
UPDATE order_items     SET last_modified = CURRENT_TIMESTAMP WHERE last_modified IS NULL;
UPDATE payments        SET last_modified = CURRENT_TIMESTAMP WHERE last_modified IS NULL;
UPDATE material_loss   SET last_modified = CURRENT_TIMESTAMP WHERE last_modified IS NULL;

-- ---------- 3. Foreign key for the new order_items.inventory_id ----------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'order_items'::regclass AND contype = 'f'
       AND conkey = ARRAY[(SELECT attnum FROM pg_attribute
                            WHERE attrelid = 'order_items'::regclass AND attname = 'inventory_id')]::smallint[]
  ) THEN
    ALTER TABLE order_items
      ADD CONSTRAINT order_items_inventory_id_fkey
      FOREIGN KEY (inventory_id) REFERENCES inventory_items(inventory_id) ON DELETE RESTRICT;
  END IF;
END;
$$;

-- ---------- 4. (Re)install the last_modified trigger from 001 on every table ----------
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
  END LOOP;
END;
$$;
