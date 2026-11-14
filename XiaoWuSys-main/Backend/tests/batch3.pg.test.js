// ==========================================
// BATCH 3 ON A REAL POSTGRESQL DATABASE (PB 5, PB 14: migrations 009 and 010)
// Runs only when TEST_DATABASE_URL is set (CI starts a throw-away PostgreSQL for it). The
// database is WIPED first: localhost or a database whose name contains "test" only, never Neon.
//
// Checks: 009 and 010 apply to an existing shop database and are safe to run twice; the
// status CHECK takes 'Pressing'; audit_log and order_status_history cannot be edited or
// deleted; every status change and approval writes exactly one history row in its own
// transaction; "orders_changed" is only heard after COMMIT; a higher rank replaces a lower
// rank's conflicting edit (with its audit row) and nobody else can; an offline edit that
// clashes with a cloud edit is settled by rank when it syncs; and an Owner / Admin settles
// the equal-rank ones by hand.
// ==========================================
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pgTarget, resetDatabase, startPgTestServer, readMigration } = require('./helpers/pgTestServer');
const { shopDate } = require('./helpers/testServer');
const { sqliteRun, sqliteGet } = require('../services/records');

const { url, skip } = pgTarget();
const FILES = ['009_conflict_override_and_audit.sql', '010_pressing_status_and_history.sql'];

describe('Batch 3 on real PostgreSQL: override, Pressing, history, rank sync', { skip }, () => {
  let pool;
  let server;
  let owner; let admin; let production; let staff;

  const insertOrder = (id, { status = 'Pending', quote = 1000, deadline = `${shopDate(20)} 00:00:00`, editor = null } = {}) => pool.query(
    `INSERT INTO order_profiles (order_id, customer_id, production_deadline, production_status, total_quote_amount, last_edited_by, last_edited_role)
     VALUES ($1, 'c-1', $2, $3, $4, $5, $6)`, [id, deadline, status, quote, editor && editor[0], editor && editor[1]]);
  const cloudOrder = async (id) => (await pool.query(
    `SELECT production_status, to_char(production_deadline, 'YYYY-MM-DD') AS deadline, total_quote_amount::text AS quote,
            last_edited_by, last_edited_role, stock_reserved FROM order_profiles WHERE order_id = $1`, [id])).rows[0];
  const history = async (id) => (await pool.query(
    'SELECT from_status, to_status, changed_by, changed_role FROM order_status_history WHERE order_id = $1 ORDER BY changed_at, history_id', [id])).rows;
  const audits = async (id) => (await pool.query(
    'SELECT action, details, performed_by, performed_role FROM audit_log WHERE entity_id = $1 ORDER BY created_at, audit_id', [id]))
    .rows.map((r) => ({ ...r, details: JSON.parse(r.details) }));
  const detail = (id, token = owner) => server.request('GET', `/api/orders/${id}`, { token });
  const setStatus = (id, status, token = production, extra = {}) =>
    server.request('PATCH', `/api/orders/${id}/status`, { token, body: { status, ...extra } });
  const editDeadline = (id, days, token, extra = {}) =>
    server.request('PATCH', `/api/orders/${id}/details`, { token, body: { production_deadline: shopDate(days), ...extra } });

  before(async () => {
    const { Pool } = require('pg'); // only needed when this suite runs
    pool = new Pool({ connectionString: url, max: 8 });
    // An existing shop database: everything up to 008, with orders already in it
    await resetDatabase(pool, { before: '009' });
    await pool.query(`INSERT INTO users (user_id, username, password_hash, role) VALUES
      ('u-owner', 'owner', 'x', 'Owner'), ('u-admin', 'admin', 'x', 'Admin'),
      ('u-production', 'production', 'x', 'Production'), ('u-staff', 'staff', 'x', 'Staff')`);
    await pool.query("INSERT INTO customers (customer_id, full_name) VALUES ('c-1', 'Agdao NHS')");
    await pool.query(`INSERT INTO inventory_items (inventory_id, item_name, item_category, quantity_available, unit_cost)
                      VALUES ('i-shirt', 'Custom Shirt', 'Apparel', 100, 150)`);
    await pool.query(`INSERT INTO order_profiles (order_id, customer_id, production_deadline, production_status, total_quote_amount)
                      VALUES ('o-old', 'c-1', '2030-12-31 00:00:00', 'Printing', 500)`);
  });
  after(async () => {
    if (server) await server.close();
    if (pool) await pool.end();
  });

  it('applies migrations 009 and 010, and running them again changes nothing', async () => {
    const { applyPendingMigrations } = require('../services/migrations');
    const first = await applyPendingMigrations(pool, { log: () => {} });
    for (const file of FILES) assert.ok(first.applied.includes(file), JSON.stringify(first.applied));
    assert.deepEqual((await applyPendingMigrations(pool, { log: () => {} })).applied, []);
    for (const file of FILES) await pool.query(readMigration(file)); // pasted again by hand
    for (const file of FILES) await pool.query(readMigration(file));

    const old = await pool.query("SELECT production_status, last_edited_by, last_edited_role, tracking_no FROM order_profiles WHERE order_id = 'o-old'");
    assert.deepEqual([old.rows[0].production_status, old.rows[0].last_edited_by, old.rows[0].last_edited_role], ['Printing', null, null],
      'existing orders keep their values; the last editor is simply unknown');
    assert.match(old.rows[0].tracking_no, /^XM-\d{4}-\d{4}$/);
    const checks = await pool.query(
      `SELECT conname, convalidated FROM pg_constraint
        WHERE conrelid = 'order_profiles'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%production_status%'`);
    assert.deepEqual(checks.rows, [{ conname: 'order_profiles_production_status_check', convalidated: true }], 'exactly one status CHECK, validated');
  });

  it("accepts 'Pressing' and still refuses a status that does not exist", async () => {
    await pool.query("UPDATE order_profiles SET production_status = 'Pressing' WHERE order_id = 'o-old'");
    await assert.rejects(pool.query("UPDATE order_profiles SET production_status = 'Ironing' WHERE order_id = 'o-old'"), { code: '23514' });
    assert.equal((await cloudOrder('o-old')).production_status, 'Pressing');
  });

  it('never lets an audit row or a history row be edited or deleted', async () => {
    await pool.query(`INSERT INTO audit_log (audit_id, entity, entity_id, action, details) VALUES ('a-1', 'order_profiles', 'o-old', 'conflict_override', '{}')`);
    await pool.query(`INSERT INTO order_status_history (history_id, order_id, from_status, to_status) VALUES ('h-1', 'o-old', 'Printing', 'Pressing')`);
    await assert.rejects(pool.query("UPDATE audit_log SET action = 'nothing' WHERE audit_id = 'a-1'"), /audit_log is append-only/);
    await assert.rejects(pool.query("DELETE FROM audit_log WHERE audit_id = 'a-1'"), /audit_log is append-only/);
    await assert.rejects(pool.query("UPDATE order_status_history SET to_status = 'Completed' WHERE history_id = 'h-1'"), /order_status_history is append-only/);
    await assert.rejects(pool.query("DELETE FROM order_status_history WHERE order_id = 'o-old'"), /order_status_history is append-only/);
    // The older inventory trail keeps its protection (and its message) after 009 replaced the function
    await pool.query(`INSERT INTO inventory_audit_log (audit_id, inventory_id, action) VALUES ('ia-1', 'i-shirt', 'created')`);
    await assert.rejects(pool.query("DELETE FROM inventory_audit_log WHERE audit_id = 'ia-1'"), /inventory_audit_log is append-only/);
    const kept = await pool.query('SELECT (SELECT COUNT(*) FROM audit_log)::int AS a, (SELECT COUNT(*) FROM order_status_history)::int AS h');
    assert.deepEqual(kept.rows[0], { a: 1, h: 1 });
  });

  it('writes one history row per approval and status change, through Pressing to Completed', async () => {
    server = await startPgTestServer(pool);
    owner = server.tokenFor('u-owner', 'Owner');
    admin = server.tokenFor('u-admin', 'Admin');
    production = server.tokenFor('u-production', 'Production');
    staff = server.tokenFor('u-staff', 'Staff');

    await insertOrder('o-shirts');
    await pool.query(`INSERT INTO order_items (line_item_id, order_id, inventory_id, product_type, quantity) VALUES ('l-1', 'o-shirts', 'i-shirt', 'Custom Shirt', 10)`);
    await pool.query(`INSERT INTO payments (payment_id, order_id, amount, payment_type) VALUES ('p-1', 'o-shirts', 500, 'Cash')`);

    const loaded = await detail('o-shirts');
    assert.equal(loaded.status, 200, loaded.text);
    assert.deepEqual(loaded.body.status_history, []);
    const approved = await server.request('POST', '/api/orders/o-shirts/approve', { token: owner, body: { expected_version: loaded.body.order.version } });
    assert.equal(approved.status, 200, approved.text);
    assert.deepEqual([approved.body.order.last_edited_by, approved.body.order.last_edited_role], ['u-owner', 'Owner']);

    const eventsBefore = server.orderEvents.updated.length;
    assert.equal((await setStatus('o-shirts', 'Printing')).status, 200);
    const afterPrinting = await detail('o-shirts', production);
    assert.deepEqual(afterPrinting.body.allowed_actions.statuses, ['Pressing', 'Completed'], 'both next steps are offered');

    const skipBack = await setStatus('o-shirts', 'Approved');
    assert.equal(skipBack.status, 409);
    const pressing = await setStatus('o-shirts', 'Pressing');
    assert.equal(pressing.status, 200, pressing.text);
    assert.deepEqual([pressing.body.order.production_status, pressing.body.stock_changes], ['Pressing', []], 'pressing moves no stock');
    const backwards = await setStatus('o-shirts', 'Printing');
    assert.deepEqual([backwards.status, backwards.body.error, backwards.body.allowed], [409, 'INVALID_STATUS_TRANSITION', ['Completed', 'Cancelled']]);
    const done = await setStatus('o-shirts', 'Completed', admin);
    assert.equal(done.status, 200, done.text);
    assert.equal(done.body.order.deadline_flag, null);

    assert.deepEqual(await history('o-shirts'), [
      { from_status: 'Pending', to_status: 'Approved', changed_by: 'u-owner', changed_role: 'Owner' },
      { from_status: 'Approved', to_status: 'Printing', changed_by: 'u-production', changed_role: 'Production' },
      { from_status: 'Printing', to_status: 'Pressing', changed_by: 'u-production', changed_role: 'Production' },
      { from_status: 'Pressing', to_status: 'Completed', changed_by: 'u-admin', changed_role: 'Admin' }
    ], 'the two refused moves wrote nothing');
    assert.deepEqual(server.orderEvents.updated.slice(eventsBefore).map((o) => o.production_status), ['Printing', 'Pressing', 'Completed']);

    const shown = await detail('o-shirts', staff);
    assert.deepEqual(shown.body.status_history.map((h) => [h.from_status, h.to_status, h.changed_by_name, h.changed_role]), [
      ['Pending', 'Approved', 'owner', 'Owner'], ['Approved', 'Printing', 'production', 'Production'],
      ['Printing', 'Pressing', 'production', 'Production'], ['Pressing', 'Completed', 'admin', 'Admin']
    ]);
    assert.match(shown.body.status_history[0].changed_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
    assert.ok(!('changed_by' in shown.body.status_history[0]), 'names, not account ids');
    const stock = await pool.query("SELECT quantity_available, quantity_reserved FROM inventory_items WHERE inventory_id = 'i-shirt'");
    assert.deepEqual(stock.rows[0], { quantity_available: 90, quantity_reserved: 0 }, 'completing after pressing uses up the stock once');
  });

  it('lets an order that is not pressed go from Printing straight to Completed', async () => {
    await insertOrder('o-tarp', { status: 'Printing' });
    const done = await setStatus('o-tarp', 'Completed');
    assert.equal(done.status, 200, done.text);
    assert.deepEqual(await history('o-tarp'), [{ from_status: 'Printing', to_status: 'Completed', changed_by: 'u-production', changed_role: 'Production' }]);
  });

  it('rolls the history row back together with a status change that fails', async () => {
    await insertOrder('o-short', { status: 'Printing' });
    await pool.query("UPDATE order_profiles SET stock_reserved = TRUE WHERE order_id = 'o-short'");
    await pool.query(`INSERT INTO order_items (line_item_id, order_id, inventory_id, product_type, quantity) VALUES ('l-2', 'o-short', 'i-shirt', 'Custom Shirt', 5000)`);
    const r = await setStatus('o-short', 'Completed');
    assert.deepEqual([r.status, r.body.error], [409, 'INSUFFICIENT_STOCK']);
    assert.deepEqual(await history('o-short'), []);
    assert.equal((await cloudOrder('o-short')).production_status, 'Printing');
  });

  it('announces an order change to the other branches only after COMMIT', async () => {
    const listener = await pool.connect();
    const heard = [];
    listener.on('notification', (msg) => heard.push(JSON.parse(msg.payload)));
    const writer = await pool.connect();
    try {
      await listener.query('LISTEN orders_changed');
      await insertOrder('o-live', { status: 'Printing' });
      await new Promise((r) => setTimeout(r, 150));
      heard.length = 0;

      await writer.query('BEGIN');
      await writer.query("UPDATE order_profiles SET production_status = 'Pressing' WHERE order_id = 'o-live'");
      await listener.query('SELECT 1');
      await new Promise((r) => setTimeout(r, 150));
      assert.deepEqual(heard, [], 'nothing is announced while the change can still be rolled back');
      await writer.query('ROLLBACK');
      await listener.query('SELECT 1');
      await new Promise((r) => setTimeout(r, 150));
      assert.deepEqual(heard, [], 'a rolled-back change is never announced');

      const done = await setStatus('o-live', 'Pressing');
      assert.equal(done.status, 200, done.text);
      await listener.query('SELECT 1');
      await new Promise((r) => setTimeout(r, 150));
      const mine = heard.filter((n) => n.order_id === 'o-live');
      assert.equal(mine.length, 1);
      assert.deepEqual(mine[0], {
        order_id: 'o-live', op: 'UPDATE', tracking_no: done.body.order.tracking_no, production_status: 'Pressing', version: done.body.order.version
      }, 'the same version text the API returns, so a screen can tell it already has it');

      heard.length = 0;
      await pool.query("UPDATE order_profiles SET production_status = 'Pressing' WHERE order_id = 'o-live'"); // same values
      await listener.query('SELECT 1');
      await new Promise((r) => setTimeout(r, 150));
      assert.deepEqual(heard, [], 'a write that changes nothing is not announced');
    } finally {
      await listener.query('UNLISTEN *').catch(() => {});
      listener.removeAllListeners('notification');
      listener.release();
      writer.release();
    }
  });

  it('tells a lower or equal rank to reload, and never lets it force its change', async () => {
    await insertOrder('o-edit');
    const stale = (await detail('o-edit')).body.order.version;
    const byAdmin = await editDeadline('o-edit', 25, admin, { expected_version: stale });
    assert.equal(byAdmin.status, 200, byAdmin.text);
    assert.deepEqual([byAdmin.body.order.last_edited_by, byAdmin.body.order.last_edited_role, byAdmin.body.overridden], ['u-admin', 'Admin', false]);

    const lower = await editDeadline('o-edit', 30, production, { expected_version: stale });
    assert.deepEqual([lower.status, lower.body.error, lower.body.can_override], [409, 'EDIT_CONFLICT', false]);
    const forced = await editDeadline('o-edit', 30, production, { expected_version: stale, override: true });
    assert.deepEqual([forced.status, forced.body.error, forced.body.can_override], [409, 'EDIT_CONFLICT', false], 'override: true is ignored without the rank');
    const equal = await editDeadline('o-edit', 30, admin, { expected_version: stale, override: true });
    assert.deepEqual([equal.status, equal.body.can_override], [409, false], 'an equal rank never wins automatically');
    const noRole = await editDeadline('o-edit', 30, staff, { expected_version: stale, override: true });
    assert.equal(noRole.status, 403, 'Staff cannot edit orders at all');

    assert.equal((await cloudOrder('o-edit')).deadline, shopDate(25), 'the Admin’s change is untouched');
    assert.deepEqual(await audits('o-edit'), []);
    assert.deepEqual(server.orderEvents.overridden, []);
    server.stale = stale;
  });

  it('lets the Owner replace the Admin’s change, records it and tells the Admin', async () => {
    const stale = server.stale;
    const asked = await editDeadline('o-edit', 35, owner, { expected_version: stale });
    assert.deepEqual([asked.status, asked.body.error, asked.body.can_override], [409, 'EDIT_CONFLICT', true]);
    assert.equal(asked.body.current.last_edited_role, 'Admin');
    assert.equal((await cloudOrder('o-edit')).deadline, shopDate(25), 'asking changes nothing');

    const done = await editDeadline('o-edit', 35, owner, { expected_version: stale, override: true });
    assert.equal(done.status, 200, done.text);
    assert.deepEqual([done.body.overridden, done.body.changed, done.body.order.last_edited_role], [true, ['production_deadline'], 'Owner']);
    assert.equal(done.body.message, 'Order details saved. Your changes replaced theirs.');
    const row = await cloudOrder('o-edit');
    assert.deepEqual([row.deadline, row.last_edited_by, row.last_edited_role], [shopDate(35), 'u-owner', 'Owner']);

    const trail = await audits('o-edit');
    assert.equal(trail.length, 1);
    assert.deepEqual([trail[0].action, trail[0].performed_by, trail[0].performed_role], ['conflict_override', 'u-owner', 'Owner']);
    assert.deepEqual(trail[0].details.fields, ['production_deadline']);
    assert.deepEqual([trail[0].details.before.production_deadline.slice(0, 10), trail[0].details.before.last_edited_by, trail[0].details.before.last_edited_role],
      [shopDate(25), 'u-admin', 'Admin']);
    assert.deepEqual([trail[0].details.after.production_deadline.slice(0, 10), trail[0].details.after.last_edited_role, trail[0].details.after.version],
      [shopDate(35), 'Owner', done.body.order.version]);
    assert.deepEqual(server.orderEvents.overridden, [
      { user_id: 'u-admin', order_id: 'o-edit', tracking_no: done.body.order.tracking_no, overridden_by_role: 'Owner' }
    ]);
    assert.equal(server.orderEvents.updated.at(-1).version, done.body.order.version);

    // override: true with nothing to replace is an ordinary save: no second audit row, no notice
    const plain = await editDeadline('o-edit', 36, owner, { expected_version: done.body.order.version, override: true });
    assert.deepEqual([plain.status, plain.body.overridden], [200, false]);
    assert.equal((await audits('o-edit')).length, 1);
    assert.equal(server.orderEvents.overridden.length, 1);
  });

  it('replaces a lower rank’s design link the same way, but never reopens a closed order', async () => {
    await insertOrder('o-design', { editor: ['u-production', 'Production'] });
    const stale = (await detail('o-design')).body.order.version;
    await pool.query("UPDATE order_profiles SET design_drive_link = 'https://drive.google.com/file/d/theirs/view' WHERE order_id = 'o-design'");
    const link = 'https://drive.google.com/file/d/mine/view';
    const asked = await server.request('PATCH', '/api/orders/o-design/design', { token: admin, body: { design_drive_link: link, expected_version: stale } });
    assert.deepEqual([asked.status, asked.body.can_override], [409, true]);
    const done = await server.request('PATCH', '/api/orders/o-design/design', { token: admin, body: { design_drive_link: link, expected_version: stale, override: true } });
    assert.equal(done.status, 200, done.text);
    assert.deepEqual([done.body.overridden, done.body.order.design_drive_link, done.body.order.last_edited_role], [true, link, 'Admin']);
    const trail = await audits('o-design');
    assert.deepEqual([trail.length, trail[0].action, trail[0].details.before.design_drive_link, trail[0].details.after.design_drive_link],
      [1, 'conflict_override', 'https://drive.google.com/file/d/theirs/view', link]);
    assert.equal(server.orderEvents.overridden.at(-1).user_id, 'u-production');

    await insertOrder('o-closed', { editor: ['u-production', 'Production'] });
    const before = (await detail('o-closed')).body.order.version;
    await pool.query("UPDATE order_profiles SET production_status = 'Completed' WHERE order_id = 'o-closed'");
    const closed = await editDeadline('o-closed', 50, owner, { expected_version: before, override: true });
    assert.equal(closed.status, 409);
    assert.notEqual(closed.body.can_override, true);
    assert.deepEqual(await audits('o-closed'), []);
  });

  it('never forces an approval or a status change over someone else’s change', async () => {
    await insertOrder('o-status', { status: 'Printing', editor: ['u-production', 'Production'] });
    const stale = (await detail('o-status')).body.order.version;
    await pool.query("UPDATE order_profiles SET design_drive_link = 'https://drive.google.com/file/d/x/view' WHERE order_id = 'o-status'");
    const r = await setStatus('o-status', 'Pressing', owner, { expected_version: stale, override: true });
    assert.deepEqual([r.status, r.body.error, r.body.can_override], [409, 'EDIT_CONFLICT', false]);
    assert.deepEqual(await history('o-status'), []);
  });

  // ---------------- Offline edits that clash with cloud edits ----------------
  const offlineEdit = async (id, { role, user, deadline, quote = null }) => {
    // The order as this computer saw it before the cloud copy changed, then edited offline
    const fields = ['production_deadline', ...(quote === null ? [] : ['total_quote_amount']), 'last_edited_by', 'last_edited_role'];
    const number = (await pool.query('SELECT tracking_no FROM order_profiles WHERE order_id = $1', [id])).rows[0].tracking_no;
    await sqliteRun(server.localDb,
      `INSERT INTO order_profiles (order_id, customer_id, production_deadline, production_status, total_quote_amount, last_edited_by, last_edited_role,
                                   tracking_no, sync_status, dirty_fields, cloud_last_modified, last_modified)
       VALUES (?, 'c-1', ?, 'Pending', ?, ?, ?, ?, 'pending_update', ?, '2020-01-01T00:00:00.000000', '2026-11-01 00:00:00.000')`,
      [id, `${deadline}T00:00:00`, quote === null ? 1000 : quote, user, role, number, JSON.stringify(fields)]);
  };
  const localOrder = (id) => sqliteGet(server.localDb,
    `SELECT substr(production_deadline, 1, 10) AS deadline, production_status, sync_status, sync_conflict, dirty_fields, last_edited_role
       FROM order_profiles WHERE order_id = ?`, [id]);

  it('settles an offline edit that clashes with a cloud edit by rank when it syncs', async () => {
    const { syncOfflineData } = require('../services/sync');
    await sqliteRun(server.localDb, "INSERT INTO customers (customer_id, full_name, sync_status) VALUES ('c-1', 'Agdao NHS', 'synced')");
    const cloudDay = shopDate(60);
    await insertOrder('o-win', { deadline: `${cloudDay} 00:00:00`, editor: ['u-production', 'Production'] });
    await insertOrder('o-lose', { deadline: `${cloudDay} 00:00:00`, editor: ['u-admin', 'Admin'] });
    await insertOrder('o-equal', { deadline: `${cloudDay} 00:00:00`, editor: ['u-admin', 'Admin'] });
    await insertOrder('o-equal-2', { deadline: `${cloudDay} 00:00:00`, editor: ['u-admin', 'Admin'] });
    await insertOrder('o-moved-on', { status: 'Completed', deadline: `${cloudDay} 00:00:00`, editor: ['u-production', 'Production'] });
    await insertOrder('o-unknown', { deadline: `${cloudDay} 00:00:00` }); // changed before 009: editor unknown
    await offlineEdit('o-win', { role: 'Owner', user: 'u-owner', deadline: shopDate(70) });
    await offlineEdit('o-lose', { role: 'Production', user: 'u-production', deadline: shopDate(71) });
    await offlineEdit('o-equal', { role: 'Admin', user: 'u-admin', deadline: shopDate(72) });
    await offlineEdit('o-equal-2', { role: 'Admin', user: 'u-admin', deadline: shopDate(73) });
    await offlineEdit('o-moved-on', { role: 'Owner', user: 'u-owner', deadline: shopDate(74) });
    await offlineEdit('o-unknown', { role: null, user: null, deadline: shopDate(75) });

    const summary = await syncOfflineData(pool, server.localDb);
    assert.equal(summary.aborted, false);
    assert.equal(summary.failed, 0);
    const byId = (list) => Object.fromEntries(list.map((x) => [x.id, x]));

    // The Owner's offline change beats the Production change in the cloud
    const win = await cloudOrder('o-win');
    assert.deepEqual([win.deadline, win.last_edited_by, win.last_edited_role], [shopDate(70), 'u-owner', 'Owner']);
    assert.deepEqual(await localOrder('o-win'),
      { deadline: shopDate(70), production_status: 'Pending', sync_status: 'synced', sync_conflict: null, dirty_fields: null, last_edited_role: 'Owner' });
    const winTrail = await audits('o-win');
    assert.deepEqual([winTrail.length, winTrail[0].action, winTrail[0].performed_by, winTrail[0].performed_role],
      [1, 'offline_conflict_local_applied', 'u-owner', 'Owner']);
    assert.deepEqual([winTrail[0].details.before.production_deadline.slice(0, 10), winTrail[0].details.after.production_deadline.slice(0, 10),
      winTrail[0].details.replaced_editor.last_edited_by], [cloudDay, shopDate(70), 'u-production']);

    // The Admin's cloud change beats the Production change made offline, which is kept in the trail
    assert.equal((await cloudOrder('o-lose')).deadline, cloudDay);
    assert.deepEqual(await localOrder('o-lose'),
      { deadline: cloudDay, production_status: 'Pending', sync_status: 'synced', sync_conflict: null, dirty_fields: null, last_edited_role: 'Admin' });
    const loseTrail = await audits('o-lose');
    assert.deepEqual([loseTrail.length, loseTrail[0].action, loseTrail[0].performed_by], [1, 'offline_conflict_local_discarded', 'u-production']);
    assert.deepEqual([loseTrail[0].details.discarded.production_deadline.slice(0, 10), loseTrail[0].details.kept.production_deadline.slice(0, 10)],
      [shopDate(71), cloudDay]);

    // Equal ranks, and an unknown editor on both sides, wait for a person
    for (const id of ['o-equal', 'o-equal-2', 'o-unknown']) {
      const local = await localOrder(id);
      assert.ok(local.sync_conflict, `${id} is flagged`);
      assert.equal(local.sync_status, 'pending_update', `${id} keeps its offline change`);
      assert.equal((await cloudOrder(id)).deadline, cloudDay, `${id}: the cloud is untouched`);
      assert.deepEqual(await audits(id), []);
    }
    assert.deepEqual(summary.conflicts.map((c) => c.id).sort(), ['o-equal', 'o-equal-2', 'o-unknown']);
    assert.equal(summary.unresolved_conflicts, 3);

    // Higher rank, but the order was completed meanwhile: a closed order is not edited
    assert.deepEqual([(await cloudOrder('o-moved-on')).deadline, (await cloudOrder('o-moved-on')).production_status], [cloudDay, 'Completed']);
    assert.deepEqual([(await localOrder('o-moved-on')).deadline, (await localOrder('o-moved-on')).production_status, (await localOrder('o-moved-on')).sync_conflict],
      [cloudDay, 'Completed', null]);
    const movedTrail = await audits('o-moved-on');
    assert.deepEqual([movedTrail[0].action, movedTrail[0].details.reason], ['offline_conflict_local_discarded', 'This order is already Completed, so it can no longer be changed.']);

    // Who to tell: the account whose change was not kept
    const resolved = byId(summary.resolved);
    assert.deepEqual(Object.keys(resolved).sort(), ['o-lose', 'o-moved-on', 'o-win']);
    assert.deepEqual([resolved['o-win'].winner, resolved['o-win'].notify_user, resolved['o-win'].by_role], ['local', 'u-production', 'Owner']);
    assert.deepEqual([resolved['o-lose'].winner, resolved['o-lose'].notify_user, resolved['o-lose'].by_role], ['cloud', 'u-production', 'Admin']);
    assert.match(resolved['o-win'].tracking_no, /^XM-\d{4}-\d{4}$/);

    // A second run does not argue again about what was settled
    const again = await syncOfflineData(pool, server.localDb);
    assert.deepEqual([again.resolved, again.conflicts, again.unresolved_conflicts], [[], [], 3]);
    assert.equal((await audits('o-win')).length, 1);
  });

  it('lets an Owner or Admin settle an equal-rank conflict by hand, either way', async () => {
    const list = await server.request('GET', '/api/sync/conflicts', { token: admin });
    assert.equal(list.status, 200, list.text);
    const mine = list.body.conflicts.find((c) => c.id === 'o-equal');
    assert.match(mine.title, /^Order XM-\d{4}-\d{4}$/);
    assert.deepEqual([mine.changed, mine.keep_local_blocked_reason], [['Production deadline'], null]);

    const refused = await server.request('POST', '/api/sync/conflicts/order_profiles/o-equal/resolve', { token: production, body: { keep: 'local' } });
    assert.equal(refused.status, 403);

    const local = await server.request('POST', '/api/sync/conflicts/order_profiles/o-equal/resolve', { token: owner, body: { keep: 'local' } });
    assert.equal(local.status, 200, local.text);
    assert.deepEqual([local.body.kept, local.body.conflicts_remaining, 'order' in local.body], ['local', 2, false]);
    const row = await cloudOrder('o-equal');
    assert.deepEqual([row.deadline, row.last_edited_by, row.last_edited_role], [shopDate(72), 'u-owner', 'Owner'], 'the person who decided is the last editor');
    assert.deepEqual([(await localOrder('o-equal')).sync_status, (await localOrder('o-equal')).sync_conflict], ['synced', null]);
    const localTrail = await audits('o-equal');
    assert.deepEqual([localTrail.length, localTrail[0].action, localTrail[0].performed_by], [1, 'conflict_resolved_keep_local', 'u-owner']);
    assert.equal(server.orderEvents.updated.at(-1).order_id, 'o-equal', 'the other screens reload the order');

    const cloud = await server.request('POST', '/api/sync/conflicts/order_profiles/o-equal-2/resolve', { token: admin, body: { keep: 'cloud' } });
    assert.equal(cloud.status, 200, cloud.text);
    assert.deepEqual([cloud.body.kept, cloud.body.conflicts_remaining], ['cloud', 1]);
    assert.equal((await cloudOrder('o-equal-2')).deadline, shopDate(60));
    assert.deepEqual(await localOrder('o-equal-2'),
      { deadline: shopDate(60), production_status: 'Pending', sync_status: 'synced', sync_conflict: null, dirty_fields: null, last_edited_role: 'Admin' });
    const cloudTrail = await audits('o-equal-2');
    assert.deepEqual([cloudTrail[0].action, cloudTrail[0].performed_by, cloudTrail[0].details.discarded.production_deadline.slice(0, 10)],
      ['conflict_resolved_keep_cloud', 'u-admin', shopDate(73)]);

    const twice = await server.request('POST', '/api/sync/conflicts/order_profiles/o-equal-2/resolve', { token: admin, body: { keep: 'cloud' } });
    assert.deepEqual([twice.status, twice.body.error], [404, 'CONFLICT_NOT_FOUND']);
  });

  it('refuses to keep a local version that would break an order or stock rule', async () => {
    // The quote was changed offline, but the order was approved in the cloud meanwhile
    await pool.query("UPDATE order_profiles SET production_status = 'Approved' WHERE order_id = 'o-unknown'");
    await sqliteRun(server.localDb,
      `UPDATE order_profiles SET total_quote_amount = 2500, dirty_fields = '["production_deadline","total_quote_amount"]' WHERE order_id = 'o-unknown'`);
    const quote = await server.request('POST', '/api/sync/conflicts/order_profiles/o-unknown/resolve', { token: owner, body: { keep: 'local' } });
    assert.deepEqual([quote.status, quote.body.error], [409, 'KEEP_LOCAL_NOT_ALLOWED']);
    assert.match(quote.body.message, /quote cannot be changed after the job order was approved/);
    assert.equal((await cloudOrder('o-unknown')).quote, '1000.00');
    assert.ok((await localOrder('o-unknown')).sync_conflict, 'still waiting for a decision');

    // Stock counted differently in both places: only the cloud count can be kept
    await sqliteRun(server.localDb,
      `UPDATE inventory_items SET quantity_available = 7, sync_status = 'pending_update', dirty_fields = '["quantity_available"]',
              sync_conflict = 'changed online too' WHERE inventory_id = 'i-shirt'`);
    const list = await server.request('GET', '/api/sync/conflicts', { token: owner });
    const stock = list.body.conflicts.find((c) => c.table === 'inventory_items');
    assert.equal(stock.title, 'Catalog item “Custom Shirt”');
    assert.deepEqual(stock.changed, ['Quantity in stock']);
    assert.match(stock.keep_local_blocked_reason, /Keep the cloud version/);
    const forced = await server.request('POST', '/api/sync/conflicts/inventory_items/i-shirt/resolve', { token: owner, body: { keep: 'local' } });
    assert.deepEqual([forced.status, forced.body.error], [409, 'KEEP_LOCAL_NOT_ALLOWED']);
    assert.equal((await pool.query("SELECT quantity_available FROM inventory_items WHERE inventory_id = 'i-shirt'")).rows[0].quantity_available, 90);
    const kept = await server.request('POST', '/api/sync/conflicts/inventory_items/i-shirt/resolve', { token: owner, body: { keep: 'cloud' } });
    assert.equal(kept.status, 200, kept.text);
    const localStock = await sqliteGet(server.localDb, "SELECT quantity_available, sync_status, sync_conflict FROM inventory_items WHERE inventory_id = 'i-shirt'");
    assert.deepEqual(localStock, { quantity_available: 90, sync_status: 'synced', sync_conflict: null });

    const done = await server.request('POST', '/api/sync/conflicts/order_profiles/o-unknown/resolve', { token: owner, body: { keep: 'cloud' } });
    assert.deepEqual([done.status, done.body.conflicts_remaining], [200, 0]);
  });

  it('passes the start-up schema check, including the new triggers', async () => {
    const { checkCloudSchema } = require('../services/schemaCheck');
    const original = console.error;
    console.error = () => {};
    try {
      const result = await checkCloudSchema(pool);
      assert.deepEqual([result.ok, result.missing, result.missingTriggers], [true, [], []]);
    } finally { console.error = original; }
  });
});
