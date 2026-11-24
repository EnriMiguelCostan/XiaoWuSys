// The demo history loaded into a real PostgreSQL (npm run seed:history): accounts kept, old data
// gone, numbers continue, triggers back on, and the app's screens read the result.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pgTarget, resetDatabase, startPgTestServer } = require('./helpers/pgTestServer');
const { generateHistory } = require('../scripts/history/generate');
const { loadHistory, loadUsers, describeDatabase, PAUSED_TRIGGERS } = require('../scripts/history/load');
const { checkCloudSchema } = require('../services/schemaCheck');

const { url, skip } = pgTarget();

describe('Demo history on real PostgreSQL', { skip }, () => {
  let pool;
  let server;
  let history;
  let owner;

  before(async () => {
    const { Pool } = require('pg'); // only needed when this suite runs
    pool = new Pool({ connectionString: url, max: 8 });
    await resetDatabase(pool);
    await pool.query(`INSERT INTO users (user_id, username, password_hash, role) VALUES
      ('u-owner', 'owner', 'x', 'Owner'), ('u-admin', 'admin', 'x', 'Admin'),
      ('u-staff', 'staff', 'x', 'Staff'), ('u-production', 'production', 'x', 'Production')`);
    // Data that must disappear, including append-only rows (audit trail, status history, stock card)
    await pool.query("INSERT INTO customers (customer_id, full_name) VALUES ('c-old', 'Old Client')");
    await pool.query("INSERT INTO inventory_items (inventory_id, item_name, item_category, quantity_available, unit_cost) VALUES ('i-old', 'Old Item', 'Apparel', 5, 10)");
    await pool.query(`INSERT INTO order_profiles (order_id, customer_id, production_deadline, production_status, total_quote_amount)
                      VALUES ('o-old', 'c-old', '2030-01-01 00:00:00', 'Pending', 100)`);
    await pool.query("INSERT INTO payments (payment_id, order_id, amount, payment_type) VALUES ('p-old', 'o-old', 50, 'Cash')");
    await pool.query("INSERT INTO order_status_history (history_id, order_id, from_status, to_status) VALUES ('h-old', 'o-old', 'Pending', 'Approved')");
    await pool.query(`INSERT INTO audit_log (audit_id, entity, entity_id, action, details) VALUES ('a-old', 'order_profiles', 'o-old', 'test', '{}')`);

    const users = await loadUsers(pool);
    history = generateHistory({ users, now: new Date(), start: '2024-06-01' });
    await loadHistory(pool, history);
    server = await startPgTestServer(pool);
    owner = server.tokenFor('u-owner', 'Owner');
  });
  after(async () => {
    if (server) await server.close();
    if (pool) await pool.end();
  });

  it('keeps the accounts and removes everything else that was there', async () => {
    assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM users')).rows[0].n, 4);
    for (const [table, id, col] of [['customers', 'c-old', 'customer_id'], ['order_profiles', 'o-old', 'order_id'], ['payments', 'p-old', 'payment_id'],
      ['order_status_history', 'h-old', 'history_id'], ['audit_log', 'a-old', 'audit_id'], ['inventory_items', 'i-old', 'inventory_id']]) {
      assert.equal((await pool.query(`SELECT COUNT(*)::int AS n FROM ${table} WHERE ${col} = $1`, [id])).rows[0].n, 0, table);
    }
    const now = await describeDatabase(pool);
    for (const [table, rows] of Object.entries(history.tables)) {
      assert.equal(now.tables.find((t) => t.table === table).rows, rows.length, table);
    }
  });

  it('switches every paused trigger back on and passes the start-up schema check', async () => {
    for (const [table, trigger] of PAUSED_TRIGGERS) {
      const { rows } = await pool.query('SELECT tgenabled FROM pg_trigger WHERE tgname = $1 AND tgrelid = $2::regclass', [trigger, table]);
      assert.equal(rows[0].tgenabled, 'O', trigger);
    }
    assert.equal((await checkCloudSchema(pool)).ok, true);
  });

  it('continues the order, receipt and stock document numbers after the history', async () => {
    const year = Number(new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 4));
    const last = (list) => (list.find((x) => x.year === year) || { last_number: 0 }).last_number;
    const client = history.tables.customers[0].customer_id;
    const o = await pool.query(`INSERT INTO order_profiles (order_id, customer_id, production_deadline, production_status, total_quote_amount)
                                VALUES ('o-next', $1, '2030-01-01 00:00:00', 'Pending', 0) RETURNING tracking_no`, [client]);
    assert.equal(o.rows[0].tracking_no, `XM-${year}-${String(last(history.counters.orders) + 1).padStart(4, '0')}`);
    const p = await pool.query("INSERT INTO payments (payment_id, order_id, amount, payment_type) VALUES ('p-next', 'o-next', 10, 'Cash') RETURNING receipt_no");
    assert.equal(p.rows[0].receipt_no, `AR-${year}-${String(last(history.counters.receipts) + 1).padStart(4, '0')}`);
    // and a stock change writes the stock card again
    const item = history.tables.inventory_items[0];
    await pool.query('UPDATE inventory_items SET quantity_available = quantity_available + 1 WHERE inventory_id = $1', [item.inventory_id]);
    const card = await pool.query('SELECT balance_after FROM stock_movements WHERE inventory_id = $1 ORDER BY created_at DESC LIMIT 1', [item.inventory_id]);
    assert.equal(card.rows[0].balance_after, item.quantity_available + 1);
    await pool.query('UPDATE inventory_items SET quantity_available = quantity_available - 1 WHERE inventory_id = $1', [item.inventory_id]);
    await pool.query("DELETE FROM payments WHERE payment_id = 'p-next'");
    await pool.query("DELETE FROM order_profiles WHERE order_id = 'o-next'");
  });

  it('is read by the app: orders, clients, catalog, stock card and reports', async () => {
    const get = async (path) => {
      const r = await server.request('GET', path, { token: owner });
      assert.equal(r.status, 200, `${path}: ${r.text.slice(0, 300)}`);
      return r.body;
    };
    const list = await get('/api/orders?limit=50');
    assert.ok(list.orders.length > 0 && list.orders.every((o) => /^XM-\d{4}-\d{4}$/.test(o.tracking_no)));
    const completed = history.tables.order_profiles.find((o) => o.production_status === 'Completed');
    const detail = await get(`/api/orders/${completed.order_id}`);
    assert.equal(detail.totals.payment_status, 'Fully Paid');
    assert.equal(detail.fulfillment.state, 'complete');
    const client = history.tables.customers.find((c) => history.tables.order_profiles.some((o) => o.customer_id === c.customer_id));
    const profile = await get(`/api/customers/${client.customer_id}`);
    assert.ok(profile.orders.length > 0);
    await get('/api/inventory');
    await get('/api/stock/movements?limit=20');
    await get('/api/suppliers');
    await get('/api/reports/dashboard');
    const pnl = await get('/api/reports/pnl?from=2025-01-01&to=2025-12-31');
    assert.ok(pnl.gross_income > 0 && pnl.total_expenses > 0, JSON.stringify({ income: pnl.gross_income, expenses: pnl.total_expenses }));
    const waste = await get('/api/reports/waste?from=2025-01-01&to=2025-12-31');
    assert.ok(waste.totals.count > 0);
    const tx = await get('/api/reports/transactions?month=2025-06');
    assert.ok(tx.entries.length > 0);
  });
});
