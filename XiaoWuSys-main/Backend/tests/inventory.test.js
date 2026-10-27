// Catalog: adding, duplicates, stock changes, edits, Recycle Bin and the hidden audit trail,
// populated with the printshop's real items (tests/fixtures/data.js)
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, fixtures } = require('./helpers/testServer');

describe('Inventory catalog', () => {
  let t;
  let admin;
  const ids = {};
  const item = (name) => ids[name];

  before(async () => {
    t = await startTestServer();
    admin = await t.login('admin');
    await t.login('staff');
  });
  after(async () => { await t.close(); });

  it('adds every whiteboard item, with its unit and supplier', async () => {
    for (const it of fixtures.ITEMS) {
      const r = await t.request('POST', '/api/inventory', { token: admin, body: it });
      assert.equal(r.status, 201, `${it.item_name}: ${r.text}`);
      assert.equal(r.body.item.unit, it.unit);
      assert.equal(r.body.item.supplier, it.supplier || null);
      assert.match(r.body.message, /saved locally/);
      ids[it.item_name] = r.body.item.inventory_id;
    }
  });

  it('counts In Stock / Low Stock / Out of Stock correctly', async () => {
    const r = await t.request('GET', '/api/inventory', { token: t.tokens.staff });
    assert.equal(r.status, 200);
    assert.equal(r.body.source, 'local');
    assert.deepEqual(
      { total: r.body.summary.total_items, in: r.body.summary.in_stock, low: r.body.summary.low_stock, out: r.body.summary.out_of_stock },
      { total: 9, in: 6, low: 2, out: 1 }
    );
    const ink = r.body.items.find((i) => i.item_name === 'Sublimation Ink (Cyan)');
    assert.equal(ink.stock_status, 'out_of_stock');
  });

  it('rejects duplicates, ignoring capital letters and spaces', async () => {
    for (const name of ['custom shirt', '  CUSTOM   SHIRT ', 'CustomShirt']) {
      const r = await t.request('POST', '/api/inventory', { token: admin, body: { item_name: name, item_category: 'Apparel' } });
      assert.equal(r.status, 409, name);
      assert.equal(r.body.error, 'DUPLICATE_ITEM');
      assert.equal(r.body.existing.inventory_id, item('Custom Shirt'));
    }
  });

  it('explains wrong input in plain language', async () => {
    const r = await t.request('POST', '/api/inventory', { token: admin, body: { item_name: 'Test', item_category: 'X', quantity_available: '5' } });
    assert.equal(r.status, 400);
    assert.equal(r.body.message, 'Quantity in stock must be a whole number, like 1, 5 or 20.');
    assert.equal(r.body.details[0].field, 'quantity_available');
  });

  it('only lets Owner / Admin / Production change the catalog', async () => {
    const r = await t.request('POST', '/api/inventory', { token: t.tokens.staff, body: { item_name: 'Ballpen', item_category: 'Office' } });
    assert.equal(r.status, 403);
  });

  it('adds and subtracts stock, and never goes below zero', async () => {
    const id = item('Valiant Columnar Notebook');
    let r = await t.request('POST', `/api/inventory/${id}/adjust`, { token: admin, body: { action: 'add', quantity: 7 } });
    assert.equal(r.status, 200);
    assert.equal(r.body.item.quantity_available, 10);
    r = await t.request('POST', `/api/inventory/${id}/adjust`, { token: admin, body: { action: 'subtract', quantity: 10 } });
    assert.equal(r.body.item.quantity_available, 0);
    assert.equal(r.body.item.stock_status, 'out_of_stock');
    r = await t.request('POST', `/api/inventory/${id}/adjust`, { token: admin, body: { action: 'subtract', quantity: 1 } });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'INSUFFICIENT_STOCK');
  });

  it('records lost / damaged stock with its cost', async () => {
    const r = await t.request('POST', `/api/inventory/${item('Custom Shirt')}/loss`, {
      token: admin, body: { quantity_lost: 2, loss_reason: 'Ink stain during printing' }
    });
    assert.equal(r.status, 201);
    assert.equal(r.body.item.quantity_available, 379);
    assert.equal(r.body.loss.financial_cost, 300, '2 shirts x ₱150');
    const trace = await t.get("SELECT details FROM inventory_audit_log WHERE action = 'stock_subtracted' AND details LIKE '%loss%'");
    assert.equal(JSON.parse(trace.details).reason, 'Ink stain during printing', 'the loss is in the audit trail too');
  });

  it('edits details (including unit and supplier) but blocks a duplicate name', async () => {
    const id = item('Deli A4 Paper');
    let r = await t.request('PATCH', `/api/inventory/${id}`, { token: admin, body: { unit: 'box', supplier: 'NCCC Office Supplies', unit_cost: 240.5 } });
    assert.equal(r.status, 200);
    assert.deepEqual([r.body.item.unit, r.body.item.supplier, r.body.item.unit_cost], ['box', 'NCCC Office Supplies', 240.5]);
    r = await t.request('PATCH', `/api/inventory/${id}`, { token: admin, body: { item_name: 'b&e oslo drawing paper' } });
    assert.equal(r.status, 409);
  });

  it('moves a deleted item to the Recycle Bin and restores it', async () => {
    const id = item('Vinyl Sticker Paper');
    let r = await t.request('DELETE', `/api/inventory/${id}`, { token: admin });
    assert.equal(r.status, 200);
    let list = await t.request('GET', '/api/inventory', { token: admin });
    assert.ok(!list.body.items.some((i) => i.inventory_id === id), 'hidden from the catalog');
    assert.equal(list.body.summary.recycle_bin, 1);
    const bin = await t.request('GET', '/api/inventory/recycle-bin', { token: admin });
    assert.equal(bin.body.items[0].inventory_id, id);
    r = await t.request('POST', `/api/inventory/${id}/restore`, { token: admin });
    assert.equal(r.status, 200);
    list = await t.request('GET', '/api/inventory', { token: admin });
    assert.ok(list.body.items.some((i) => i.inventory_id === id));
  });

  it('keeps search input as plain text (no SQL injection)', async () => {
    const r = await t.request('GET', `/api/inventory?search=${encodeURIComponent("' OR 1=1 --")}`, { token: admin });
    assert.equal(r.status, 200);
    assert.equal(r.body.items.length, 0);
    const odd = await t.request('POST', '/api/inventory', { token: admin, body: { item_name: "Robert'); DROP TABLE inventory_items;--", item_category: 'Test' } });
    assert.equal(odd.status, 201);
    const again = await t.request('GET', '/api/inventory', { token: admin });
    assert.equal(again.body.summary.total_items, 10, 'the table is still there, with the odd name stored as text');
  });

  it('writes a hidden audit trail for every change', async () => {
    const rows = await t.all('SELECT action FROM inventory_audit_log');
    const actions = new Set(rows.map((r) => r.action));
    for (const a of ['created', 'edited', 'stock_added', 'stock_subtracted', 'deleted', 'restored']) assert.ok(actions.has(a), a);
    const routes = await t.request('GET', '/api/inventory/audit-log', { token: admin });
    assert.equal(routes.status, 404, 'the audit trail is not exposed on the website');
  });
});
