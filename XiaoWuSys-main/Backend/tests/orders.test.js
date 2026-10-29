// Customers, order profiles, stock reservation, payments and editing (offline / local database)
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, shopDate, fixtures } = require('./helpers/testServer');

describe('Customers and orders', () => {
  let t;
  let token;
  const items = {};
  const customers = {};

  before(async () => {
    t = await startTestServer();
    token = await t.login('production');
    await t.login('staff');
    for (const it of fixtures.ITEMS) {
      const r = await t.request('POST', '/api/inventory', { token, body: it });
      items[it.item_name] = r.body.item.inventory_id;
    }
  });
  after(async () => { await t.close(); });

  it('saves customers with an 11-digit mobile number starting with 0', async () => {
    for (const c of fixtures.CUSTOMERS) {
      const r = await t.request('POST', '/api/customers', { token, body: c });
      assert.equal(r.status, 201, r.text);
      customers[c.full_name] = r.body.customer.customer_id;
    }
    const spaced = await t.request('POST', '/api/customers', { token, body: { full_name: 'Ana Reyes', contact_number: '0917 555 0000' } });
    assert.equal(spaced.body.customer.contact_number, '09175550000', 'spaces are removed');
  });

  it('rejects a wrong mobile number with a clear message', async () => {
    for (const bad of ['9171234567', '091712345678', '19171234567', '+639171234567']) {
      const r = await t.request('POST', '/api/customers', { token, body: { full_name: 'Bad Number', contact_number: bad } });
      assert.equal(r.status, 400, bad);
      assert.equal(r.body.message, 'Mobile number must be exactly 11 digits and start with 0, like 09171234567.');
    }
  });

  it('does not save the same customer twice', async () => {
    const r = await t.request('POST', '/api/customers', { token, body: { full_name: 'juan dela cruz', contact_number: '09171234567' } });
    assert.equal(r.status, 409);
    assert.equal(r.body.existing.customer_id, customers['Juan Dela Cruz']);
  });

  let orderId;
  it('creates an order and reserves its materials in the catalog', async () => {
    const r = await t.request('POST', '/api/orders', {
      token,
      body: {
        customer_id: customers['Agdao National High School'],
        production_deadline: shopDate(10),
        total_quote_amount: 52500,
        required_items: [
          { inventory_id: items['Custom Shirt'], quantity_needed: 300 },
          { inventory_id: items['Custom Shirt'], quantity_needed: 50 },
          { inventory_id: items['Quaff Sublimation Transfer Paper'], quantity_needed: 1 }
        ]
      }
    });
    assert.equal(r.status, 201, r.text);
    assert.equal(r.body.items.length, 2, 'two lines of the same material are merged');
    assert.equal(r.body.order.stock_reserved, true);
    orderId = r.body.order_id;

    const cat = await t.request('GET', '/api/inventory', { token });
    const shirt = cat.body.items.find((i) => i.inventory_id === items['Custom Shirt']);
    assert.deepEqual([shirt.quantity_reserved, shirt.quantity_available_net, shirt.stock_status], [350, 31, 'low_stock']);
    assert.ok(t.pushes.some((p) => p.reason === 'order_reserved'), 'other screens are told to refresh');
  });

  it('stops an order that needs more than the free stock, and saves nothing', async () => {
    const before = (await t.get('SELECT COUNT(*) AS n FROM order_profiles')).n;
    const r = await t.request('POST', '/api/orders', {
      token,
      body: { customer_id: customers['Juan Dela Cruz'], production_deadline: shopDate(5), required_items: [{ inventory_id: items['Custom Shirt'], quantity_needed: 32 }] }
    });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'INSUFFICIENT_INVENTORY');
    assert.equal(r.body.shortages[0].available, 31);
    assert.equal((await t.get('SELECT COUNT(*) AS n FROM order_profiles')).n, before);
  });

  it('can log the halted order as Delayed without reserving stock', async () => {
    const r = await t.request('POST', '/api/orders', {
      token,
      body: {
        customer_id: customers['Juan Dela Cruz'], production_deadline: shopDate(20), resolution: 'Delayed',
        required_items: [{ inventory_id: items['Custom Shirt'], quantity_needed: 32 }]
      }
    });
    assert.equal(r.status, 201);
    assert.equal(r.body.production_status, 'Delayed');
    assert.equal(r.body.order.stock_reserved, false);
  });

  it('explains a deadline in the past in plain language', async () => {
    const r = await t.request('POST', '/api/orders', {
      token,
      body: { customer_id: customers['Maria Santos'], production_deadline: shopDate(-3), required_items: [{ inventory_id: items['Deli A4 Paper'], quantity_needed: 1 }] }
    });
    assert.equal(r.status, 400);
    assert.match(r.body.message, /^Production deadline cannot be a date that has already passed\. Please choose today \(.+\) or a later date\.$/);
  });

  it('records payments and shows the balance', async () => {
    let r = await t.request('POST', `/api/orders/${orderId}/payments`, { token, body: { amount: 26250, payment_type: 'GCash' } });
    assert.equal(r.status, 201);
    r = await t.request('POST', `/api/orders/${orderId}/payments`, { token, body: { amount: 1000.5, payment_type: 'Cash' } });
    assert.equal(r.status, 201);
    const d = await t.request('GET', `/api/orders/${orderId}`, { token: t.tokens.staff });
    assert.equal(d.status, 200);
    assert.deepEqual([d.body.totals.total_paid, d.body.totals.balance], [27250.5, 25249.5]);
  });

  it('edits the deadline and quote of an open order', async () => {
    const r = await t.request('PATCH', `/api/orders/${orderId}/details`, { token, body: { production_deadline: shopDate(14), total_quote_amount: 53000 } });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.body.changed.sort(), ['production_deadline', 'total_quote_amount']);
    assert.equal(r.body.order.total_quote_amount, 53000);
    assert.equal(r.body.order.production_deadline.slice(0, 10), shopDate(14));
    const none = await t.request('PATCH', `/api/orders/${orderId}/details`, { token, body: { total_quote_amount: 53000 } });
    assert.deepEqual(none.body.changed, []);
    const staff = await t.request('PATCH', `/api/orders/${orderId}/details`, { token: t.tokens.staff, body: { total_quote_amount: 1 } });
    assert.equal(staff.status, 403);
  });

  it('adds print details (sizes, names, numbers) to an order', async () => {
    const r = await t.request('POST', `/api/orders/${orderId}/items`, {
      token, body: { product_type: 'Jersey print', quantity: 1, size: 'L', custom_name: 'DELA CRUZ', custom_number: '7' }
    });
    assert.equal(r.status, 201, r.text);
    const d = await t.request('GET', `/api/orders/${orderId}`, { token });
    assert.ok(d.body.items.some((i) => i.custom_name === 'DELA CRUZ' && i.size === 'L'));
  });

  it('lists orders newest first and filters by customer', async () => {
    const all = await t.request('GET', '/api/orders', { token: t.tokens.staff });
    assert.equal(all.body.orders.length, 2);
    const one = await t.request('GET', `/api/orders?customer_id=${customers['Juan Dela Cruz']}`, { token });
    assert.equal(one.body.orders.length, 1);
    assert.equal(one.body.orders[0].production_status, 'Delayed');
  });

  it('keeps stock-moving actions online-only, with a clear reason', async () => {
    const status = await t.request('PATCH', `/api/orders/${orderId}/status`, { token, body: { status: 'Cancelled' } });
    assert.equal(status.status, 503);
    assert.equal(status.body.error, 'STATUS_CHANGE_REQUIRES_CLOUD');
  });

  it('does not let a deleted material be ordered', async () => {
    const vinyl = items['Vinyl Sticker Paper'];
    assert.equal((await t.request('DELETE', `/api/inventory/${vinyl}`, { token })).status, 200);
    const r = await t.request('POST', '/api/orders', {
      token, body: { customer_id: customers['Maria Santos'], production_deadline: shopDate(3), required_items: [{ inventory_id: vinyl, quantity_needed: 1 }] }
    });
    assert.equal(r.status, 404);
    assert.equal(r.body.error, 'INVENTORY_ITEM_NOT_FOUND');
  });

  it('blocks deleting a material that an order has reserved', async () => {
    const r = await t.request('DELETE', `/api/inventory/${items['Custom Shirt']}`, { token });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'ITEM_RESERVED');
  });
});
