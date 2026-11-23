// GET /api/orders?number_search= : keyword search on the order number (offline / local database)
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, shopDate, fixtures } = require('./helpers/testServer');

describe('Order number keyword search', () => {
  let t;
  let token;
  const NUMBERS = ['XM-2026-0012', 'XM-2026-0120', 'XM-2026-1203', 'XM-2026-0045', 'XM-2025-0012'];

  before(async () => {
    t = await startTestServer();
    token = await t.login('staff');
    const item = await t.request('POST', '/api/inventory', { token, body: fixtures.ITEMS[0] });
    const customer = await t.request('POST', '/api/customers', { token, body: fixtures.CUSTOMERS[0] });
    for (const number of NUMBERS) {
      const r = await t.request('POST', '/api/orders', {
        token,
        body: {
          customer_id: customer.body.customer.customer_id,
          production_deadline: shopDate(10),
          required_items: [{ inventory_id: item.body.item.inventory_id, quantity_needed: 1 }]
        }
      });
      assert.equal(r.status, 201, r.text);
      await t.run('UPDATE order_profiles SET tracking_no = ? WHERE order_id = ?', [number, r.body.order.order_id]);
    }
  });
  after(async () => { await t.close(); });

  const search = async (text, extra = '') => {
    const r = await t.request('GET', `/api/orders?number_search=${encodeURIComponent(text)}${extra}`, { token });
    assert.equal(r.status, 200, r.text);
    return r.body.orders.map((o) => o.tracking_no);
  };

  it('finds numbers containing the typed digits, closest match first', async () => {
    const found = await search('12');
    assert.deepEqual(found.slice(0, 2).sort(), ['XM-2025-0012', 'XM-2026-0012'], 'exact running numbers first');
    assert.deepEqual(found.slice(2), ['XM-2026-0120', 'XM-2026-1203']);
    assert.ok(!found.includes('XM-2026-0045'), 'unrelated numbers are left out');
  });

  it('matches digits inside the running number only, not the year', async () => {
    assert.deepEqual(await search('2026'), [], 'no running number contains 2026');
    assert.deepEqual(await search('45'), ['XM-2026-0045']);
  });

  it('accepts a full or partial number in any case', async () => {
    assert.deepEqual(await search('xm-2026-0012'), ['XM-2026-0012']);
    assert.deepEqual((await search('2025-')), ['XM-2025-0012']);
  });

  it('combines with the other filters and sorts', async () => {
    const found = await search('12', '&sort=production_deadline&dir=asc&status=Pending');
    assert.equal(found.length, 4);
  });

  it('refuses wildcards and other characters with a clear message', async () => {
    for (const bad of ['%', '1_2', "12'", 'a b']) {
      const r = await t.request('GET', `/api/orders?number_search=${encodeURIComponent(bad)}`, { token });
      assert.equal(r.status, 400, bad);
      assert.match(JSON.stringify(r.body), /letters, numbers and dashes/);
    }
  });

  it('treats an empty search as no search', async () => {
    assert.equal((await search('  ')).length, NUMBERS.length);
  });
});
