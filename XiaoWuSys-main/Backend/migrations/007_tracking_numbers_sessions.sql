-- ==========================================
-- 007: Order tracking numbers (PB 6) and per-device sign-out (PB 1)
--
--   * order_profiles.tracking_no: XM-YYYY-NNNN, sequential per year (restarts every January),
--     assigned by the database on INSERT, so every path gets one: online order creation and
--     offline orders when they sync. The year is the order's creation date in shop time
--     (Asia/Manila). Numbers come from a counter table, not a SEQUENCE, so a rolled-back order
--     does not leave a gap. Once set, a tracking number never changes.
--   * Existing orders are numbered by creation date (oldest first).
--   * revoked_sessions: login sessions ended with "Log out" on one device. Other devices of
--     the same account stay signed in.
--
-- SAFE TO RUN MORE THAN ONCE (IF NOT EXISTS, CREATE OR REPLACE, DROP ... IF EXISTS).
-- Applied automatically on server start-up, or with:  npm run migrate
--
-- Note: numbering existing orders is a real change to those rows, so their version
-- (last_modified) moves forward once. An offline edit made before this migration on one of
-- those orders will be reported as a sync conflict instead of overwriting silently.
-- ==========================================

-- ---------- 1. Tracking number column ----------
ALTER TABLE order_profiles ADD COLUMN IF NOT EXISTS tracking_no VARCHAR(20);
CREATE UNIQUE INDEX IF NOT EXISTS uq_order_profiles_tracking_no
  ON order_profiles (tracking_no) WHERE tracking_no IS NOT NULL;

-- ---------- 2. One counter per year ----------
CREATE TABLE IF NOT EXISTS order_tracking_counters (
    year          INTEGER PRIMARY KEY,
    last_number   INTEGER NOT NULL DEFAULT 0 CHECK (last_number >= 0),
    last_modified TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
DROP TRIGGER IF EXISTS trg_order_tracking_counters_last_modified ON order_tracking_counters;
CREATE TRIGGER trg_order_tracking_counters_last_modified BEFORE UPDATE ON order_tracking_counters
  FOR EACH ROW EXECUTE FUNCTION set_last_modified();

-- Next number for the shop-time year of p_created (a UTC timestamp, like date_created).
-- The counter row is locked until the calling transaction ends, so two orders created at
-- the same moment (any branch) always get different numbers.
CREATE OR REPLACE FUNCTION next_order_tracking_no(p_created TIMESTAMP)
RETURNS TEXT
LANGUAGE plpgsql
AS $$
DECLARE
  yr INTEGER;
  n  INTEGER;
BEGIN
  yr := EXTRACT(YEAR FROM ((COALESCE(p_created, NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Manila'))::INTEGER;
  INSERT INTO order_tracking_counters AS c (year, last_number) VALUES (yr, 1)
  ON CONFLICT (year) DO UPDATE SET last_number = c.last_number + 1
  RETURNING c.last_number INTO n;
  RETURN 'XM-' || yr::TEXT || '-' || CASE WHEN n < 10000 THEN lpad(n::TEXT, 4, '0') ELSE n::TEXT END;
END;
$$;

-- ---------- 3. Number existing orders, oldest first ----------
-- Runs before the immutability trigger below exists. Only rows still without a number are
-- touched, so a second run changes nothing.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT order_id, date_created FROM order_profiles
     WHERE tracking_no IS NULL
     ORDER BY date_created NULLS FIRST, order_id
  LOOP
    UPDATE order_profiles SET tracking_no = next_order_tracking_no(r.date_created) WHERE order_id = r.order_id;
  END LOOP;
END $$;

-- ---------- 4. Assign on insert, never change afterwards ----------
CREATE OR REPLACE FUNCTION assign_order_tracking_no()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- The database is the only source of tracking numbers
    NEW.tracking_no := next_order_tracking_no(NEW.date_created);
  ELSIF OLD.tracking_no IS NOT NULL THEN
    NEW.tracking_no := OLD.tracking_no;
  ELSIF NEW.tracking_no IS NULL THEN
    NEW.tracking_no := next_order_tracking_no(NEW.date_created);
  END IF;
  RETURN NEW;
END;
$$;
-- Named so it fires before trg_order_profiles_last_modified (triggers run in name order)
DROP TRIGGER IF EXISTS trg_order_profiles_assign_tracking_no ON order_profiles;
CREATE TRIGGER trg_order_profiles_assign_tracking_no BEFORE INSERT OR UPDATE ON order_profiles
  FOR EACH ROW EXECUTE FUNCTION assign_order_tracking_no();

-- ---------- 5. Per-device sign-out ----------
CREATE TABLE IF NOT EXISTS revoked_sessions (
    session_id    VARCHAR(50) PRIMARY KEY,                 -- the "sid" inside the login token
    user_id       VARCHAR(50) NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    expires_at    TIMESTAMP NOT NULL,                      -- when the token would have expired (UTC)
    revoked_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    sync_status   VARCHAR(50) DEFAULT 'synced' CHECK (sync_status IN ('synced', 'pending_insert', 'pending_update')),
    last_modified TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_revoked_sessions_expires ON revoked_sessions (expires_at);
DROP TRIGGER IF EXISTS trg_revoked_sessions_last_modified ON revoked_sessions;
CREATE TRIGGER trg_revoked_sessions_last_modified BEFORE UPDATE ON revoked_sessions
  FOR EACH ROW EXECUTE FUNCTION set_last_modified();
