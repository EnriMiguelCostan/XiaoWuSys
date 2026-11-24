// ==========================================
// LOAD A DEMO HISTORY INTO POSTGRES (used by scripts/seedHistory.js and its test)
//
// ONE transaction: if anything fails, the database is left exactly as it was.
//   1. Every table except users, schema_migrations and revoked_sessions is emptied (TRUNCATE).
//      TRUNCATE is used on purpose: the audit trail, status history, stock card and consumables
//      log refuse DELETE (they are append-only), and this is a deliberate reset of a demo copy.
//   2. The triggers that give numbers (XM- / AR- / SI-), write the stock card and send live
//      "changed" notices are paused, because the history brings its own numbers, dated stock
//      card and past dates. Everything else (checks, foreign keys) still applies to every row.
//   3. The rows are inserted table by table, parents first, then the number counters are set
//      so the next real order / receipt / document continues the sequence.
//   4. The triggers are switched back on. The accounts are checked to be untouched.
// ==========================================
const KEEP = ['users', 'schema_migrations', 'revoked_sessions'];
const INSERT_ORDER = [
  'suppliers', 'inventory_items', 'consumable_rates', 'customers', 'customer_branches', 'order_profiles', 'order_items',
  'order_print_details', 'order_status_history', 'order_delivery_plans', 'order_deliveries', 'payments', 'order_consumables_log',
  'material_loss', 'overhead_expenses', 'stock_documents', 'stock_document_lines', 'stock_movements'
];
const PAUSED_TRIGGERS = [
  ['order_profiles', 'trg_order_profiles_assign_tracking_no'],
  ['order_profiles', 'trg_order_profiles_notify'],
  ['payments', 'trg_payments_assign_receipt_no'],
  ['stock_documents', 'trg_stock_documents_assign_no'],
  ['inventory_items', 'trg_inventory_items_stock_movement'],
  ['inventory_items', 'trg_inventory_items_notify']
];
const CHUNK = 500;
const ident = (name) => {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`Unexpected name: ${name}`);
  return `"${name}"`;
};

// What the database holds now -> { tables: [{ table, rows, kept }], users }
const describeDatabase = async (pool) => {
  const { rows } = await pool.query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`);
  const tables = [];
  for (const { table_name: table } of rows) {
    const count = await pool.query(`SELECT COUNT(*)::int AS n FROM ${ident(table)}`);
    tables.push({ table, rows: count.rows[0].n, kept: KEEP.includes(table) });
  }
  return { tables, users: (tables.find((t) => t.table === 'users') || { rows: 0 }).rows };
};

const loadHistory = async (pool, history, { log = () => {} } = {}) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const usersBefore = (await client.query('SELECT COUNT(*)::int AS n, COALESCE(string_agg(user_id, \',\' ORDER BY user_id), \'\') AS ids FROM users')).rows[0];

    // 1. Empty everything but the accounts
    const { rows } = await client.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`);
    const wipe = rows.map((r) => r.table_name).filter((t) => !KEEP.includes(t));
    if (wipe.length) await client.query(`TRUNCATE ${wipe.map(ident).join(', ')} RESTART IDENTITY`);
    log(`🧹 Emptied ${wipe.length} tables (accounts kept).`);

    // 2. Pause the numbering, stock-card and notification triggers
    for (const [table, trigger] of PAUSED_TRIGGERS) await client.query(`ALTER TABLE ${ident(table)} DISABLE TRIGGER ${ident(trigger)}`);

    // 3. Insert, parents first, in chunks
    for (const table of INSERT_ORDER) {
      const list = history.tables[table] || [];
      if (list.length === 0) continue;
      const cols = (await client.query(
        `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`, [table])).rows.map((r) => r.column_name);
      const given = Object.keys(list[0]);
      const unknown = given.filter((col) => !cols.includes(col));
      if (unknown.length) throw new Error(`${table} has no column(s) ${unknown.join(', ')}. Run the migrations first (npm run migrate).`);
      const colList = given.map(ident).join(', ');
      for (let i = 0; i < list.length; i += CHUNK) {
        await client.query(
          `INSERT INTO ${ident(table)} (${colList}) SELECT ${colList} FROM json_populate_recordset(NULL::${ident(table)}, $1::json)`,
          [JSON.stringify(list.slice(i, i + CHUNK))]);
      }
      log(`   ${table}: ${list.length}`);
    }

    // The next real numbers continue after the history's
    for (const { year, last_number } of history.counters.orders) {
      await client.query('INSERT INTO order_tracking_counters (year, last_number) VALUES ($1, $2)', [year, last_number]);
    }
    for (const { year, last_number } of history.counters.receipts) {
      await client.query('INSERT INTO receipt_counters (year, last_number) VALUES ($1, $2)', [year, last_number]);
    }
    for (const { prefix, year, last_number } of history.counters.documents) {
      await client.query('INSERT INTO document_counters (prefix, year, last_number) VALUES ($1, $2, $3)', [prefix, year, last_number]);
    }

    // 4. Triggers back on; the accounts must be exactly as they were
    for (const [table, trigger] of PAUSED_TRIGGERS) await client.query(`ALTER TABLE ${ident(table)} ENABLE TRIGGER ${ident(trigger)}`);
    const usersAfter = (await client.query('SELECT COUNT(*)::int AS n, COALESCE(string_agg(user_id, \',\' ORDER BY user_id), \'\') AS ids FROM users')).rows[0];
    if (usersAfter.n !== usersBefore.n || usersAfter.ids !== usersBefore.ids) throw new Error('The accounts changed during the load. Nothing was saved.');
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
};

// The accounts the history credits with each action (removed accounts are left out)
const loadUsers = async (pool) => {
  const hasRemoved = (await pool.query(
    `SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'removed_at'`)).rowCount > 0;
  const { rows } = await pool.query(`SELECT user_id, role FROM users ${hasRemoved ? 'WHERE removed_at IS NULL' : ''} ORDER BY user_id`);
  return rows;
};

module.exports = { loadHistory, describeDatabase, loadUsers, KEEP, INSERT_ORDER, PAUSED_TRIGGERS };
