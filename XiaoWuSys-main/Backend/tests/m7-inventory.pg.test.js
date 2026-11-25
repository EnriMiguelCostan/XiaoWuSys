// ==========================================
// MIGRATION 015 ON A REAL POSTGRESQL DATABASE: the inventory system (adviser consultation)
// Runs only when TEST_DATABASE_URL is set (CI starts a throw-away PostgreSQL for it). The
// database is WIPED first: localhost or a database whose name contains "test" only, never Neon.
//
// Checks: 015 applies to an existing shop database without moving any row's version (suppliers
// are made from the free-text names, garments are marked, print lines leave the materials, every
// item gets an opening balance) and is safe to run twice; supplier profiles; stock in raises the
// stock and works out the average cost, stock out takes free stock only, both can be corrected
// or voided by the net difference only, and a count sets the system count (never below what
// orders hold); the stock card has a row with a running balance for EVERY change, whoever made
// it; print details stay apart from the materials (sizes on garments only, never more pieces than
// the material); Pressing only for garments; the quote with labor and incidental charges;
// deliveries in batches and what "Completed" needs; payment details per method, a date paid in the
// past, verification and corrections; refunds and the price cut after approval; the client
// profile; the new reports; and an order saved offline reserves its stock in the cloud as an
// amount when it syncs (the reservation bug).
// ==========================================
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pgTarget, resetDatabase, startPgTestServer, readMigration } = require('./helpers/pgTestServer');
const { shopDate } = require('./helpers/testServer');
const { sqliteGet, sqliteRun } = require('../services/records');
const { localDateTime } = require('../utils/validation');
const { refreshLocalRows } = require('../services/sync');

const { url, skip } = pgTarget();
const FILE = '015_inventory_system.sql';
// A shop-clock date and time some days ago, as a form sends it ('YYYY-MM-DDTHH:MM')
const pastLocal = (days, hour = 9) => {
  const d = localDateTime(new Date(Date.now() - days * 86400000)).slice(0, 10);
  return `${d}T${String(hour).padStart(2, '0')}:30`;
};
const YEAR = localDateTime(new Date()).slice(0, 4);

describe('Migration 015 on real PostgreSQL: the inventory system', { skip }, () => {
  let pool;
  let server;
  let owner; let admin; let staff; let production;
  const ids = {};

  const one = async (sql, params = []) => (await pool.query(sql, params)).rows[0];
  const call = (method, path, token, body) => server.request(method, path, { token, body });
  const stock = (id) => one('SELECT quantity_available AS a, quantity_reserved AS r, unit_cost::text AS cost FROM inventory_items WHERE inventory_id = $1', [id]);
  const card = async (id) => (await pool.query(
    'SELECT movement_type, quantity_change, balance_after, reference_no FROM stock_movements WHERE inventory_id = $1 ORDER BY created_at, movement_id', [id])).rows;

  before(async () => {
    const { Pool } = require('pg'); // only needed when this suite runs
    pool = new Pool({ connectionString: url, max: 10 });
    // An existing shop database: everything up to 014, with stock, an order and a payment in it
    await resetDatabase(pool, { before: '015' });
    await pool.query(`INSERT INTO users (user_id, username, password_hash, role) VALUES
      ('u-owner', 'owner', 'x', 'Owner'), ('u-admin', 'admin', 'x', 'Admin'),
      ('u-staff', 'staff', 'x', 'Staff'), ('u-production', 'production', 'x', 'Production')`);
    await pool.query("INSERT INTO customers (customer_id, full_name) VALUES ('c-1', 'Agdao NHS'), ('c-2', 'Juan Dela Cruz')");
    await pool.query(`INSERT INTO inventory_items (inventory_id, item_name, item_category, quantity_available, unit_cost, supplier) VALUES
      ('i-shirt', 'White T-Shirt', 'Apparel', 100, 100, 'Davao Garments'),
      ('i-mug', 'Ceramic Mug', 'Drinkware', 60, 60, 'davao  garments'),
      ('i-ink', 'Sublimation Ink', 'Consumable', 1000, 2, NULL)`);
    await pool.query(`INSERT INTO order_profiles (order_id, customer_id, production_deadline, production_status, total_quote_amount)
                      VALUES ('o-old', 'c-1', '2030-12-31 00:00:00', 'Pending', 0)`);
    await pool.query(`INSERT INTO order_items (line_item_id, order_id, inventory_id, product_type, quantity, size, custom_name) VALUES
      ('l-old', 'o-old', 'i-shirt', 'White T-Shirt', 2, NULL, NULL), ('l-print', 'o-old', NULL, 'Jersey print', 1, 'M', 'REYES')`);
    await pool.query("INSERT INTO payments (payment_id, order_id, amount, payment_type) VALUES ('p-old', 'o-old', 10, 'Cash')");
  });
  after(async () => {
    if (server) await server.close();
    if (pool) await pool.end();
  });

  it('applies migration 015 without moving any row, and running it again changes nothing', async () => {
    const versions = async () => one(`SELECT
      (SELECT last_modified::text FROM inventory_items WHERE inventory_id = 'i-shirt') AS i,
      (SELECT last_modified::text FROM payments WHERE payment_id = 'p-old') AS p,
      (SELECT last_modified::text FROM order_profiles WHERE order_id = 'o-old') AS o,
      (SELECT last_modified::text FROM customers WHERE customer_id = 'c-1') AS c`);
    const before = await versions();
    const { applyPendingMigrations } = require('../services/migrations');
    assert.ok((await applyPendingMigrations(pool, { log: () => {} })).applied.includes(FILE));
    assert.deepEqual((await applyPendingMigrations(pool, { log: () => {} })).applied, []);
    await pool.query(readMigration(FILE)); // pasted again by hand
    assert.deepEqual(await versions(), before, 'offline edits waiting to sync keep their baseline');

    const suppliers = (await pool.query('SELECT supplier_id, supplier_name FROM suppliers')).rows;
    assert.deepEqual(suppliers.map((s) => s.supplier_name), ['Davao Garments'], 'one supplier per name, case and spaces ignored');
    ids.davao = suppliers[0].supplier_id;
    const items = (await pool.query('SELECT inventory_id, supplier_id, has_sizes FROM inventory_items ORDER BY inventory_id')).rows;
    assert.deepEqual(items.map((i) => [i.inventory_id, i.supplier_id, i.has_sizes]),
      [['i-ink', null, false], ['i-mug', ids.davao, false], ['i-shirt', ids.davao, true]]);
    assert.deepEqual((await pool.query("SELECT line_item_id FROM order_items WHERE order_id = 'o-old'")).rows.map((r) => r.line_item_id), ['l-old'],
      'the print line left the materials');
    assert.deepEqual(await one("SELECT print_type, size, custom_name FROM order_print_details WHERE print_detail_id = 'l-print'"),
      { print_type: 'Jersey print', size: 'M', custom_name: 'REYES' });
    assert.deepEqual((await card('i-shirt')).map((m) => [m.movement_type, m.quantity_change, m.balance_after]), [['opening', 100, 100]]);
    assert.equal((await one("SELECT recorded_at FROM payments WHERE payment_id = 'p-old'")).recorded_at, null, 'no backfill of recorded_at');
    await assert.rejects(pool.query("UPDATE stock_movements SET note = 'x'"), /stock_movements is append-only/);
    const { checkCloudSchema } = require('../services/schemaCheck');
    const original = console.error;
    console.error = () => {};
    try {
      const schema = await checkCloudSchema(pool);
      assert.deepEqual([schema.ok, schema.missing, schema.missingTriggers], [true, [], []]);
    } finally { console.error = original; }

    server = await startPgTestServer(pool, { realSync: true });
    owner = server.tokenFor('u-owner', 'Owner');
    admin = server.tokenFor('u-admin', 'Admin');
    staff = server.tokenFor('u-staff', 'Staff');
    production = server.tokenFor('u-production', 'Production');
  });

  it('keeps supplier profiles: one per name, renamed on their items, archived by a manager', async () => {
    const add = await call('POST', '/api/suppliers', staff, { supplier_name: 'Quaff PH', contact_person: 'Ana Reyes', contact_number: '(082) 123 4567', email: 'sales@quaff.ph' });
    assert.equal(add.status, 201, add.text);
    ids.quaff = add.body.supplier.supplier_id;
    assert.deepEqual([(await call('POST', '/api/suppliers', staff, { supplier_name: 'quaff  ph' })).body.error], ['DUPLICATE_SUPPLIER']);
    assert.equal((await call('POST', '/api/suppliers', production, { supplier_name: 'Prod Supply', email: 'nope' })).status, 400, 'Production passes the role check');
    assert.equal((await call('POST', '/api/suppliers', staff, { supplier_name: 'Bad Mail', email: 'nope' })).status, 400);

    const renamed = await call('PATCH', `/api/suppliers/${ids.davao}`, staff, { supplier_name: 'Davao Garments Supply' });
    assert.deepEqual([renamed.status, renamed.body.changed], [200, ['supplier_name']]);
    assert.deepEqual((await pool.query("SELECT DISTINCT supplier FROM inventory_items WHERE supplier_id = $1", [ids.davao])).rows, [{ supplier: 'Davao Garments Supply' }]);

    const list = await call('GET', '/api/suppliers', production);
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.suppliers.map((s) => [s.supplier_name, s.item_count]), [['Davao Garments Supply', 2], ['Quaff PH', 0]]);
    assert.equal((await call('POST', `/api/suppliers/${ids.quaff}/archive`, staff)).status, 403);
    assert.equal((await call('POST', `/api/suppliers/${ids.quaff}/archive`, admin)).status, 200);
    const blocked = await call('POST', '/api/stock/documents', staff, {
      document_type: 'stock_in', occurred_at: pastLocal(1), supplier_id: ids.quaff, reference_type: 'No paper', lines: [{ inventory_id: 'i-ink', quantity: 1, unit_cost: 2 }]
    });
    assert.deepEqual([blocked.status, blocked.body.error], [409, 'SUPPLIER_ARCHIVED']);
    const names = async (q) => (await call('GET', `/api/suppliers${q}`, production)).body.suppliers.map((x) => x.supplier_name);
    assert.deepEqual(await names('?include_archived=only'), ['Quaff PH'], '"Show archived" lists the archived ones alone');
    assert.deepEqual(await names(''), ['Davao Garments Supply']);
    assert.deepEqual(await names('?include_archived=true'), ['Davao Garments Supply', 'Quaff PH']);
    assert.equal((await call('POST', `/api/suppliers/${ids.quaff}/restore`, admin)).status, 200);
  });

  it('records a stock in: the paper trail, the stock, the average cost and the stock card', async () => {
    const base = { document_type: 'stock_in', occurred_at: pastLocal(2), supplier_id: ids.davao, reference_type: 'Delivery receipt' };
    const lines = [{ inventory_id: 'i-shirt', quantity: 50, unit_cost: 130 }, { inventory_id: 'i-mug', quantity: 10, unit_cost: 60 }];
    const noRef = await call('POST', '/api/stock/documents', staff, { ...base, lines });
    assert.deepEqual([noRef.status, noRef.body.details[0].field], [400, 'reference_no']);
    const future = await call('POST', '/api/stock/documents', staff, { ...base, reference_no: 'DR-1', occurred_at: '2033-01-01T00:00', lines });
    assert.deepEqual([future.status, future.body.details[0].field], [400, 'occurred_at']);
    const twice = await call('POST', '/api/stock/documents', staff, { ...base, reference_no: 'DR-1', lines: [lines[0], lines[0]] });
    assert.equal(twice.status, 400, 'one line per item');
    assert.equal((await call('POST', '/api/stock/documents', production, { ...base, reference_no: 'DR-1', lines: [lines[0], lines[0]] })).status, 400,
      'Production records stock like Staff, so it reaches the same checks');

    const r = await call('POST', '/api/stock/documents', staff, { ...base, reference_no: 'DR-0457', lines });
    assert.equal(r.status, 201, r.text);
    assert.equal(r.body.document.document_no, `SI-${YEAR}-0001`);
    assert.equal(r.body.document.total_cost, 7100);
    ids.stockIn = r.body.document.document_id;
    assert.deepEqual(await stock('i-shirt'), { a: 150, r: 0, cost: '110.00' }, '(100 x 100 + 50 x 130) / 150');
    assert.deepEqual(await stock('i-mug'), { a: 70, r: 0, cost: '60.00' });
    assert.deepEqual((await card('i-shirt')).at(-1), { movement_type: 'stock_in', quantity_change: 50, balance_after: 150, reference_no: `SI-${YEAR}-0001` });
    assert.ok(server.pushes.some((p) => p.ids.includes('i-shirt')), 'the catalog screens are told');
    const local = await sqliteGet(server.localDb, "SELECT quantity_available FROM inventory_items WHERE inventory_id = 'i-shirt'");
    assert.equal(local.quantity_available, 150, 'this computer follows at once');
  });

  it('takes out free stock only, with a reason (and the supplier when returning to one)', async () => {
    const order = await call('POST', '/api/orders', staff, {
      customer_id: 'c-1', production_deadline: shopDate(10), required_items: [{ inventory_id: 'i-shirt', quantity_needed: 140 }],
      order_description: 'Front: school logo. Back: names and numbers.'
    });
    assert.equal(order.status, 201, order.text);
    ids.order = order.body.order_id;
    assert.equal(order.body.order.order_description, 'Front: school logo. Back: names and numbers.');
    assert.deepEqual(await stock('i-shirt'), { a: 150, r: 140, cost: '110.00' }, 'reserved: on hand stays, free goes down');

    const out = (body) => call('POST', '/api/stock/documents', staff, { document_type: 'stock_out', occurred_at: pastLocal(1), ...body });
    const tooMuch = await out({ reason: 'Used in the shop (not for an order)', lines: [{ inventory_id: 'i-shirt', quantity: 20 }] });
    assert.deepEqual([tooMuch.status, tooMuch.body.error, tooMuch.body.shortages[0].free], [409, 'INSUFFICIENT_FREE_STOCK', 10]);
    assert.equal((await out({ reason: 'Returned to supplier', lines: [{ inventory_id: 'i-shirt', quantity: 1 }] })).status, 400);
    assert.equal((await out({ reason: 'Other', lines: [{ inventory_id: 'i-shirt', quantity: 1 }] })).status, 400, 'Other needs a note');
    const ok = await out({ reason: 'Used in the shop (not for an order)', notes: 'Staff uniform', lines: [{ inventory_id: 'i-shirt', quantity: 5 }] });
    assert.equal(ok.status, 201, ok.text);
    assert.equal(ok.body.document.document_no, `SO-${YEAR}-0001`);
    ids.stockOut = ok.body.document.document_id;
    assert.deepEqual(await stock('i-shirt'), { a: 145, r: 140, cost: '110.00' }, 'the average cost does not change when stock leaves');
  });

  it('corrects or voids a record by the difference only, never below what orders hold', async () => {
    const lines = (shirts) => [{ inventory_id: 'i-shirt', quantity: shirts, unit_cost: 130 }, { inventory_id: 'i-mug', quantity: 10, unit_cost: 60 }];
    const head = { occurred_at: pastLocal(2), supplier_id: ids.davao, reference_type: 'Delivery receipt', reference_no: 'DR-0457' };
    const fixed = await call('PUT', `/api/stock/documents/${ids.stockIn}`, staff, { ...head, lines: lines(48), correction_reason: 'Two were counted twice' });
    assert.equal(fixed.status, 200, fixed.text);
    assert.equal((await stock('i-shirt')).a, 143);
    assert.deepEqual((await card('i-shirt')).at(-1).movement_type, 'stock_in_correction');
    for (const bad of ['x'.repeat(501), 42]) {
      const refused = await call('PUT', `/api/stock/documents/${ids.stockIn}`, staff, { ...head, lines: lines(48), correction_reason: bad });
      assert.deepEqual([refused.status, refused.body.details[0].field], [400, 'correction_reason'], 'the reason is checked before anything moves');
    }
    const tooFar = await call('PUT', `/api/stock/documents/${ids.stockIn}`, staff, { ...head, lines: lines(10) });
    assert.deepEqual([tooFar.status, tooFar.body.error], [409, 'INSUFFICIENT_FREE_STOCK'], 'those shirts are held for an order');
    const cannotVoid = await call('POST', `/api/stock/documents/${ids.stockIn}/void`, admin, { reason: 'Wrong delivery' });
    assert.deepEqual([cannotVoid.status, cannotVoid.body.error], [409, 'INSUFFICIENT_FREE_STOCK']);
    assert.equal((await call('POST', `/api/stock/documents/${ids.stockOut}/void`, staff, { reason: 'x' })).status, 403, 'voids are for Owner / Admin');
    const voided = await call('POST', `/api/stock/documents/${ids.stockOut}/void`, admin, { reason: 'Recorded by mistake' });
    assert.equal(voided.status, 200, voided.text);
    assert.equal((await stock('i-shirt')).a, 148);
    assert.equal((await call('POST', `/api/stock/documents/${ids.stockOut}/void`, admin, { reason: 'again' })).body.error, 'STOCK_DOCUMENT_VOIDED');
    const shown = await call('GET', `/api/stock/documents/${ids.stockIn}`, production);
    assert.deepEqual([shown.status, shown.body.document.status, shown.body.history[0].action, shown.body.history[0].by_name], [200, 'Corrected', 'Corrected', 'staff']);
    const staffSees = (await call('GET', `/api/stock/documents/${ids.stockIn}`, staff)).body.document.allowed_actions;
    assert.deepEqual(shown.body.document.allowed_actions, staffSees, 'Production gets the same buttons as Staff');
    assert.equal(shown.body.document.allowed_actions.void, false, 'voiding stays with the Owner / Admin');
  });

  it('sets the count from a physical count, never below what orders hold', async () => {
    const count = (token, lines) => call('POST', '/api/stock/documents', token, { document_type: 'stock_count', occurred_at: pastLocal(0, 0), lines });
    assert.equal((await count(staff, [{ inventory_id: 'i-mug', counted_quantity: 65 }])).status, 403, 'counts are for Owner / Admin');
    const below = await count(admin, [{ inventory_id: 'i-shirt', counted_quantity: 100 }]);
    assert.deepEqual([below.status, below.body.error], [409, 'COUNT_BELOW_RESERVED']);
    const r = await count(admin, [{ inventory_id: 'i-mug', counted_quantity: 65 }, { inventory_id: 'i-ink', counted_quantity: 1000 }]);
    assert.equal(r.status, 201, r.text);
    assert.equal(r.body.document.document_no, `SC-${YEAR}-0001`);
    assert.deepEqual(r.body.lines.map((l) => [l.inventory_id, l.system_quantity, l.quantity]).sort(), [['i-ink', 1000, 1000], ['i-mug', 70, 65]]);
    assert.equal((await stock('i-mug')).a, 65);
    assert.deepEqual((await card('i-ink')).map((m) => m.movement_type), ['opening'], 'an unchanged count writes no movement');
    assert.equal((await call('PUT', `/api/stock/documents/${r.body.document.document_id}`, admin, {})).body.error, 'COUNT_NOT_EDITABLE');
  });

  it('keeps print details apart from the materials: sizes on garments, never more pieces than ordered', async () => {
    const one = await call('POST', `/api/orders/${ids.order}/print-details`, staff,
      { print_type: 'Jersey print', quantity: 2, size: 'M', custom_name: 'DELA CRUZ', custom_number: '7' });
    assert.equal(one.status, 201, one.text);
    const roster = Array.from({ length: 139 }, (_, i) => ({ print_type: 'Jersey print', quantity: 1, size: 'L', custom_number: String(i) }));
    const over = await call('POST', `/api/orders/${ids.order}/print-details/bulk`, staff, { rows: roster });
    assert.deepEqual([over.status, over.body.error], [409, 'PRINT_DETAILS_EXCEED_MATERIAL'], '141 names for 140 shirts');
    const ok = await call('POST', `/api/orders/${ids.order}/print-details/bulk`, staff, { rows: roster.slice(1) });
    assert.equal(ok.status, 201, ok.text);
    const d = await call('GET', `/api/orders/${ids.order}`, staff);
    assert.equal(d.body.print_details.length, 139);
    assert.deepEqual([d.body.items.length, d.body.has_garments, d.body.totals.pieces], [1, true, 140]);
    const fix = await call('PATCH', `/api/orders/${ids.order}/print-details/${one.body.print_detail.print_detail_id}`, staff, { custom_name: 'DELA CRUZ JR.' });
    assert.equal(fix.status, 200, fix.text);
    const gone = await call('DELETE', `/api/orders/${ids.order}/print-details/${one.body.print_detail.print_detail_id}`, staff);
    assert.equal(gone.status, 200);
    assert.equal((await one_('SELECT COUNT(*)::int AS n FROM order_print_details WHERE order_id = $1', [ids.order])).n, 138);
  });
  const one_ = (sql, params) => one(sql, params);

  it('prices materials + labor + incidental charges, and approves the job order without stock-less items in the way', async () => {
    assert.equal((await call('PATCH', '/api/inventory/i-shirt', staff, { selling_price: 250 })).status, 200);
    const quote = await call('POST', `/api/orders/${ids.order}/quote`, owner, { labor_amount: 500, incidental_percent: 5 });
    assert.equal(quote.status, 200, quote.text);
    const q = quote.body.calculation;
    assert.deepEqual([q.subtotal_amount, q.labor_amount, q.incidental_amount, q.gross_amount, q.total_quote_amount], [29750, 500, 1512.5, 31762.5, 31762.5],
      '140 x ₱212.50 (15% bulk, migration 017), + ₱500 labor, + 5% of ₱30,250');
    assert.deepEqual([quote.body.quote.labor_amount, quote.body.quote.incidental_amount], [500, 1512.5]);
    assert.equal((await call('POST', `/api/orders/${ids.order}/quote`, owner, { incidental_amount: 10, incidental_percent: 1 })).status, 400);

    const noBank = await call('POST', `/api/orders/${ids.order}/payments`, staff, { amount: 16800, payment_type: 'Bank Transfer', payer_name: 'Juan Dela Cruz', reference_no: 'FT-1' });
    assert.deepEqual([noBank.status, noBank.body.details[0].field], [400, 'bank_name']);
    const paid = await call('POST', `/api/orders/${ids.order}/payments`, staff, {
      amount: 16800, payment_type: 'Bank Transfer', bank_name: 'BDO', reference_no: 'FT-20261120-01', account_name: 'Agdao NHS PTA',
      payer_name: 'Mrs. Lopez', payment_date: pastLocal(3, 14)
    });
    assert.equal(paid.status, 201, paid.text);
    ids.bankPayment = paid.body.payment.payment_id;
    assert.deepEqual([paid.body.payment.bank_name, paid.body.payment.payer_name, paid.body.payment.payment_date.slice(0, 10)],
      ['BDO', 'Mrs. Lopez', localDateTime(new Date(Date.now() - 3 * 86400000)).slice(0, 10)], 'paid three days ago (14:30 Manila = 06:30 UTC)');
    assert.ok(paid.body.payment.recorded_at, 'recorded now');
    const cashExtra = await call('POST', `/api/orders/${ids.order}/payments`, staff, { amount: 1, payment_type: 'Cash', payer_name: 'Juan Dela Cruz', bank_name: 'ignored' });
    assert.equal(cashExtra.status, 201);
    assert.equal(cashExtra.body.payment.bank_name, null, 'details a method does not use are not saved');
    await pool.query('DELETE FROM payments WHERE payment_id = $1', [cashExtra.body.payment.payment_id]);

    const d = await call('GET', `/api/orders/${ids.order}`, owner);
    const approve = await call('POST', `/api/orders/${ids.order}/approve`, owner, { expected_version: d.body.order.version });
    assert.equal(approve.status, 200, approve.text);
    assert.equal((await call('PATCH', `/api/orders/${ids.order}/status`, staff, { status: 'Printing' })).status, 200);
    const printing = await call('GET', `/api/orders/${ids.order}`, staff);
    assert.deepEqual(printing.body.allowed_actions.statuses, ['Pressing'], 'T-shirts are pressed before Ready (migration 017)');
    assert.deepEqual([printing.body.progress.pieces, printing.body.progress.printed, printing.body.progress.needs_pressing], [140, 0, true]);
    assert.equal(printing.body.needs_pressing, true);
  });

  it('offers Pressing only for T-shirts', async () => {
    assert.equal((await call('PATCH', '/api/inventory/i-mug', staff, { selling_price: 120 })).status, 200);
    const mug = await call('POST', '/api/orders', staff, { customer_id: 'c-2', production_deadline: shopDate(5), required_items: [{ inventory_id: 'i-mug', quantity_needed: 5 }] });
    assert.equal(mug.status, 201, mug.text);
    ids.mugOrder = mug.body.order_id;
    assert.equal((await call('POST', `/api/orders/${ids.mugOrder}/quote`, owner, {})).status, 200);
    assert.equal((await call('POST', `/api/orders/${ids.mugOrder}/payments`, staff, { amount: 600, payment_type: 'Cash', payer_name: 'Juan Dela Cruz' })).status, 201);
    const d = await call('GET', `/api/orders/${ids.mugOrder}`, owner);
    assert.equal((await call('POST', `/api/orders/${ids.mugOrder}/approve`, owner, { expected_version: d.body.order.version })).status, 200);
    assert.equal((await call('PATCH', `/api/orders/${ids.mugOrder}/status`, staff, { status: 'Printing' })).status, 200);
    const shown = await call('GET', `/api/orders/${ids.mugOrder}`, staff);
    assert.deepEqual([shown.body.has_garments, shown.body.needs_pressing, shown.body.allowed_actions.statuses], [false, false, ['Ready']]);
    const pressed = await call('PATCH', `/api/orders/${ids.mugOrder}/status`, staff, { status: 'Pressing' });
    assert.deepEqual([pressed.status, pressed.body.error], [409, 'PRESSING_NOT_APPLICABLE']);
  });

  it('hands an order over in batches, and completes it only when it is all delivered and paid', async () => {
    const batch = (quantity, extra = {}) => call('POST', `/api/orders/${ids.order}/deliveries`, staff, { quantity, method: 'Pick-up', received_by_name: 'Mr. Cruz', ...extra });
    // migration 017: only finished pieces are handed over
    const notReady = await batch(10);
    assert.deepEqual([notReady.status, notReady.body.error], [409, 'PIECES_NOT_READY']);
    const progress = await call('POST', `/api/orders/${ids.order}/progress`, staff, { lines: [{ line_item_id: (await call('GET', `/api/orders/${ids.order}`, staff)).body.items[0].line_item_id, printed: 120, pressed: 100 }] });
    assert.equal(progress.status, 200, progress.text);
    assert.deepEqual([progress.body.progress.printed, progress.body.progress.pressed, progress.body.progress.ready], [120, 100, 100]);
    assert.equal((await batch(100, { delivered_at: pastLocal(1, 16) })).status, 201);
    assert.equal((await batch(1)).body.error, 'PIECES_NOT_READY', '100 ready, 100 handed over');
    assert.equal((await call('PATCH', `/api/orders/${ids.order}/status`, staff, { status: 'Pressing', complete_counts: true })).status, 200);
    assert.equal((await call('PATCH', `/api/orders/${ids.order}/status`, staff, { status: 'Ready', complete_counts: true })).status, 200);
    const tooMany = await batch(50);
    assert.deepEqual([tooMany.status, tooMany.body.error, tooMany.body.remaining], [409, 'DELIVERY_EXCEEDS_REMAINING', 40]);
    assert.equal((await call('POST', `/api/orders/${ids.order}/deliveries`, production, { quantity: 50 })).body.error, 'DELIVERY_EXCEEDS_REMAINING',
      'Production records deliveries like Staff');

    const early = await call('PATCH', `/api/orders/${ids.order}/status`, staff, { status: 'Completed' });
    assert.deepEqual([early.status, early.body.error, early.body.missing.map((m) => m.code)], [409, 'COMPLETION_REQUIREMENTS_NOT_MET', ['BALANCE_DUE', 'PIECES_NOT_DELIVERED']]);
    const d = await call('GET', `/api/orders/${ids.order}`, staff);
    assert.match(d.body.allowed_actions.complete_blocked_reason, /still unpaid.*40 of 140 pieces/);
    assert.deepEqual([d.body.fulfillment.pieces_delivered, d.body.fulfillment.pieces_remaining, d.body.allowed_actions.max_delivery], [100, 40, 40]);

    assert.equal((await call('POST', `/api/orders/${ids.order}/payments`, staff, { amount: 14962.5, payment_type: 'Cash', payer_name: 'Mrs. Lopez' })).status, 201);
    const stillShort = await call('PATCH', `/api/orders/${ids.order}/status`, staff, { status: 'Completed' });
    assert.deepEqual(stillShort.body.missing.map((m) => m.code), ['PIECES_NOT_DELIVERED']);
    const last = await batch(40, { method: 'Courier', notes: 'LBC tracking 123' });
    assert.equal(last.status, 201, last.text);
    assert.match(last.body.message, /Every piece is now handed over/);
    const done = await call('PATCH', `/api/orders/${ids.order}/status`, staff, { status: 'Completed' });
    assert.equal(done.status, 200, done.text);
    const tracking = done.body.order.tracking_no;
    assert.deepEqual(await stock('i-shirt'), { a: 8, r: 0, cost: (await stock('i-shirt')).cost });
    assert.deepEqual((await card('i-shirt')).at(-1), { movement_type: 'order_used', quantity_change: -140, balance_after: 8, reference_no: tracking });
    assert.equal((await call('POST', `/api/orders/${ids.order}/deliveries`, staff, { quantity: 1 })).body.error, 'DELIVERY_NOT_ALLOWED');

    // One pick-up, no batches recorded: completing records the hand-over of every piece
    assert.equal((await call('PATCH', `/api/orders/${ids.mugOrder}/status`, staff, { status: 'Ready', complete_counts: true })).status, 200);
    const mugDone = await call('PATCH', `/api/orders/${ids.mugOrder}/status`, staff, { status: 'Completed', handover: { received_by_name: 'Juan', method: 'Pick-up' } });
    assert.equal(mugDone.status, 200, mugDone.text);
    assert.deepEqual(await one_("SELECT batch_no, quantity, received_by_name FROM order_deliveries WHERE order_id = $1", [ids.mugOrder]),
      { batch_no: 1, quantity: 5, received_by_name: 'Juan' });
  });

  it('verifies and corrects payments (Owner / Admin), and asks for verification again when money details change', async () => {
    const d = await call('GET', `/api/orders/${ids.order}`, admin);
    assert.equal(d.body.payments.find((p) => p.payment_id === ids.bankPayment).needs_verification, true);
    const path = `/api/orders/${ids.order}/payments/${ids.bankPayment}`;
    assert.equal((await call('POST', `${path}/verify`, staff)).status, 403);
    const v = await call('POST', `${path}/verify`, admin);
    assert.equal(v.status, 200, v.text);
    assert.equal(v.body.payment.verified_by, 'u-admin');
    assert.equal((await call('POST', `${path}/verify`, admin)).body.error, 'ALREADY_VERIFIED');
    assert.equal((await call('PATCH', path, admin, { amount: 1 })).status, 400, 'the amount is never edited');
    const notes = await call('PATCH', path, admin, { payment_notes: 'Deposited Friday' });
    assert.deepEqual([notes.status, Boolean(notes.body.payment.verified_at)], [200, true], 'a note does not need checking again');
    const ref = await call('PATCH', path, admin, { reference_no: 'FT-20261120-02' });
    assert.deepEqual([ref.status, ref.body.payment.verified_at], [200, null]);
    assert.match(ref.body.message, /verified again/);
    assert.equal((await call('PATCH', path, staff, { payment_notes: 'x' })).status, 403);
    const trail = (await pool.query("SELECT action FROM audit_log WHERE entity_id = $1 ORDER BY created_at", [ids.bankPayment])).rows.map((r) => r.action);
    assert.deepEqual(trail, ['payment_verified', 'payment_corrected', 'payment_corrected']);
  });

  it('refunds only what may be refunded, after a price cut or a cancellation', async () => {
    const refund = (order, amount, token = owner, extra = {}) => call('POST', `/api/orders/${order}/refunds`, token,
      { amount, refund_reason: 'Late delivery (price cut)', payment_type: 'Cash', ...extra });
    assert.deepEqual((await refund(ids.order, 100)).body.error, 'REFUND_NOT_ALLOWED', 'fully paid, nothing above the bill');
    assert.equal((await refund(ids.order, 100, staff)).status, 403, 'money back is for the Owner or an Admin');
    const cut = await call('POST', `/api/orders/${ids.order}/price-adjustment`, owner, { adjustment_amount: 1000, adjustment_reason: 'Delivered 2 days late' });
    assert.equal(cut.status, 200, cut.text);
    assert.deepEqual([cut.body.order.total_quote_amount, cut.body.totals.overpaid_by], [30762.5, 1000]);
    assert.match(cut.body.message, /refund it/);
    assert.equal((await call('POST', `/api/orders/${ids.order}/price-adjustment`, owner, { adjustment_amount: 50 })).status, 400, 'a reason is required');
    assert.deepEqual([(await refund(ids.order, 1500)).body.error, (await refund(ids.order, 1500)).body.max_refund], ['REFUND_EXCEEDS_PAID', 1000]);
    const back = await refund(ids.order, 1000, admin);
    assert.equal(back.status, 201, back.text);
    assert.deepEqual([back.body.payment.amount, back.body.payment.is_refund, back.body.totals.payment_status, back.body.totals.total_refunded],
      [-1000, true, 'Fully Paid', 1000]);
    assert.match(back.body.payment.receipt_no, /^AR-/);

    // A cancelled order: everything paid may go back
    const lost = await call('POST', '/api/orders', staff, { customer_id: 'c-2', production_deadline: shopDate(5), required_items: [{ inventory_id: 'i-mug', quantity_needed: 2 }] });
    assert.equal((await call('POST', `/api/orders/${lost.body.order_id}/quote`, owner, {})).status, 200);
    assert.equal((await call('POST', `/api/orders/${lost.body.order_id}/payments`, staff, { amount: 120, payment_type: 'Cash', payer_name: 'Juan Dela Cruz' })).status, 201);
    assert.equal((await call('PATCH', `/api/orders/${lost.body.order_id}/status`, owner, { status: 'Cancelled', cancellation_reason: 'Customer changed mind' })).status, 200);
    assert.equal((await refund(lost.body.order_id, 120, owner, { refund_reason: 'Order cancelled' })).status, 201);
    assert.equal((await refund(lost.body.order_id, 1, owner, { refund_reason: 'Order cancelled' })).body.error, 'NOTHING_TO_REFUND');
  });

  it('keeps a client profile with the order history and the balance due', async () => {
    assert.equal((await call('PATCH', '/api/customers/c-1', staff, { email: 'not-an-email' })).status, 400);
    const r = await call('PATCH', '/api/customers/c-1', staff, {
      customer_type: 'School', contact_person: 'Mrs. Lopez', email: 'pta@agdaonhs.edu.ph', address: 'Agdao, Davao City', social_media: 'fb.com/agdaonhs'
    });
    assert.equal(r.status, 200, r.text);
    assert.equal((await call('PATCH', '/api/customers/c-1', production, { notes: 'x' })).status, 200, 'Production edits clients like Staff');
    const p = await call('GET', '/api/customers/c-1', production);
    assert.equal(p.status, 200, p.text);
    assert.deepEqual([p.body.customer.customer_type, p.body.customer.contact_person], ['School', 'Mrs. Lopez']);
    assert.deepEqual([p.body.totals.order_count, p.body.totals.open_orders], [2, 1], 'the old Pending order and the completed one');
    assert.equal(p.body.totals.total_billed, 30762.5);
    assert.equal(p.body.allowed_actions.edit, true, 'Production edits like Staff');
    assert.equal(p.body.allowed_actions.archive, false, 'archiving stays with the Owner / Admin');
  });

  it('records bulk waste, and reports payments, waste and the month’s transactions', async () => {
    const bulk = await call('POST', '/api/inventory/losses', staff, {
      reason_code: 'damaged_in_storage', lines: [{ inventory_id: 'i-mug', quantity_lost: 2 }, { inventory_id: 'i-ink', quantity_lost: 30 }]
    });
    assert.equal(bulk.status, 201, bulk.text);
    assert.equal(bulk.body.losses.length, 2);
    assert.equal(bulk.body.total_cost, 2 * 60 + 30 * 2);
    assert.deepEqual((await card('i-ink')).at(-1).movement_type, 'loss');
    const short = await call('POST', '/api/inventory/losses', staff, { loss_reason: 'x', lines: [{ inventory_id: 'i-mug', quantity_lost: 9999 }] });
    assert.deepEqual([short.status, short.body.error], [409, 'INSUFFICIENT_STOCK']);

    const waste = await call('GET', '/api/reports/waste', staff);
    assert.equal(waste.status, 200, waste.text);
    assert.deepEqual([waste.body.totals.count, waste.body.totals.cost], [2, null], 'costs stay with Owner / Admin');
    const wasteOwner = await call('GET', '/api/reports/waste', owner);
    assert.equal(wasteOwner.body.totals.cost, 180);

    const pays = await call('GET', '/api/reports/payments', owner);
    assert.equal(pays.status, 200, pays.text);
    assert.equal(pays.body.months.length, 12);
    const kinds = new Set(pays.body.detail.payments.map((p) => p.kind));
    assert.ok(kinds.has('Payment') && kinds.has('Refund'), [...kinds].join(','));
    assert.ok(pays.body.detail.by_method.some((m) => m.payment_type === 'Bank Transfer'));
    assert.equal((await call('GET', '/api/reports/payments', staff)).status, 403);

    const tx = await call('GET', '/api/reports/transactions', owner);
    assert.equal(tx.status, 200, tx.text);
    assert.ok(tx.body.entries.some((e) => e.kind === 'Purchase' && e.reference === `SI-${YEAR}-0001`));
    assert.ok(tx.body.totals.money_in > 0 && tx.body.totals.purchases > 0);

    const movements = await call('GET', '/api/stock/movements?inventory_id=i-shirt', production);
    assert.equal(movements.status, 200);
    // Oldest first: every balance is the one before plus this change, whatever made the change
    const rows = [...movements.body.movements].reverse();
    rows.forEach((m, i) => { if (i > 0) assert.equal(m.balance_after, rows[i - 1].balance_after + m.quantity_change, m.label); });
    assert.equal(movements.body.item.quantity_available, rows.at(-1).balance_after);
    assert.ok(rows.every((m) => m.label && m.performed_by_name));
  });

  it('reserves an offline order’s stock in the cloud as an amount when it syncs (the reservation bug)', async () => {
    // This computer copies the catalog and the customer down, then goes offline and takes an order
    await refreshLocalRows(pool, server.localDb, 'customers', ['c-2']);
    await refreshLocalRows(pool, server.localDb, 'inventory_items', ['i-mug']);
    const before = await stock('i-mug');
    await sqliteRun(server.localDb,
      `INSERT INTO order_profiles (order_id, customer_id, production_deadline, production_status, stock_reserved, sync_status, last_modified)
       VALUES ('o-offline', 'c-2', '2030-01-01T00:00:00', 'Pending', 1, 'pending_insert', '2026-11-20 01:00:00.000')`);
    await sqliteRun(server.localDb,
      `INSERT INTO order_items (line_item_id, order_id, inventory_id, product_type, quantity, sync_status, last_modified)
       VALUES ('l-offline', 'o-offline', 'i-mug', 'Ceramic Mug', 3, 'pending_insert', '2026-11-20 01:00:00.000')`);
    await sqliteRun(server.localDb,
      `UPDATE inventory_items SET quantity_reserved = quantity_reserved + 3, sync_status = 'pending_update',
              dirty_fields = '["quantity_reserved"]', last_modified = '2026-11-20 01:00:00.000' WHERE inventory_id = 'i-mug'`);
    // Meanwhile another branch changes the same item in the cloud (this used to make the push clash)
    await pool.query("UPDATE inventory_items SET minimum_threshold = 7 WHERE inventory_id = 'i-mug'");

    const synced = await call('POST', '/api/sync', owner);
    assert.equal(synced.status, 200, synced.text);
    const after = await stock('i-mug');
    assert.deepEqual([after.a, after.r], [before.a, before.r + 3], 'reserved exactly once, as an amount');
    assert.equal((await one_("SELECT stock_reserved FROM order_profiles WHERE order_id = 'o-offline'")).stock_reserved, true);
    const local = await sqliteGet(server.localDb, "SELECT quantity_reserved, sync_status, sync_conflict FROM inventory_items WHERE inventory_id = 'i-mug'");
    assert.deepEqual([local.quantity_reserved, local.sync_status, local.sync_conflict], [after.r, 'synced', null], 'no conflict left behind');

    // Not enough free stock any more when it arrives: it comes without a reservation and waits for approval
    await sqliteRun(server.localDb,
      `INSERT INTO order_profiles (order_id, customer_id, production_deadline, production_status, stock_reserved, sync_status, last_modified)
       VALUES ('o-offline-2', 'c-2', '2030-01-01T00:00:00', 'Pending', 1, 'pending_insert', '2026-11-20 01:00:00.000')`);
    await sqliteRun(server.localDb,
      `INSERT INTO order_items (line_item_id, order_id, inventory_id, product_type, quantity, sync_status, last_modified)
       VALUES ('l-offline-2', 'o-offline-2', 'i-mug', 'Ceramic Mug', 9999, 'pending_insert', '2026-11-20 01:00:00.000')`);
    assert.equal((await call('POST', '/api/sync', owner)).status, 200);
    assert.equal((await one_("SELECT stock_reserved FROM order_profiles WHERE order_id = 'o-offline-2'")).stock_reserved, false);
    assert.equal((await stock('i-mug')).r, after.r, 'nothing over-committed');
    const detail = await call('GET', '/api/orders/o-offline-2', owner);
    assert.equal(detail.body.stock_check.sufficient, false, 'the screens show the shortage before anyone approves');
  });
});
