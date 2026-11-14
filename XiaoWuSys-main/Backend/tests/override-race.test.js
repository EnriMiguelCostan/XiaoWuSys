// PB 5: the Owner-override race. An Admin's save meets a conflict whose last editor is a
// Production account, so the 409 check says the Admin may replace it (can_override). Between that
// check and the row lock inside the override transaction, an Owner's edit lands on the order.
// The rank is checked again on the locked row, so the override is refused and nothing is written.
// The cloud is a small scripted stand-in that records every query; batch3.pg.test.js runs the
// non-racing override paths on real PostgreSQL.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { startTestServer, shopDate } = require('./helpers/testServer');

const flat = (sql) => sql.replace(/\s+/g, ' ').trim();

const createRacingCloud = () => {
  const row = {
    order_id: 'o-race', customer_id: 'c-1', date_created: '2026-11-01T00:00:00', production_deadline: '2026-12-20T00:00:00',
    production_status: 'Pending', design_drive_link: null, total_quote_amount: '1000.00', stock_reserved: false,
    approved_by: null, approved_at: null, tracking_no: 'XM-2026-0042',
    last_edited_by: 'u-production', last_edited_role: 'Production',
    version: '2026-11-14T08:00:00.000002', sync_status: 'synced', sync_conflict: null
  };
  const log = [];
  const cloud = {
    row,
    log,
    query: async (sql, params = []) => {
      const q = flat(sql);
      log.push(q);
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(q)) return { rows: [], rowCount: 0 };
      if (/ FROM order_profiles WHERE order_id = \$1 FOR UPDATE$/.test(q)) {
        // The race: the Owner's edit committed after the conflict read and before this lock
        Object.assign(row, { last_edited_by: 'u-owner', last_edited_role: 'Owner', production_deadline: '2026-12-25T00:00:00',
          version: '2026-11-14T08:00:00.000003' });
        return { rows: [{ ...row }], rowCount: 1 };
      }
      // The first save: the version this screen saw is stale, so the guarded UPDATE matches nothing
      if (/^UPDATE order_profiles SET production_deadline = \$1, last_edited_by = \$4/.test(q)) return { rows: [], rowCount: 0 };
      // Only reached if the override went ahead (the mutation check): apply it
      if (/^UPDATE order_profiles SET production_deadline = \$2/.test(q)) {
        Object.assign(row, { production_deadline: params[1], last_edited_by: params[2], last_edited_role: params[3] });
        return { rows: [{ ...row }], rowCount: 1 };
      }
      if (/^INSERT INTO audit_log /.test(q)) return { rows: [], rowCount: 1 };
      if (/ FROM order_profiles WHERE order_id = \$1 ORDER BY /.test(q)) return { rows: [{ ...row }], rowCount: 1 };
      return { rows: [], rowCount: 0 }; // session lists at start-up: nothing revoked
    },
    connect: async () => ({ query: (sql, params) => cloud.query(sql, params), release: () => {} })
  };
  return cloud;
};

describe('Owner override: the rank is checked again on the locked row', () => {
  let t;
  let cloud;
  // A login token like the one POST /api/auth/login issues (the cloud stand-in has no accounts table)
  const tokenFor = (user_id, role) => jwt.sign({ user_id, role, ims: Date.now(), sid: crypto.randomUUID() }, process.env.JWT_SECRET, { expiresIn: '1h' });

  before(async () => {
    cloud = createRacingCloud();
    t = await startTestServer({ pgPool: cloud, cloudHealth: { state: () => 'reachable', since: () => Date.now() } });
  });
  after(async () => { await t.close(); });

  it('refuses the override when an Owner’s edit lands between the conflict check and the lock', async () => {
    const r = await t.request('PATCH', '/api/orders/o-race/details', {
      token: tokenFor('u-admin', 'Admin'),
      body: { production_deadline: shopDate(40), expected_version: '2026-11-14T08:00:00.000001', override: true }
    });
    assert.equal(r.status, 403, r.text);
    assert.equal(r.body.error, 'OVERRIDE_NOT_ALLOWED');
    assert.deepEqual([r.body.current.last_edited_role, r.body.current.version], ['Owner', '2026-11-14T08:00:00.000003'],
      'the answer shows the order as it is now');

    // The pre-check did pass (so this really is the race), and then nothing was written
    const lockAt = cloud.log.findIndex((q) => / FOR UPDATE$/.test(q));
    assert.ok(lockAt > 0, 'the override transaction was started');
    assert.equal(cloud.log[lockAt - 1], 'BEGIN');
    assert.equal(cloud.log[lockAt + 1], 'ROLLBACK');
    assert.ok(!cloud.log.some((q) => /^UPDATE order_profiles SET production_deadline = \$2/.test(q)), 'the order was not changed');
    assert.ok(!cloud.log.some((q) => q.startsWith('INSERT INTO audit_log')), 'no audit row for an override that did not happen');
    assert.deepEqual([cloud.row.last_edited_role, cloud.row.production_deadline], ['Owner', '2026-12-25T00:00:00'], 'the Owner’s edit stands');
    assert.deepEqual([t.orderEvents.overridden, t.orderEvents.updated], [[], []], 'nobody is told about a change that did not happen');
  });
});
