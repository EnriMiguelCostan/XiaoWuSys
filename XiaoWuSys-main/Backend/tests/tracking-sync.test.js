// PB 6 + PB 1 with the sync engine: an order saved offline gets its XM-YYYY-NNNN number from
// the cloud when it syncs, this computer never sends a number of its own, and an offline
// logout reaches the cloud. The cloud is a small scripted stand-in that records every query
// (the real numbering trigger is tested on PostgreSQL in migrations.pg.test.js).
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { prepareDatabase } = require('./helpers/testServer');
const { syncOfflineData } = require('../services/sync');
const { sqliteRun, sqliteGet } = require('../services/records');

const flat = (sql) => sql.replace(/\s+/g, ' ').trim();

const createScriptedCloud = () => {
  const queries = [];
  const inCloud = new Set();
  let counter = 41;
  const numbers = new Map();
  const pool = {
    queries,
    inCloud,
    query: async (sql, params = []) => {
      const q = flat(sql);
      queries.push({ q, params });
      if (/^SELECT 1 FROM order_profiles WHERE order_id = \$1$/.test(q)) return { rows: [], rowCount: inCloud.has(params[0]) ? 1 : 0 };
      if (/^INSERT INTO order_profiles /.test(q)) {
        inCloud.add(params[0]);
        numbers.set(params[0], `XM-2026-${String(++counter).padStart(4, '0')}`); // what the trigger does
        return { rows: [], rowCount: 1 };
      }
      if (/^INSERT INTO /.test(q)) return { rows: [], rowCount: 1 };
      if (/AS version, tracking_no::text AS tracking_no FROM order_profiles WHERE order_id = \$1$/.test(q)) {
        return { rows: [{ version: '2026-10-29T08:00:00.000001', tracking_no: numbers.get(params[0]) || null }], rowCount: 1 };
      }
      if (/^UPDATE order_profiles .* RETURNING .* AS version, tracking_no::text AS tracking_no$/.test(q)) {
        return { rows: [{ version: '2026-10-29T09:00:00.000001', tracking_no: 'XM-2026-0007' }], rowCount: 1 };
      }
      if (/AS version FROM \w+ WHERE \w+ = \$1$/.test(q)) return { rows: [{ version: '2026-10-29T08:00:00.000001' }], rowCount: 1 };
      return { rows: [], rowCount: 0 }; // refresh reads: nothing new in the cloud
    },
    connect: async () => { throw new Error('not used'); }
  };
  return pool;
};

describe('Sync: order numbers and offline logouts', () => {
  let dir;
  let db;
  let cloud;

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaowusys-sync-'));
    db = await prepareDatabase(path.join(dir, 'cache.db'));
    await sqliteRun(db, "INSERT INTO customers (customer_id, full_name, sync_status) VALUES ('c-1', 'Agdao NHS', 'synced')");
    await sqliteRun(db,
      `INSERT INTO order_profiles (order_id, customer_id, date_created, production_deadline, production_status, total_quote_amount, sync_status, last_modified)
       VALUES ('o-offline', 'c-1', '2026-10-29 01:00:00', '2026-11-10T00:00:00', 'Pending', 0, 'pending_insert', '2026-10-29 01:00:00.000')`);
    await sqliteRun(db,
      `INSERT INTO revoked_sessions (session_id, user_id, expires_at, revoked_at, sync_status)
       VALUES ('sid-laptop', 'u-owner', '2026-10-29 09:00:00', '2026-10-29 01:05:00', 'pending_insert')`);
    cloud = createScriptedCloud();
  });
  after(async () => {
    await new Promise((r) => db.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('pushes the offline order without a number and saves the number the cloud gave it', async () => {
    const summary = await syncOfflineData(cloud, db);
    assert.equal(summary.aborted, false);
    const insert = cloud.queries.find((x) => x.q.startsWith('INSERT INTO order_profiles'));
    assert.ok(insert, 'the order was pushed');
    assert.ok(!/tracking_no/.test(insert.q), 'this computer never sends a tracking number');
    const row = await sqliteGet(db, "SELECT tracking_no, sync_status FROM order_profiles WHERE order_id = 'o-offline'");
    assert.deepEqual([row.tracking_no, row.sync_status], ['XM-2026-0042', 'synced']);
  });

  it('pushes the offline logout so every branch refuses that session', async () => {
    const insert = cloud.queries.find((x) => x.q.startsWith('INSERT INTO revoked_sessions'));
    assert.ok(insert);
    assert.match(insert.q, /\(session_id, user_id, expires_at, revoked_at, last_modified\)/);
    assert.deepEqual(insert.params.slice(0, 2), ['sid-laptop', 'u-owner']);
    const pushedBeforeOrders = cloud.queries.indexOf(insert) < cloud.queries.findIndex((x) => x.q.startsWith('INSERT INTO order_profiles'));
    assert.ok(pushedBeforeOrders, 'sessions are pushed right after accounts');
    assert.equal((await sqliteGet(db, "SELECT sync_status FROM revoked_sessions WHERE session_id = 'sid-laptop'")).sync_status, 'synced');
  });

  it('does not use up a number when an order that is already in the cloud is sent again', async () => {
    await sqliteRun(db, "UPDATE order_profiles SET sync_status = 'pending_insert', tracking_no = NULL WHERE order_id = 'o-offline'");
    const before = cloud.queries.length;
    await syncOfflineData(cloud, db);
    const fresh = cloud.queries.slice(before);
    assert.ok(fresh.some((x) => /^SELECT 1 FROM order_profiles WHERE order_id = \$1$/.test(x.q)));
    assert.ok(!fresh.some((x) => x.q.startsWith('INSERT INTO order_profiles')), 'no second INSERT, so the counter is not touched');
    assert.equal((await sqliteGet(db, "SELECT tracking_no FROM order_profiles WHERE order_id = 'o-offline'")).tracking_no, 'XM-2026-0042');
  });

  it('never sends the number with an offline edit, even when the edited fields are unknown', async () => {
    await sqliteRun(db, `UPDATE order_profiles SET sync_status = 'pending_update', dirty_fields = NULL, tracking_no = 'XM-1999-9999',
                         cloud_last_modified = '2026-10-29T08:00:00.000001' WHERE order_id = 'o-offline'`);
    const before = cloud.queries.length;
    await syncOfflineData(cloud, db);
    const update = cloud.queries.slice(before).find((x) => x.q.startsWith('UPDATE order_profiles'));
    assert.ok(update, 'the edit was pushed');
    assert.ok(!/SET .*tracking_no =/.test(update.q), 'tracking_no is not in the SET list');
    assert.equal((await sqliteGet(db, "SELECT tracking_no FROM order_profiles WHERE order_id = 'o-offline'")).tracking_no, 'XM-2026-0007',
      'the cloud value replaces whatever was stored locally');
  });
});
