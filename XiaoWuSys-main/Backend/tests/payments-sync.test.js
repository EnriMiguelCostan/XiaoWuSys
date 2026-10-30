// PB 21 + D2 with the sync engine. Two branches take payments for the same order while the
// internet is down. Each branch checks the balance against its own copy, so together they
// can overpay. When they sync, the cloud accepts every payment (sync never drops one), gives
// each its AR-YYYY-NNNN receipt number, and the order shows "Overpaid" for the Owner.
// The cloud is a small scripted stand-in that records every query; the real receipt-number
// trigger and the real balance lock are tested on PostgreSQL in payments.pg.test.js.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { prepareDatabase, startTestServer } = require('./helpers/testServer');
const { syncOfflineData, getLastSync } = require('../services/sync');
const { sqliteRun, sqliteAll } = require('../services/records');

const flat = (sql) => sql.replace(/\s+/g, ' ').trim();
const unreachable = () => Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' });

const createScriptedCloud = () => {
  const queries = [];
  const payments = new Map(); // payment_id -> row, as the cloud stores it
  let receiptCounter = 0;
  const cloud = {
    offline: true,
    queries,
    payments,
    query: async (sql, params = []) => {
      if (cloud.offline) throw unreachable();
      const q = flat(sql);
      queries.push({ q, params });
      if (/^SELECT 1 FROM payments WHERE payment_id = \$1$/.test(q)) return { rows: [], rowCount: payments.has(params[0]) ? 1 : 0 };
      const insert = /^INSERT INTO payments \(([^)]+)\)/.exec(q);
      if (insert) {
        const cols = insert[1].split(',').map((c) => c.trim()).filter((c) => c !== 'last_modified');
        const row = Object.fromEntries(cols.map((c, i) => [c, params[i]]));
        // What the migration 008 trigger does: the cloud gives the number, whatever was sent
        row.receipt_no = `AR-2026-${String(++receiptCounter).padStart(4, '0')}`;
        payments.set(row.payment_id, row);
        return { rows: [], rowCount: 1 };
      }
      if (/^INSERT INTO /.test(q)) return { rows: [], rowCount: 1 };
      if (/AS version, receipt_no::text AS receipt_no FROM payments WHERE payment_id = \$1$/.test(q)) {
        const row = payments.get(params[0]);
        return { rows: [{ version: '2026-10-30T08:00:00.000001', receipt_no: row ? row.receipt_no : null }], rowCount: 1 };
      }
      if (/^SELECT payment_id::text AS payment_id, .* FROM payments$/.test(q)) {
        // Refresh: every branch's payments come back down to this computer
        return {
          rows: [...payments.values()].map((p) => ({
            payment_id: p.payment_id, order_id: p.order_id, amount: String(p.amount), payment_date: String(p.payment_date),
            payment_type: p.payment_type, received_by: p.received_by || null, receipt_no: p.receipt_no, version: '2026-10-30T08:00:00.000001'
          })),
          rowCount: payments.size
        };
      }
      if (/AS version FROM \w+ WHERE \w+ = \$1$/.test(q)) return { rows: [{ version: '2026-10-30T08:00:00.000001' }], rowCount: 1 };
      return { rows: [], rowCount: 0 }; // other refresh reads: nothing new
    },
    connect: async () => {
      if (cloud.offline) throw unreachable();
      throw new Error('not used');
    }
  };
  return cloud;
};

// A branch computer: its own SQLite copy that already has the customer and the priced order
const prepareBranch = async (dir, name) => {
  const file = path.join(dir, `${name}.db`);
  const db = await prepareDatabase(file);
  await sqliteRun(db, "INSERT INTO customers (customer_id, full_name, sync_status) VALUES ('c-1', 'Agdao NHS', 'synced')");
  await sqliteRun(db,
    `INSERT INTO order_profiles (order_id, customer_id, production_deadline, production_status, total_quote_amount, tracking_no, sync_status, cloud_last_modified)
     VALUES ('o-1', 'c-1', '2026-11-10T00:00:00', 'Approved', 1000, 'XM-2026-0042', 'synced', '2026-10-29T08:00:00.000001')`);
  await new Promise((r) => db.close(r));
  return file;
};

describe('Sync: offline payments from two branches', () => {
  let dir;
  let cloud;
  let branchA;
  let branchB;

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaowusys-paysync-'));
    cloud = createScriptedCloud();
    branchA = await startTestServer({ dbPath: await prepareBranch(dir, 'branch-a'), pgPool: cloud });
    branchB = await startTestServer({ dbPath: await prepareBranch(dir, 'branch-b'), pgPool: cloud });
    await branchA.login('production');
    await branchB.login('admin');
  });
  after(async () => {
    await branchA.close();
    await branchB.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('lets each branch take a payment within its own copy of the balance while offline', async () => {
    const a = await branchA.request('POST', '/api/orders/o-1/payments', { token: branchA.tokens.production, body: { amount: 800, payment_type: 'Cash' } });
    assert.equal(a.status, 201, a.text);
    assert.equal(a.body.source, 'local');
    const b = await branchB.request('POST', '/api/orders/o-1/payments', { token: branchB.tokens.admin, body: { amount: 700, payment_type: 'GCash' } });
    assert.equal(b.status, 201, b.text);
    const tooMuch = await branchA.request('POST', '/api/orders/o-1/payments', { token: branchA.tokens.production, body: { amount: 200.01, payment_type: 'Cash' } });
    assert.equal(tooMuch.status, 409, 'offline, the cap still applies to what this branch can see');
    assert.equal(tooMuch.body.remaining, 200);
  });

  it('pushes the payments with no balance cap and no receipt number, and saves the number the cloud gave', async () => {
    cloud.offline = false;
    const summary = await syncOfflineData(cloud, branchA.localDb);
    assert.equal(summary.aborted, false);
    const insert = cloud.queries.find((x) => x.q.startsWith('INSERT INTO payments'));
    assert.ok(insert, 'the payment was pushed');
    assert.ok(!/receipt_no/.test(insert.q), 'this computer never sends a receipt number');
    assert.ok(!/WHERE|SELECT/.test(insert.q), 'no balance check on sync: a payment is never dropped');
    assert.match(insert.q, /\(payment_id, order_id, amount, payment_date, payment_type, received_by, last_modified\)/);
    assert.ok(insert.params.includes('u-production'), 'the receiver is pushed');
    assert.ok(cloud.queries.some((x) => /^SELECT 1 FROM payments WHERE payment_id = \$1$/.test(x.q)),
      'checks first, so a payment that is already in the cloud never uses up a number');

    const [row] = await sqliteAll(branchA.localDb, "SELECT receipt_no, sync_status, received_by FROM payments WHERE order_id = 'o-1'");
    assert.deepEqual([row.receipt_no, row.sync_status, row.received_by], ['AR-2026-0001', 'synced', 'u-production']);
    assert.equal(getLastSync().result, 'ok');
    assert.ok(getLastSync().at);
  });

  it('accepts the other branch too, so the order shows Overpaid for the Owner to refund', async () => {
    const summary = await syncOfflineData(cloud, branchB.localDb);
    assert.deepEqual([summary.aborted, summary.failed], [false, 0]);
    assert.equal(cloud.payments.size, 2, 'both payments are in the cloud');

    cloud.offline = true; // read branch B's copy, which the sync refreshed with branch A's payment
    const d = await branchB.request('GET', '/api/orders/o-1', { token: branchB.tokens.admin });
    assert.equal(d.status, 200, d.text);
    assert.deepEqual(d.body.payments.map((p) => [p.amount, p.receipt_no, p.sync_status]).sort(),
      [[700, 'AR-2026-0002', 'synced'], [800, 'AR-2026-0001', 'synced']]);
    assert.deepEqual([d.body.totals.payment_status, d.body.totals.total_paid, d.body.totals.overpaid_by, d.body.totals.remaining],
      ['Overpaid', 1500, 500, 0]);
    assert.equal(d.body.allowed_actions.record_payment, false);
  });

  it('does not count an aborted run as a sync', async () => {
    const before = getLastSync();
    await sqliteRun(branchA.localDb,
      "INSERT INTO payments (payment_id, order_id, amount, payment_type, sync_status) VALUES ('p-late', 'o-1', 1, 'Cash', 'pending_insert')");
    const summary = await syncOfflineData(cloud, branchA.localDb); // cloud still offline
    assert.equal(summary.aborted, true);
    assert.deepEqual(getLastSync(), { at: before.at, result: 'aborted' });
  });
});
