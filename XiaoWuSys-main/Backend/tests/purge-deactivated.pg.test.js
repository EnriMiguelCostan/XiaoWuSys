// npm run purge:deactivated on a real PostgreSQL: the deactivated accounts are deleted, every
// record they were named on now names an active account (with the matching role), the trails'
// triggers are back on, and the app still reads everything.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pgTarget, resetDatabase, startPgTestServer } = require('./helpers/pgTestServer');
const { generateHistory } = require('../scripts/history/generate');
const { loadHistory } = require('../scripts/history/load');
const { purgeDeactivated, describePurge, findUserColumns } = require('../scripts/accounts/purge');
const { checkCloudSchema } = require('../services/schemaCheck');

const { url, skip } = pgTarget();
const GONE = ['u-staff-old', 'u-prod-old'];

describe('Deleting deactivated accounts on real PostgreSQL', { skip }, () => {
  let pool;
  let server;
  let before_;

  before(async () => {
    const { Pool } = require('pg');
    pool = new Pool({ connectionString: url, max: 8 });
    await resetDatabase(pool);
    await pool.query(`INSERT INTO users (user_id, username, password_hash, role, is_active) VALUES
      ('u-owner', 'owner', 'x', 'Owner', TRUE), ('u-admin', 'admin', 'x', 'Admin', TRUE), ('u-staff', 'staff', 'x', 'Staff', TRUE),
      ('u-staff-old', 'staff-old', 'x', 'Staff', FALSE), ('u-prod-old', 'prod-old', 'x', 'Production', FALSE)`);
    // A history made while the old accounts still counted (as the first demo load did)
    const users = (await pool.query('SELECT user_id, role FROM users ORDER BY user_id')).rows;
    await loadHistory(pool, generateHistory({ users, now: new Date(), start: '2025-09-01' }));
    await pool.query(`INSERT INTO audit_log (audit_id, entity, entity_id, action, details, performed_by, performed_role) VALUES
      ('a-about', 'users', 'u-staff-old', 'account_deactivated', '{}', 'u-admin', 'Admin'),
      ('a-detail', 'order_profiles', 'x', 'test', '{"before":{"last_edited_by":"u-prod-old"}}', 'u-prod-old', 'Production')`);
    await pool.query("INSERT INTO revoked_sessions (session_id, user_id, expires_at) VALUES ('s1', 'u-staff-old', NOW() + INTERVAL '1 day')");
    before_ = await describePurge(pool);
    await purgeDeactivated(pool);
    server = await startPgTestServer(pool);
  });
  after(async () => {
    if (server) await server.close();
    if (pool) await pool.end();
  });

  it('saw the old accounts on the records before', () => {
    assert.deepEqual(before_.inactive.map((u) => u.user_id).sort(), [...GONE].sort());
    assert.ok(before_.references.length > 3, JSON.stringify(before_.references));
    assert.equal(before_.plan.find((p) => p.old_id === 'u-prod-old').role, 'Admin');
  });

  it('deletes only the deactivated accounts', async () => {
    const ids = (await pool.query('SELECT user_id FROM users ORDER BY user_id')).rows.map((r) => r.user_id);
    assert.deepEqual(ids, ['u-admin', 'u-owner', 'u-staff']);
    assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM revoked_sessions')).rows[0].n, 0);
    assert.equal((await pool.query("SELECT COUNT(*)::int AS n FROM audit_log WHERE audit_id = 'a-about'")).rows[0].n, 0);
  });

  it('every record names an active account, with that account\'s role', async () => {
    const active = new Map((await pool.query('SELECT user_id, role FROM users')).rows.map((u) => [u.user_id, u.role]));
    for (const c of await findUserColumns(pool)) {
      const { rows } = await pool.query(
        `SELECT "${c.column}" AS id${c.roleColumn ? `, "${c.roleColumn}" AS role` : ''} FROM "${c.table}" WHERE "${c.column}" IS NOT NULL`);
      for (const r of rows) {
        assert.ok(active.has(r.id), `${c.table}.${c.column} = ${r.id}`);
        if (c.roleColumn && r.role !== null) assert.equal(r.role, active.get(r.id), `${c.table}.${c.roleColumn}`);
      }
    }
    const detail = (await pool.query("SELECT details FROM audit_log WHERE audit_id = 'a-detail'")).rows[0].details;
    assert.ok(!detail.includes('u-prod-old') && /"u-(owner|admin)"/.test(detail), detail);
  });

  it('switches the trail triggers back on and passes the schema check', async () => {
    const off = await pool.query(`SELECT tgrelid::regclass::text AS t, tgname FROM pg_trigger WHERE NOT tgisinternal AND tgenabled = 'D'`);
    assert.deepEqual(off.rows, []);
    await assert.rejects(pool.query("UPDATE audit_log SET action = 'x' WHERE audit_id = 'a-detail'"));
    assert.equal((await checkCloudSchema(pool)).ok, true);
  });

  it('is still read by the app', async () => {
    const owner = server.tokenFor('u-owner', 'Owner');
    for (const path of ['/api/orders?limit=20', '/api/stock/movements?limit=20', '/api/reports/transactions?month=2025-10', '/api/auth/users']) {
      const r = await server.request('GET', path, { token: owner });
      assert.equal(r.status, 200, `${path}: ${r.text.slice(0, 200)}`);
    }
  });

  it('does nothing when no account is deactivated', async () => {
    assert.deepEqual(await purgeDeactivated(pool), { deleted: 0, updated: 0 });
  });
});
