// PB 5 with the sync engine: an order edited offline whose cloud copy changed too is settled
// by rank (Owner > Admin > Production > Staff). The cloud is a small scripted stand-in that
// keeps one table of orders and an audit list, so this runs without PostgreSQL; the same
// rules run against real row locks and triggers in batch3.pg.test.js.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { prepareDatabase } = require('./helpers/testServer');
const { syncOfflineData, resolveConflict, describeConflicts, SYNC_TABLES } = require('../services/sync');
const { sqliteRun, sqliteGet } = require('../services/records');

const flat = (sql) => sql.replace(/\s+/g, ' ').trim();
const ORDER_COLUMNS = SYNC_TABLES.find((t) => t.table === 'order_profiles').columns;

const createScriptedCloud = () => {
  const orders = new Map();
  const audits = [];
  const log = [];
  let tick = 0;
  const nextVersion = () => `2026-11-14T08:00:00.${String(++tick).padStart(6, '0')}`;
  const cloud = {
    orders, audits, log,
    put: (row) => orders.set(row.order_id, {
      customer_id: 'c-1', production_status: 'Pending', total_quote_amount: '1000.00', stock_reserved: 'false',
      date_created: '2026-11-01 00:00:00', subtotal_amount: '0.00', discount_amount: '0.00', // NOT NULL DEFAULT 0 (migration 011)
      ...row, version: nextVersion()
    }),
    query: async (sql, params = []) => {
      const q = flat(sql);
      log.push(q);
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(q)) return { rows: [], rowCount: 0 };
      // Both kinds of push: "SET a = $1, b = $2, last_modified = NOW() WHERE order_id = $3 AND <version check on $4>"
      const update = /^UPDATE order_profiles SET (.+), last_modified = NOW\(\) WHERE order_id = /.exec(q);
      if (update) {
        const cols = update[1].split(',').map((c) => c.trim().split(' ')[0]);
        const row = orders.get(params[cols.length]);
        const baseline = params[cols.length + 1];
        if (!row || (baseline !== null && baseline !== row.version)) return { rows: [], rowCount: 0 };
        cols.forEach((c, i) => { row[c] = params[i]; });
        row.version = nextVersion();
        return { rows: [{ version: row.version, tracking_no: row.tracking_no }], rowCount: 1 };
      }
      if (/^INSERT INTO audit_log /.test(q)) {
        audits.push({ entity: params[1], entity_id: params[2], action: params[3], details: JSON.parse(params[4]), performed_by: params[5], performed_role: params[6] });
        return { rows: [], rowCount: 1 };
      }
      if (/ FROM order_profiles WHERE order_id = \$1$/.test(q)) {
        const row = orders.get(params[0]);
        return row ? { rows: [{ ...row }], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      if (/ FROM order_profiles( WHERE order_id = ANY\(\$1::text\[\]\))?$/.test(q)) {
        const wanted = [...orders.values()].filter((o) => !params[0] || params[0].includes(o.order_id));
        return { rows: wanted.map((o) => ({ ...Object.fromEntries(ORDER_COLUMNS.map((c) => [c, o[c] ?? null])), version: o.version })), rowCount: wanted.length };
      }
      return { rows: [], rowCount: 0 }; // other refresh reads: nothing new in the cloud
    },
    connect: async () => ({ query: (sql, params) => cloud.query(sql, params), release: () => {} })
  };
  return cloud;
};

describe('Sync: an order changed offline and online is settled by rank', () => {
  let dir;
  let db;
  let cloud;

  const CLOUD_DAY = '2026-12-01 00:00:00';
  const offlineEdit = (id, role, user, deadline) => sqliteRun(db,
    `INSERT INTO order_profiles (order_id, customer_id, production_deadline, production_status, total_quote_amount, tracking_no,
                                 last_edited_by, last_edited_role, sync_status, dirty_fields, cloud_last_modified, last_modified)
     VALUES (?, 'c-1', ?, 'Pending', 1000, ?, ?, ?, 'pending_update', '["production_deadline","last_edited_by","last_edited_role"]',
             'what-this-computer-last-saw', '2026-11-10 01:00:00.000')`,
    [id, deadline, cloud.orders.get(id).tracking_no, user, role]);
  const local = (id) => sqliteGet(db,
    'SELECT production_deadline, production_status, sync_status, sync_conflict, dirty_fields, last_edited_role FROM order_profiles WHERE order_id = ?', [id]);

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaowusys-conflict-'));
    db = await prepareDatabase(path.join(dir, 'cache.db'));
    await sqliteRun(db, "INSERT INTO customers (customer_id, full_name, sync_status) VALUES ('c-1', 'Agdao NHS', 'synced')");
    cloud = createScriptedCloud();
    cloud.put({ order_id: 'o-win', tracking_no: 'XM-2026-0001', production_deadline: CLOUD_DAY, last_edited_by: 'u-production', last_edited_role: 'Production' });
    cloud.put({ order_id: 'o-lose', tracking_no: 'XM-2026-0002', production_deadline: CLOUD_DAY, last_edited_by: 'u-owner', last_edited_role: 'Owner' });
    cloud.put({ order_id: 'o-equal', tracking_no: 'XM-2026-0003', production_deadline: CLOUD_DAY, last_edited_by: 'u-admin', last_edited_role: 'Admin' });
    cloud.put({ order_id: 'o-done', tracking_no: 'XM-2026-0004', production_deadline: CLOUD_DAY, production_status: 'Cancelled', last_edited_by: 'u-production', last_edited_role: 'Production' });
    await offlineEdit('o-win', 'Admin', 'u-admin', '2026-12-10T00:00:00');
    await offlineEdit('o-lose', 'Admin', 'u-admin', '2026-12-11T00:00:00');
    await offlineEdit('o-equal', 'Admin', 'u-admin2', '2026-12-12T00:00:00');
    await offlineEdit('o-done', 'Owner', 'u-owner', '2026-12-13T00:00:00');
  });
  after(async () => {
    await new Promise((r) => db.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('keeps the higher rank’s change, records the other, and leaves equal ranks for a person', async () => {
    const summary = await syncOfflineData(cloud, db);
    assert.deepEqual([summary.aborted, summary.failed], [false, 0]);

    // Offline Admin over cloud Production: applied, with the audit row inside the same transaction
    assert.deepEqual([cloud.orders.get('o-win').production_deadline, cloud.orders.get('o-win').last_edited_by, cloud.orders.get('o-win').last_edited_role],
      ['2026-12-10T00:00:00', 'u-admin', 'Admin']);
    const applied = cloud.audits.find((a) => a.entity_id === 'o-win');
    assert.deepEqual([applied.entity, applied.action, applied.performed_by, applied.performed_role],
      ['order_profiles', 'offline_conflict_local_applied', 'u-admin', 'Admin']);
    assert.deepEqual([applied.details.before.production_deadline, applied.details.after.production_deadline], [CLOUD_DAY, '2026-12-10T00:00:00']);
    const auditAt = cloud.log.findIndex((q) => q.startsWith('INSERT INTO audit_log'));
    assert.deepEqual([cloud.log[auditAt - 2], cloud.log[auditAt + 1]], ['BEGIN', 'COMMIT'], 'the change and its audit row are one transaction');
    assert.deepEqual([(await local('o-win')).sync_status, (await local('o-win')).sync_conflict], ['synced', null]);

    // Offline Admin under cloud Owner: the cloud row is kept and copied down; the edit is in the trail
    assert.equal(cloud.orders.get('o-lose').production_deadline, CLOUD_DAY);
    const dropped = cloud.audits.find((a) => a.entity_id === 'o-lose');
    assert.deepEqual([dropped.action, dropped.performed_by, dropped.details.discarded.production_deadline, dropped.details.kept.production_deadline],
      ['offline_conflict_local_discarded', 'u-admin', '2026-12-11T00:00:00', CLOUD_DAY]);
    assert.deepEqual(await local('o-lose'), {
      production_deadline: CLOUD_DAY, production_status: 'Pending', sync_status: 'synced', sync_conflict: null, dirty_fields: null, last_edited_role: 'Owner'
    });

    // Admin against Admin: nobody wins automatically
    assert.equal(cloud.orders.get('o-equal').production_deadline, CLOUD_DAY);
    assert.ok((await local('o-equal')).sync_conflict);
    assert.equal((await local('o-equal')).production_deadline, '2026-12-12T00:00:00', 'the offline change is kept until someone decides');
    assert.ok(!cloud.audits.some((a) => a.entity_id === 'o-equal'));
    assert.deepEqual(summary.conflicts.map((c) => c.id), ['o-equal']);

    // The Owner outranks, but the order was cancelled meanwhile: a closed order is not edited
    assert.equal(cloud.orders.get('o-done').production_deadline, CLOUD_DAY);
    assert.equal(cloud.audits.find((a) => a.entity_id === 'o-done').action, 'offline_conflict_local_discarded');
    assert.deepEqual([(await local('o-done')).production_status, (await local('o-done')).sync_conflict], ['Cancelled', null]);

    assert.deepEqual(summary.resolved.map((r) => [r.id, r.winner, r.notify_user, r.by_role, r.tracking_no]).sort(), [
      ['o-done', 'cloud', 'u-owner', 'Production', 'XM-2026-0004'],
      ['o-lose', 'cloud', 'u-admin', 'Owner', 'XM-2026-0002'],
      ['o-win', 'local', 'u-production', 'Admin', 'XM-2026-0001']
    ]);
    assert.equal(summary.unresolved_conflicts, 1);
  });

  it('describes the waiting conflict in plain words, without ids or column names', async () => {
    const [conflict] = await describeConflicts(db);
    assert.deepEqual([conflict.title, conflict.changed, conflict.keep_local_blocked_reason], ['Order XM-2026-0003', ['Production deadline'], null]);
  });

  it('settles the equal-rank conflict by hand and writes who decided', async () => {
    const actor = { user_id: 'u-owner', role: 'Owner' };
    const done = await resolveConflict(cloud, db, { table: 'order_profiles', id: 'o-equal', keep: 'local', actor });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.deepEqual([done.body.kept, done.body.conflicts_remaining], ['local', 0]);
    assert.deepEqual([cloud.orders.get('o-equal').production_deadline, cloud.orders.get('o-equal').last_edited_role], ['2026-12-12T00:00:00', 'Owner']);
    const trail = cloud.audits.filter((a) => a.entity_id === 'o-equal');
    assert.deepEqual(trail.map((a) => [a.action, a.performed_by]), [['conflict_resolved_keep_local', 'u-owner']]);
    assert.deepEqual([(await local('o-equal')).sync_status, (await local('o-equal')).sync_conflict], ['synced', null]);

    const again = await resolveConflict(cloud, db, { table: 'order_profiles', id: 'o-equal', keep: 'cloud', actor });
    assert.deepEqual([again.status, again.body.error], [404, 'CONFLICT_NOT_FOUND']);
    const before = cloud.audits.length;
    assert.deepEqual((await syncOfflineData(cloud, db)).resolved, [], 'nothing left to argue about');
    assert.equal(cloud.audits.length, before);
  });
});
