-- ==========================================
-- 016: Adviser consultation, second round (November 2026)
--
--   1. 'Ready' joins the production statuses: production is finished and the order waits to be
--      picked up or delivered. Printing / Pressing -> Ready -> Completed.
--   2. inventory_items.requires_pressing: only T-shirts go through the heat press. Pressing is
--      offered only when an order has such an item (before: any garment with sizes).
--   3. Client profile: the contact person's own phone, email and social media (apart from the
--      client's), social media widened to several accounts, and the client's branches. The
--      client's address stays the MAIN branch; customer_branches holds the other ones, and
--      order_profiles.branch_id says which branch an order is for (NULL = the main branch).
--   4. order_design_files: design files uploaded from the computer (no Google Drive needed).
--      Kept in the cloud database so every branch sees them. Cloud only (not mirrored).
--   5. order_delivery_plans: how many pieces go in each batch and when, planned ahead, and
--      whether each batch is ready to go. order_deliveries.plan_id links a hand-over to its
--      planned batch.
--   6. material_loss.print_detail_id: a loss tagged to the print line it ruined (e.g. the
--      jersey with number 10, size L).
--
-- SAFE TO RUN MORE THAN ONCE (IF NOT EXISTS, CREATE OR REPLACE, DROP ... IF EXISTS).
-- ==========================================

-- ---------- 1. 'Ready' status ----------
DO $$
DECLARE
  c record;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'order_profiles'::regclass AND contype = 'c'
       AND pg_get_constraintdef(oid) ILIKE '%production_status%'
  LOOP
    EXECUTE format('ALTER TABLE order_profiles DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;
ALTER TABLE order_profiles
  ADD CONSTRAINT order_profiles_production_status_check
  CHECK (production_status IN ('Pending', 'Approved', 'Printing', 'Pressing', 'Ready', 'Completed', 'Delayed', 'Cancelled')) NOT VALID;
DO $$
DECLARE
  bad TEXT;
BEGIN
  SELECT string_agg(DISTINCT production_status, ', ') INTO bad
    FROM order_profiles
   WHERE production_status IS NOT NULL
     AND production_status NOT IN ('Pending', 'Approved', 'Printing', 'Pressing', 'Ready', 'Completed', 'Delayed', 'Cancelled');
  IF bad IS NULL THEN
    ALTER TABLE order_profiles VALIDATE CONSTRAINT order_profiles_production_status_check;
  ELSE
    RAISE NOTICE 'Orders with an unknown status found (%). The CHECK applies to new writes only until they are fixed.', bad;
  END IF;
END $$;

-- ---------- 2. Heat press for T-shirts only ----------
ALTER TABLE inventory_items DISABLE TRIGGER trg_inventory_items_last_modified;
ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS requires_pressing BOOLEAN NOT NULL DEFAULT FALSE;
-- Existing T-shirts (t-shirt, tshirt, tee, "shirt" on its own). Jerseys, polos, hoodies... stay off;
-- the Owner can switch any item on in the Catalog.
UPDATE inventory_items SET requires_pressing = TRUE
 WHERE requires_pressing = FALSE
   AND (item_name ~* '(t[\s-]?shirt|\mtees?\M)'
        OR (item_name ~* '\mshirts?\M' AND item_name !~* '(polo|jersey|hoodie|jacket|long[\s-]?sleeve|dri[\s-]?fit)'));
ALTER TABLE inventory_items ENABLE TRIGGER trg_inventory_items_last_modified;

-- ---------- 3. Client profile: contact person, several social accounts, branches ----------
ALTER TABLE customers ADD COLUMN IF NOT EXISTS contact_person_number VARCHAR(20);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS contact_person_email VARCHAR(255);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS contact_person_social TEXT;
ALTER TABLE customers ALTER COLUMN social_media TYPE TEXT;

CREATE TABLE IF NOT EXISTS customer_branches (
    branch_id       VARCHAR(50) PRIMARY KEY,
    customer_id     VARCHAR(50) NOT NULL REFERENCES customers(customer_id) ON DELETE CASCADE,
    branch_name     VARCHAR(255) NOT NULL,
    address         TEXT,
    contact_person  VARCHAR(255),
    contact_number  VARCHAR(20),
    email           VARCHAR(255),
    notes           TEXT,
    archived_at     TIMESTAMP,
    archived_by     VARCHAR(50),
    created_by      VARCHAR(50),
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    sync_status     VARCHAR(50) DEFAULT 'synced' CHECK (sync_status IN ('synced', 'pending_insert', 'pending_update')),
    last_modified   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_customer_branches_customer ON customer_branches (customer_id);
DROP TRIGGER IF EXISTS trg_customer_branches_last_modified ON customer_branches;
CREATE TRIGGER trg_customer_branches_last_modified BEFORE UPDATE ON customer_branches
  FOR EACH ROW EXECUTE FUNCTION set_last_modified();

ALTER TABLE order_profiles ADD COLUMN IF NOT EXISTS branch_id VARCHAR(50);
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_order_profiles_branch') THEN
    ALTER TABLE order_profiles ADD CONSTRAINT fk_order_profiles_branch
      FOREIGN KEY (branch_id) REFERENCES customer_branches(branch_id) ON DELETE SET NULL;
  END IF;
END $$;

-- ---------- 4. Design files uploaded from the computer ----------
CREATE TABLE IF NOT EXISTS order_design_files (
    file_id      VARCHAR(50) PRIMARY KEY,
    order_id     VARCHAR(50) NOT NULL REFERENCES order_profiles(order_id) ON DELETE CASCADE,
    file_name    VARCHAR(255) NOT NULL,
    mime_type    VARCHAR(100) NOT NULL,
    size_bytes   INTEGER NOT NULL CHECK (size_bytes > 0),
    content      BYTEA NOT NULL,
    notes        VARCHAR(500),
    uploaded_by  VARCHAR(50),
    uploaded_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_order_design_files_order ON order_design_files (order_id);

-- ---------- 5. Delivery batches planned ahead ----------
CREATE TABLE IF NOT EXISTS order_delivery_plans (
    plan_id          VARCHAR(50) PRIMARY KEY,
    order_id         VARCHAR(50) NOT NULL REFERENCES order_profiles(order_id) ON DELETE CASCADE,
    batch_no         INTEGER NOT NULL CHECK (batch_no > 0),
    planned_quantity INTEGER NOT NULL CHECK (planned_quantity > 0),
    planned_date     DATE,
    ready_at         TIMESTAMP,          -- UTC; NULL = still in production
    ready_by         VARCHAR(50),
    notes            VARCHAR(500),
    created_by       VARCHAR(50),
    created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    sync_status      VARCHAR(50) DEFAULT 'synced' CHECK (sync_status IN ('synced', 'pending_insert', 'pending_update')),
    last_modified    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_order_delivery_plans_batch UNIQUE (order_id, batch_no)
);
CREATE INDEX IF NOT EXISTS idx_order_delivery_plans_order ON order_delivery_plans (order_id);
DROP TRIGGER IF EXISTS trg_order_delivery_plans_last_modified ON order_delivery_plans;
CREATE TRIGGER trg_order_delivery_plans_last_modified BEFORE UPDATE ON order_delivery_plans
  FOR EACH ROW EXECUTE FUNCTION set_last_modified();

ALTER TABLE order_deliveries ADD COLUMN IF NOT EXISTS plan_id VARCHAR(50);
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_order_deliveries_plan') THEN
    ALTER TABLE order_deliveries ADD CONSTRAINT fk_order_deliveries_plan
      FOREIGN KEY (plan_id) REFERENCES order_delivery_plans(plan_id) ON DELETE SET NULL;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_order_deliveries_plan ON order_deliveries (plan_id) WHERE plan_id IS NOT NULL;

-- ---------- 6. A loss tagged to a print line ----------
ALTER TABLE material_loss ADD COLUMN IF NOT EXISTS print_detail_id VARCHAR(50);
