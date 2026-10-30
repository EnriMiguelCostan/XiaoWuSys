-- ==========================================
-- 008: Payment receiver and acknowledgement receipt numbers (PB 21)
--
--   * payments.received_by: the account that recorded the payment (from the login token,
--     never from the request body). Payments recorded before this migration stay NULL and
--     are shown as "Not recorded".
--   * payments.receipt_no: AR-YYYY-NNNN ("Acknowledgement Receipt"), sequential per year
--     (restarts every January), assigned by the database on INSERT, so online payments and
--     offline payments (when they sync) both get one. The year is the payment date in shop
--     time (Asia/Manila). Numbers come from a counter table, not a SEQUENCE, so a rolled-back
--     payment does not leave a gap. Once set, a receipt number never changes.
--     This is a payment acknowledgement, not an Official Receipt.
--   * Existing payments are numbered by payment date (oldest first).
--
-- No CHECK (amount > 0) on purpose: PB 23 will record voids as negative reversing entries.
--
-- SAFE TO RUN MORE THAN ONCE (IF NOT EXISTS, CREATE OR REPLACE, DROP ... IF EXISTS).
-- Applied automatically on server start-up, or with:  npm run migrate
--
-- Note: numbering existing payments is a real change to those rows, so their version
-- (last_modified) moves forward once.
-- ==========================================

-- ---------- 1. Receiver ----------
ALTER TABLE payments ADD COLUMN IF NOT EXISTS received_by VARCHAR(50);
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_payments_received_by') THEN
    ALTER TABLE payments ADD CONSTRAINT fk_payments_received_by
      FOREIGN KEY (received_by) REFERENCES users(user_id) ON DELETE SET NULL;
  END IF;
END $$;

-- ---------- 2. Receipt number column ----------
ALTER TABLE payments ADD COLUMN IF NOT EXISTS receipt_no VARCHAR(20);
CREATE UNIQUE INDEX IF NOT EXISTS uq_payments_receipt_no
  ON payments (receipt_no) WHERE receipt_no IS NOT NULL;
-- Payment totals per order are read on every payment and order detail
CREATE INDEX IF NOT EXISTS idx_payments_order ON payments (order_id);

-- ---------- 3. One counter per year ----------
CREATE TABLE IF NOT EXISTS receipt_counters (
    year          INTEGER PRIMARY KEY,
    last_number   INTEGER NOT NULL DEFAULT 0 CHECK (last_number >= 0),
    last_modified TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
DROP TRIGGER IF EXISTS trg_receipt_counters_last_modified ON receipt_counters;
CREATE TRIGGER trg_receipt_counters_last_modified BEFORE UPDATE ON receipt_counters
  FOR EACH ROW EXECUTE FUNCTION set_last_modified();

-- Next number for the shop-time year of p_paid (a UTC timestamp, like payment_date).
-- The counter row is locked until the calling transaction ends, so two payments recorded at
-- the same moment (any branch) always get different numbers.
CREATE OR REPLACE FUNCTION next_receipt_no(p_paid TIMESTAMP)
RETURNS TEXT
LANGUAGE plpgsql
AS $$
DECLARE
  yr INTEGER;
  n  INTEGER;
BEGIN
  yr := EXTRACT(YEAR FROM ((COALESCE(p_paid, NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Manila'))::INTEGER;
  INSERT INTO receipt_counters AS c (year, last_number) VALUES (yr, 1)
  ON CONFLICT (year) DO UPDATE SET last_number = c.last_number + 1
  RETURNING c.last_number INTO n;
  RETURN 'AR-' || yr::TEXT || '-' || CASE WHEN n < 10000 THEN lpad(n::TEXT, 4, '0') ELSE n::TEXT END;
END;
$$;

-- ---------- 4. Number existing payments, oldest first ----------
-- Runs before the trigger below exists. Only rows still without a number are touched, so a
-- second run changes nothing.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT payment_id, payment_date FROM payments
     WHERE receipt_no IS NULL
     ORDER BY payment_date NULLS FIRST, payment_id
  LOOP
    UPDATE payments SET receipt_no = next_receipt_no(r.payment_date) WHERE payment_id = r.payment_id;
  END LOOP;
END $$;

-- ---------- 5. Assign on insert, never change afterwards ----------
CREATE OR REPLACE FUNCTION assign_payment_receipt_no()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- The database is the only source of receipt numbers
    NEW.receipt_no := next_receipt_no(NEW.payment_date);
  ELSIF OLD.receipt_no IS NOT NULL THEN
    NEW.receipt_no := OLD.receipt_no;
  ELSE
    -- A row from before this migration that somehow has no number: give it one, never a typed value
    NEW.receipt_no := next_receipt_no(NEW.payment_date);
  END IF;
  RETURN NEW;
END;
$$;
-- Named so it fires before trg_payments_last_modified (triggers run in name order)
DROP TRIGGER IF EXISTS trg_payments_assign_receipt_no ON payments;
CREATE TRIGGER trg_payments_assign_receipt_no BEFORE INSERT OR UPDATE ON payments
  FOR EACH ROW EXECUTE FUNCTION assign_payment_receipt_no();
