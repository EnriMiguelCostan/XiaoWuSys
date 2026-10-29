// Dashboard and Excel exports, plus general API safety (headers, CORS, unknown routes)
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, shopDate, fixtures } = require('./helpers/testServer');

describe('Dashboard and exports', () => {
  let t;
  let owner;
  const items = {};
  let customerId;

  before(async () => {
    t = await startTestServer();
    owner = await t.login('owner');
    await t.login('staff');
    for (const it of fixtures.ITEMS) {
      items[it.item_name] = (await t.request('POST', '/api/inventory', { token: owner, body: it })).body.item.inventory_id;
    }
    customerId = (await t.request('POST', '/api/customers', { token: owner, body: { ...fixtures.CUSTOMERS[0], full_name: '=HYPERLINK("http://evil")' } })).body.customer.customer_id;
    const o = await t.request('POST', '/api/orders', {
      token: owner,
      body: { customer_id: customerId, production_deadline: shopDate(2), total_quote_amount: 3000, required_items: [{ inventory_id: items['Custom Shirt'], quantity_needed: 20 }] }
    });
    await t.request('POST', `/api/orders/${o.body.order_id}/payments`, { token: owner, body: { amount: 1500, payment_type: 'Cash' } });
  });
  after(async () => { await t.close(); });

  it('summarises orders due, unpaid balances, income and the restock list', async () => {
    const r = await t.request('GET', '/api/reports/dashboard', { token: t.tokens.staff });
    assert.equal(r.status, 200, r.text);
    const d = r.body;
    assert.equal(d.orders.open, 1);
    assert.equal(d.orders.due_this_week.length, 1);
    assert.equal(d.orders.outstanding_balance, 1500);
    assert.equal(d.income_by_month.length, 6);
    assert.equal(d.income_by_month.at(-1).amount, 1500, 'this month');
    assert.equal(d.top_materials[0].item_name, 'Custom Shirt');
    const restockNames = d.inventory.restock.map((x) => x.item_name);
    assert.deepEqual(restockNames, ['Sublimation Ink (Cyan)', 'Deli A4 Paper', 'Quaff Sublimation Transfer Paper']);
    assert.equal(d.inventory.restock[0].suggested_order, 2, 'brings free stock up to twice the low-stock alert');
  });

  it('exports the inventory as an Excel-ready CSV', async () => {
    const r = await t.request('GET', '/api/reports/export/inventory.csv', { token: t.tokens.staff });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/csv/);
    assert.match(r.headers.get('content-disposition'), /attachment; filename="xiaomei-inventory-\d{4}-\d{2}-\d{2}\.csv"/);
    assert.equal(r.text.charCodeAt(0), 0xfeff, 'BOM so Excel shows ₱ and ñ correctly');
    const lines = r.text.slice(1).trim().split('\r\n');
    assert.equal(lines.length, fixtures.ITEMS.length + 1);
    assert.match(lines[0], /^Item,Category,Unit,Supplier,On hand/);
    assert.ok(lines.some((l) => l.startsWith('Custom Shirt,Apparel,pcs,Davao Garments Supply,381,20,361,')));
  });

  it('protects exported spreadsheets from formula injection', async () => {
    const r = await t.request('GET', '/api/reports/export/orders.csv', { token: owner });
    assert.equal(r.status, 200);
    assert.ok(r.text.includes(`"'=HYPERLINK(""http://evil"")"`), 'a customer name starting with = is exported as text');
    assert.ok(r.text.includes('Custom Shirt x20'));
  });

  it('keeps money exports for Owner and Admin', async () => {
    assert.equal((await t.request('GET', '/api/reports/export/payments.csv', { token: t.tokens.staff })).status, 403);
    const r = await t.request('GET', '/api/reports/export/payments.csv', { token: owner });
    assert.equal(r.status, 200);
    assert.match(r.text, /Cash,1500/);
  });
});

describe('API safety', () => {
  let t;
  before(async () => { t = await startTestServer({ corsOrigins: ['http://localhost:5173'] }); });
  after(async () => { await t.close(); });

  it('sends security headers and hides the framework', async () => {
    const r = await t.request('GET', '/api/status');
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('x-frame-options'), 'DENY');
    assert.equal(r.headers.get('x-powered-by'), null);
  });

  it('only allows the configured frontend address (CORS)', async () => {
    const good = await t.request('GET', '/api/status', { headers: { Origin: 'http://localhost:5173' } });
    assert.equal(good.headers.get('access-control-allow-origin'), 'http://localhost:5173');
    const bad = await t.request('GET', '/api/status', { headers: { Origin: 'https://evil.example' } });
    assert.equal(bad.headers.get('access-control-allow-origin'), null);
  });

  it('answers unknown routes and broken JSON with structured errors', async () => {
    const missing = await t.request('GET', '/api/nothing-here');
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error, 'NOT_FOUND');
    const broken = await t.request('POST', '/api/auth/login', { body: '{"username": ' });
    assert.equal(broken.status, 400);
    assert.equal(broken.body.error, 'INVALID_JSON');
  });
});
