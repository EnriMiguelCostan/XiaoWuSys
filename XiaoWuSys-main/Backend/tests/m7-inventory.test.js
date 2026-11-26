// ==========================================
// MIGRATION 015 ON THE OFFLINE SERVER (SQLite cache, cloud switched off)
// What still works while the internet is down, and what says it needs the cloud:
//   the forms' option lists come from the server; a client profile can be edited offline
//   (synced later); suppliers are listed from this computer's copy; print details can be added;
//   stock in / out / count, deliveries, refunds and payment checks answer 503 and save nothing;
//   payment details are checked offline exactly like online; the roles swapped places.
// ==========================================
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, shopDate, fixtures } = require('./helpers/testServer');
const { checkPrintLine, overListed } = require('../services/domain/printDetails');
const { plannedChanges, countResult, averageAfterAddC, averageAfterRemoveC, checkLines } = require('../services/domain/stockDocuments');
const { checkPaymentDetails, checkRefund, maxRefund } = require('../services/domain/payments');
const { completionCheck, fulfillmentSummary } = require('../services/domain/orderLifecycle');
const { computeQuote, resolveAdjustment } = require('../services/domain/pricing');
const { can, outranks } = require('../services/domain/permissions');

describe('Migration 015 rules (no database)', () => {
  it('works out the average unit cost in centavos, in and out', () => {
    assert.equal(averageAfterAddC({ onHand: 100, costC: 10000, addQty: 50, addCostC: 13000 }), 11000);
    assert.equal(averageAfterAddC({ onHand: 0, costC: 999, addQty: 5, addCostC: 5000 }), 5000, 'nothing on hand: the new cost');
    assert.equal(averageAfterRemoveC({ onHand: 150, costC: 11000, removeQty: 50, removeCostC: 13000 }), 10000, 'a void takes it back out');
    assert.equal(averageAfterRemoveC({ onHand: 50, costC: 13000, removeQty: 50, removeCostC: 13000 }), 13000, 'nothing left: unchanged');
  });

  it('moves stock by the net difference, and needs free stock only for what it takes', () => {
    const items = new Map([['a', { quantity_available: 20, quantity_reserved: 15, unit_cost: '10.00', item_name: 'Blank' }]]);
    const edit = plannedChanges('stock_in', [{ inventory_id: 'a', quantity: 10, unit_cost: 10 }], [{ inventory_id: 'a', quantity: 8, unit_cost: 10 }], items);
    assert.deepEqual([edit.changes[0].delta, edit.problems], [-2, []]);
    const voided = plannedChanges('stock_in', [{ inventory_id: 'a', quantity: 10, unit_cost: 10 }], [], items);
    assert.deepEqual(voided.problems, [{ inventory_id: 'a', item_name: 'Blank', needed: 10, free: 5 }]);
    const out = plannedChanges('stock_out', [], [{ inventory_id: 'a', quantity: 5 }], items);
    assert.deepEqual([out.changes[0].delta, out.problems], [-5, []]);
    const count = countResult([{ inventory_id: 'a', counted_quantity: 12 }], items);
    assert.deepEqual([count.lines[0].difference, count.problems.length, count.value_difference], [-8, 1, 80], 'below the 15 held: refused');
    assert.equal(checkLines('stock_in', [{ inventory_id: 'a', quantity: 1, unit_cost: 1.234 }]).errors.length, 1, 'centavos only');
  });

  it('puts sizes and numbers on garments only, and never more pieces than the material', () => {
    const shirt = { line_item_id: 'l1', quantity: 2, has_sizes: true, item_name: 'Shirt' };
    const mug = { line_item_id: 'l2', quantity: 2, has_sizes: false, item_name: 'Mug' };
    assert.deepEqual(checkPrintLine({ print_type: 'Jersey', quantity: 1, size: 'M', custom_number: '07' }, shirt).errors, []);
    assert.deepEqual(checkPrintLine({ print_type: 'Mug', quantity: 1, size: 'M' }, mug).errors.map((e) => e.field), ['size']);
    assert.deepEqual(checkPrintLine({ print_type: 'Mug', quantity: 1, custom_name: 'Happy 50th, Lola!' }, mug).errors, [], 'text on a mug');
    assert.deepEqual(overListed([shirt], [{ line_item_id: 'l1', quantity: 2, print_detail_id: 'p1' }], [{ line_item_id: 'l1', quantity: 1 }]),
      [{ line_item_id: 'l1', item_name: 'Shirt', listed: 3, ordered: 2 }]);
  });

  it('offers realistic garment sizes and understands how rosters write them', () => {
    const { GARMENT_SIZES, normalizeSize } = require('../services/domain/printDetails');
    assert.deepEqual(GARMENT_SIZES, ['Kids S', 'Kids M', 'Kids L', 'Kids XL', 'XS', 'S', 'M', 'L', 'XL', '2XL', '3XL', 'Free size']);
    assert.deepEqual(['xl', ' xxl ', 'Medium', 'kids m', 'XXXL', 'free size'].map(normalizeSize), ['XL', '2XL', 'M', 'Kids M', '3XL', 'Free size']);
    const shirt = { line_item_id: 'l1', quantity: 5, has_sizes: true, item_name: 'Shirt' };
    assert.equal(checkPrintLine({ print_type: 'Jersey', quantity: 1, size: 'xxl' }, shirt).line.size, '2XL');
    assert.deepEqual(checkPrintLine({ print_type: 'Jersey', quantity: 1, size: 'Kids 10' }, shirt).errors, [], 'old lines stay editable');
    assert.equal(checkPrintLine({ print_type: 'Jersey', quantity: 1, size: 'huge' }, shirt).errors[0].field, 'size');
  });

  it('knows what each payment method needs, and what may be refunded', () => {
    assert.deepEqual(checkPaymentDetails('Cheque', { bank_name: 'BPI' }).errors.map((e) => e.field), ['payer_name', 'cheque_no', 'cheque_date'], 'migration 017: who paid is required');
    assert.equal(checkPaymentDetails('Cheque', { bank_name: 'BPI', cheque_no: '0012', cheque_date: '2026-02-30', payer_name: 'Ana' }).errors[0].field, 'cheque_date');
    assert.deepEqual(checkPaymentDetails('Cash', { reference_no: 'x' }).details.reference_no, null, 'unused details are not kept');
    assert.deepEqual(checkPaymentDetails('Maya', {}, { allOptional: true }).errors, [], 'a refund forces nothing');
    assert.equal(maxRefund({ status: 'Cancelled', quote: 1000, paidNet: 600 }), 600);
    assert.equal(maxRefund({ status: 'Completed', quote: 1000, paidNet: 1200 }), 200);
    assert.equal(checkRefund({ status: 'Printing', quote: 1000, paidNet: 1000, amount: 1 }).body.error, 'REFUND_NOT_ALLOWED');
  });

  it('says what an order still needs before it is Completed', () => {
    const f = fulfillmentSummary({ pieces_ordered: 10, deliveries: [{ quantity: 4 }] });
    const c = completionCheck({ order: { production_status: 'Printing' }, summary: { quote: 1000, remaining: 300 }, fulfillment: f });
    assert.deepEqual(c.missing.map((m) => m.code), ['NOT_READY', 'BALANCE_DUE', 'PIECES_NOT_DELIVERED'], 'migration 017: Completed only from Ready');
    const once = completionCheck({ order: { production_status: 'Ready' }, summary: { quote: 1000, remaining: 0 }, fulfillment: fulfillmentSummary({ pieces_ordered: 10 }) });
    assert.deepEqual([once.ready, once.auto_handover], [true, true], 'a single pick-up is recorded on completion');
  });

  it('prices labor and incidental charges, and cuts a price after approval with a reason', () => {
    const items = [{ line_item_id: 'a', product_type: 'Shirt', quantity: 10, inventory_id: 'i', item_name: 'Shirt', selling_price: '100.00' }];
    const { quote } = computeQuote({ items, requested: { labor: 200, incidental_percent: 10 } });
    assert.deepEqual([quote.subtotal_amount, quote.incidental_amount, quote.total_quote_amount], [1000, 120, 1320]);
    const kept = computeQuote({ items, existing: { amount: 0, labor: 200, incidental: 120 } }).quote;
    assert.equal(kept.total_quote_amount, 1320, 're-pricing keeps the labor and incidental charges');
    const order = { total_quote_amount: 1320, subtotal_amount: 1000, labor_amount: 200, incidental_amount: 120, discount_amount: 0, adjustment_amount: 0 };
    assert.equal(resolveAdjustment(order, { amount: 2000, reason: 'x' }).problem.body.error, 'ADJUSTMENT_TOO_LARGE');
    assert.equal(resolveAdjustment(order, { amount: 20, reason: 'Late' }).totalC, 130000);
  });

  it('gives Staff and Production the same day-to-day work', () => {
    assert.ok(can('Staff', 'create_order') && can('Staff', 'receive_stock') && !can('Staff', 'count_stock'));
    assert.ok(can('Production', 'create_order') && can('Production', 'receive_stock') && !can('Production', 'count_stock'));
    assert.ok(!outranks('Staff', 'Production') && !outranks('Production', 'Staff'));
  });
});

describe('Migration 015 on the offline server', () => {
  let t;
  let staff; let production;
  let customer; let shirt; let order;

  before(async () => {
    t = await startTestServer();
    await t.login('owner');
    staff = await t.login('staff');
    production = await t.login('production');
    shirt = (await t.request('POST', '/api/inventory', { token: staff, body: fixtures.ITEMS[0] })).body.item.inventory_id;
    customer = (await t.request('POST', '/api/customers', {
      token: staff, body: { full_name: 'Agdao NHS', contact_number: '09171234567', customer_type: 'School', email: 'pta@agdaonhs.edu.ph' }
    })).body.customer;
    order = (await t.request('POST', '/api/orders', {
      token: staff, body: { customer_id: customer.customer_id, production_deadline: shopDate(9), required_items: [{ inventory_id: shirt, quantity_needed: 3 }] }
    })).body;
  });
  after(async () => { await t.close(); });

  it('sends the option lists the forms show', async () => {
    const orders = await t.request('GET', '/api/orders/options', { token: production });
    assert.equal(orders.status, 200, orders.text);
    assert.deepEqual(orders.body.payment_methods.map((m) => m.value),
      ['Cash', 'GCash', 'Maya', 'PayPal', 'Bank Transfer', 'Cheque', 'Credit/Debit Card', 'Other']);
    assert.ok(orders.body.payment_methods.find((m) => m.value === 'Cheque').fields.some((f) => f.name === 'cheque_date' && f.required && f.type === 'date'));
    const stockOptions = await t.request('GET', '/api/stock/options', { token: production });
    assert.deepEqual([stockOptions.body.can_record.stock_in, stockOptions.body.can_void], [true, false], 'Production records stock like Staff');
    assert.equal((await t.request('GET', '/api/stock/options', { token: staff })).body.can_record.stock_in, true);
    assert.ok((await t.request('GET', '/api/customers/options', { token: staff })).body.customer_types.includes('School'));
  });

  it('keeps the client profile, and lets it be edited offline', async () => {
    assert.deepEqual([customer.customer_type, customer.email], ['School', 'pta@agdaonhs.edu.ph']);
    const r = await t.request('PATCH', `/api/customers/${customer.customer_id}`, { token: staff, body: { contact_person: 'Mrs. Lopez', address: 'Agdao' } });
    assert.deepEqual([r.status, r.body.source, r.body.customer.contact_person], [200, 'local', 'Mrs. Lopez']);
    const p = await t.request('GET', `/api/customers/${customer.customer_id}`, { token: production });
    assert.deepEqual([p.body.totals.order_count, p.body.totals.open_orders, p.body.allowed_actions.edit], [1, 1, true]);
  });

  it('checks payment details offline the same way, and keeps a payment date in the past', async () => {
    const id = order.order_id;
    await t.run('UPDATE order_profiles SET total_quote_amount = 900 WHERE order_id = ?', [id]);
    const missing = await t.request('POST', `/api/orders/${id}/payments`, { token: staff, body: { amount: 100, payment_type: 'Maya', payer_name: 'Juan Dela Cruz' } });
    assert.deepEqual([missing.status, missing.body.details[0].field], [400, 'reference_no']);
    const future = await t.request('POST', `/api/orders/${id}/payments`, { token: staff, body: { amount: 100, payment_type: 'Cash', payer_name: 'Juan Dela Cruz', payment_date: '2033-01-01T10:00' } });
    assert.deepEqual([future.status, future.body.details[0].field], [400, 'payment_date']);
    const ok = await t.request('POST', `/api/orders/${id}/payments`, {
      token: staff, body: { amount: 100, payment_type: 'Maya', reference_no: '5551 2345 6789', payer_name: 'Mrs. Lopez', payment_date: '2026-01-05T15:00' }
    });
    assert.deepEqual([ok.status, ok.body.source, ok.body.payment.payment_date], [201, 'local', '2026-01-05T07:00:00'], '3 PM in Manila is 7 AM UTC');
    const row = await t.get('SELECT reference_no, payer_name FROM payments WHERE payment_id = ?', [ok.body.payment.payment_id]);
    assert.deepEqual(row, { reference_no: '5551 2345 6789', payer_name: 'Mrs. Lopez' });
  });

  it('adds print details offline; the rest needs the cloud and saves nothing', async () => {
    const id = order.order_id;
    const line = await t.request('POST', `/api/orders/${id}/print-details`, { token: staff, body: { print_type: 'Jersey print', quantity: 1, size: 'S' } });
    assert.deepEqual([line.status, line.body.source], [201, 'local']);
    const cloudOnly = [
      ['POST', `/api/orders/${id}/deliveries`, { quantity: 1 }, 'DELIVERY_REQUIRES_CLOUD'],
      ['POST', `/api/orders/${id}/refunds`, { amount: 1, refund_reason: 'Order cancelled', payment_type: 'Cash', payer_name: 'Juan Dela Cruz' }, null],
      ['POST', '/api/suppliers', { supplier_name: 'Offline Supply' }, 'SUPPLIER_REQUIRES_CLOUD'],
      ['PATCH', `/api/orders/${id}/print-details/${line.body.print_detail.print_detail_id}`, { quantity: 1 }, 'PRINT_DETAIL_REQUIRES_CLOUD']
    ];
    for (const [method, path, body, error] of cloudOnly) {
      const r = await t.request(method, path, { token: method === 'POST' && path.endsWith('refunds') ? t.tokens.owner : staff, body });
      assert.equal(r.status, 503, `${path}: ${r.text}`);
      if (error) assert.equal(r.body.error, error);
    }
    const gone = await t.request('DELETE', `/api/orders/${id}/print-details/${line.body.print_detail.print_detail_id}`, { token: staff });
    assert.deepEqual([gone.status, gone.body.source], [200, 'local'], 'a line still waiting to sync is removed here');
    const suppliers = await t.request('GET', '/api/suppliers', { token: production });
    assert.deepEqual([suppliers.status, suppliers.body.source], [200, 'local']);
    const movements = await t.request('GET', '/api/stock/movements', { token: production });
    assert.deepEqual([movements.status, movements.body.error], [503, 'STOCK_HISTORY_REQUIRES_CLOUD']);
  });

  it('keeps the 12-month payments list on this month when an older month is opened', async () => {
    const owner = t.tokens.owner;
    const now = await t.request('GET', '/api/reports/payments', { token: owner });
    assert.equal(now.status, 200, JSON.stringify(now.body));
    const current = now.body.current_month;
    assert.equal(now.body.months.at(-1).month, current);
    const old = await t.request('GET', '/api/reports/payments?month=2025-01', { token: owner });
    assert.deepEqual([old.status, old.body.detail.month, old.body.months.at(-1).month], [200, '2025-01', current], 'the list did not move');
    const earlier = await t.request('GET', '/api/reports/payments?until=2025-06', { token: owner });
    assert.deepEqual([earlier.body.months[0].month, earlier.body.months.at(-1).month], ['2024-07', '2025-06']);
    const thisMonth = now.body.detail;
    assert.equal(typeof thisMonth.received, 'number');
    assert.equal((await t.request('GET', '/api/reports/payments?until=June', { token: owner })).status, 400);
  });

  it('previews the quote while an order is being created (Owner only, offline, nothing saved)', async () => {
    const owner = t.tokens.owner;
    const mug = (await t.request('POST', '/api/inventory', {
      token: owner, body: { item_name: 'Preview Mug', item_category: 'Mugs', unit: 'pcs', quantity_available: 200, minimum_threshold: 1, unit_cost: 40, selling_price: 100 }
    })).body.item.inventory_id;
    const before = await t.request('GET', '/api/orders', { token: owner });
    const ok = await t.request('POST', '/api/orders/quote-preview', {
      token: owner,
      body: { required_items: [{ inventory_id: mug, quantity_needed: 30 }, { inventory_id: mug, quantity_needed: 30 }], labor_amount: 200, incidental_percent: 10 }
    });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.source, 'local');
    // 60 pieces merged into one line -> 10% bulk tier (migration 017): 90 x 60 = 5400, + 200 labor, + 10% = 560.00
    assert.deepEqual([ok.body.quote.lines.length, ok.body.quote.lines[0].inventory_id, ok.body.quote.tier.percent_off], [1, mug, 10]);
    assert.deepEqual([ok.body.quote.subtotal_amount, ok.body.quote.incidental_amount, ok.body.quote.total_quote_amount], [5400, 560, 6160]);
    const after = await t.request('GET', '/api/orders', { token: owner });
    assert.equal(after.body.orders.length, before.body.orders.length, 'nothing saved');

    const unpriced = await t.request('POST', '/api/orders/quote-preview', { token: owner, body: { required_items: [{ inventory_id: shirt, quantity_needed: 1 }] } });
    assert.deepEqual([unpriced.status, unpriced.body.error], [422, 'SELLING_PRICE_MISSING']);
    const bad = await t.request('POST', '/api/orders/quote-preview', { token: owner, body: { required_items: [{ inventory_id: mug, quantity_needed: 1 }], incidental_amount: 5, incidental_percent: 5 } });
    assert.equal(bad.status, 400);
    const staffTry = await t.request('POST', '/api/orders/quote-preview', { token: staff, body: { required_items: [{ inventory_id: mug, quantity_needed: 1 }] } });
    assert.equal(staffTry.status, 403, 'only accounts that set quotes');
  });
});
