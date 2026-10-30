// PB 21 (payments) and PB 3 / PB 4 (sync queue) on this computer's database, cloud switched off.
// Every payment here takes the real offline path: the same checks as online, against the
// local copy, including payments that are still waiting to sync.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, shopDate, fixtures } = require('./helpers/testServer');

describe('Payments: balance limit, receiver and payment status', () => {
  let t;
  let shirt;
  let customer;
  const orders = {};

  const pay = (orderId, amount, who = 'production', extra = {}) =>
    t.request('POST', `/api/orders/${orderId}/payments`, { token: t.tokens[who], body: { amount, payment_type: 'Cash', ...extra } });
  const paymentCount = async (orderId) => (await t.get('SELECT COUNT(*) AS n FROM payments WHERE order_id = ?', [orderId])).n;
  const newOrder = async (quote, body = {}) => {
    const r = await t.request('POST', '/api/orders', {
      token: t.tokens.owner,
      body: { customer_id: customer, production_deadline: shopDate(7), total_quote_amount: quote,
        required_items: [{ inventory_id: shirt, quantity_needed: 1 }], ...body }
    });
    assert.equal(r.status, 201, r.text);
    return r.body.order_id;
  };

  before(async () => {
    t = await startTestServer();
    for (const who of ['owner', 'admin', 'production', 'staff']) await t.login(who);
    shirt = (await t.request('POST', '/api/inventory', { token: t.tokens.owner, body: fixtures.ITEMS[0] })).body.item.inventory_id;
    customer = (await t.request('POST', '/api/customers', { token: t.tokens.owner, body: fixtures.CUSTOMERS[0] })).body.customer.customer_id;
    orders.main = await newOrder(1000);
    orders.odd = await newOrder(999.99);
    orders.noQuote = await newOrder(0);
    orders.cancelled = await newOrder(500, { resolution: 'Cancelled' }); // lost sale logged at creation
  });
  after(async () => { await t.close(); });

  it('refuses a payment above the remaining balance, and saves nothing', async () => {
    const r = await pay(orders.main, 1000.01);
    assert.equal(r.status, 409, r.text);
    assert.equal(r.body.error, 'PAYMENT_EXCEEDS_BALANCE');
    assert.equal(r.body.message, 'The most this order can take now is ₱1,000.00 (the remaining balance).');
    assert.deepEqual([r.body.remaining, r.body.total_paid, r.body.total_quote_amount], [1000, 0, 1000]);
    assert.equal(await paymentCount(orders.main), 0);
  });

  it('shows Partial after part of the price, and Fully Paid when the balance is paid exactly', async () => {
    let r = await pay(orders.main, 300);
    assert.equal(r.status, 201, r.text);
    assert.deepEqual([r.body.totals.payment_status, r.body.totals.remaining, r.body.totals.total_paid], ['Partial', 700, 300]);
    assert.equal(r.body.allowed_actions.max_payment, 700, 'the form can be limited to what is left');

    const over = await pay(orders.main, 700.01);
    assert.equal(over.status, 409);
    assert.equal(over.body.remaining, 700);

    r = await pay(orders.main, 700);
    assert.equal(r.status, 201, r.text);
    assert.deepEqual([r.body.totals.payment_status, r.body.totals.remaining, r.body.totals.overpaid_by], ['Fully Paid', 0, 0]);
    assert.equal(r.body.allowed_actions.record_payment, false);
    assert.equal(r.body.allowed_actions.payment_blocked_reason, 'This order is fully paid.');

    const more = await pay(orders.main, 0.01);
    assert.equal(more.status, 409);
    assert.equal(more.body.message, 'This order is already fully paid, so no more payments can be added.');
  });

  it('counts centavos exactly (a ₱999.99 quote)', async () => {
    let r = await pay(orders.odd, 499.99);
    assert.equal(r.status, 201, r.text);
    assert.deepEqual([r.body.totals.payment_status, r.body.totals.remaining], ['Partial', 500]);
    assert.equal(r.body.totals.downpayment.required, 500, '50% of ₱999.99 rounds up to ₱500.00');
    assert.equal((await pay(orders.odd, 500.01)).status, 409);
    r = await pay(orders.odd, 500);
    assert.deepEqual([r.status, r.body.totals.payment_status, r.body.totals.total_paid], [201, 'Fully Paid', 999.99]);
  });

  it('refuses payments on a cancelled order, or before the Owner sets the price, and from Staff', async () => {
    const closed = await pay(orders.cancelled, 100);
    assert.deepEqual([closed.status, closed.body.error], [409, 'ORDER_CLOSED']);
    const noQuote = await pay(orders.noQuote, 100);
    assert.deepEqual([noQuote.status, noQuote.body.error], [422, 'QUOTE_REQUIRED']);
    assert.match(noQuote.body.message, /Ask the Owner to set the quote/);
    const staff = await pay(orders.odd, 1, 'staff');
    assert.equal(staff.status, 403);
    for (const id of [orders.cancelled, orders.noQuote]) assert.equal(await paymentCount(id), 0);
  });

  it('records who received the payment from the login, never from the request', async () => {
    const forOrder = await newOrder(2000);
    for (const extra of [{ received_by: 'u-owner' }, { receipt_no: 'AR-2026-9999' }]) {
      const r = await pay(forOrder, 100, 'production', extra);
      assert.equal(r.status, 400, JSON.stringify(extra));
      assert.equal(r.body.error, 'VALIDATION_FAILED');
      assert.match(r.body.message, /filled in by the system/);
    }
    assert.equal(await paymentCount(forOrder), 0);

    const r = await pay(forOrder, 100, 'admin');
    assert.equal(r.status, 201, r.text);
    assert.equal(r.body.payment.received_by, 'u-admin');
    assert.equal(r.body.payment.received_by_name, 'admin');
    const row = await t.get('SELECT received_by FROM payments WHERE payment_id = ?', [r.body.payment.payment_id]);
    assert.equal(row.received_by, 'u-admin');
  });

  it('saves an offline payment to sync later, without a receipt number yet', async () => {
    const r = await pay(await newOrder(1500), 200);
    assert.equal(r.status, 201, r.text);
    assert.equal(r.body.source, 'local');
    assert.match(r.body.message, /saved on this computer/);
    assert.deepEqual([r.body.payment.sync_status, r.body.payment.receipt_no, r.body.payment.received_by, r.body.payment.received_by_name],
      ['pending_insert', null, 'u-production', 'production']);
    assert.ok(t.localWrites.length > 0, 'the screens are told that a change is waiting to sync');
  });

  it('warns, without blocking, when the downpayment is still short of 50%', async () => {
    const id = await newOrder(1000);
    const r = await pay(id, 100);
    assert.equal(r.status, 201);
    assert.deepEqual(r.body.warnings, [{
      code: 'DOWNPAYMENT_SHORT',
      message: 'Not enough downpayment to start production: ₱400.00 more is needed (50% of the quote).'
    }]);
    const enough = await pay(id, 400);
    assert.deepEqual(enough.body.warnings.map((w) => w.code), ['DOWNPAYMENT_NOT_SYNCED'],
      'paid in full offline: it counts for approval once it syncs');
  });

  it('lists each payment with its receiver and the totals right after it (for the receipt)', async () => {
    const r = await t.request('GET', `/api/orders/${orders.main}/payments`, { token: t.tokens.owner });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.body.payments.map((p) => [p.amount, p.paid_to_date, p.remaining_after, p.status_after, p.received_by_name]), [
      [300, 300, 700, 'Partial', 'production'],
      [700, 1000, 0, 'Fully Paid', 'production']
    ]);
    assert.equal(r.body.totals.payment_status, 'Fully Paid');
    await t.run("INSERT INTO payments (payment_id, order_id, amount, payment_type, sync_status) VALUES ('old-pay', ?, 0, 'Cash', 'synced')", [orders.noQuote]);
    const legacy = await t.request('GET', `/api/orders/${orders.noQuote}`, { token: t.tokens.staff });
    assert.equal(legacy.body.payments[0].received_by_name, 'Not recorded', 'payments from before this update');
  });

  it('tells each role which payment buttons to show', async () => {
    const fresh = await newOrder(800);
    const detail = async (id, who) => (await t.request('GET', `/api/orders/${id}`, { token: t.tokens[who] })).body.allowed_actions;
    const prod = await detail(fresh, 'production');
    assert.deepEqual([prod.record_payment, prod.max_payment, prod.print_receipt, prod.payment_blocked_reason], [true, 800, true, null]);
    const staff = await detail(fresh, 'staff');
    assert.deepEqual([staff.record_payment, staff.max_payment, staff.print_receipt], [false, 0, true]);
    const cancelled = await detail(orders.cancelled, 'owner');
    assert.deepEqual([cancelled.record_payment, cancelled.payment_blocked_reason], [false, 'This order was cancelled, so it cannot take payments.']);
    const noQuote = await detail(orders.noQuote, 'admin');
    assert.deepEqual([noQuote.record_payment, noQuote.payment_blocked_reason], [false, 'The Owner must set the quote before payments can be recorded.']);
  });

  it('shows overpaid orders to the Owner and Admin for a refund, and adds receipt columns to the exports', async () => {
    // Two branches paid the same order while offline (sync accepts both, D2)
    await t.run("INSERT INTO payments (payment_id, order_id, amount, payment_type, received_by, sync_status) VALUES ('branch-b', ?, 250, 'GCash', 'u-owner', 'synced')", [orders.main]);
    const owner = await t.request('GET', '/api/reports/dashboard', { token: t.tokens.owner });
    const over = owner.body.orders.overpaid.find((o) => o.order_id === orders.main);
    assert.deepEqual([over.payment_status, over.overpaid_by], ['Overpaid', 250]);
    assert.equal(owner.body.orders.overpaid_total, 250);
    assert.ok(owner.body.orders.due_this_week.every((o) => typeof o.payment_status === 'string'));
    const staff = await t.request('GET', '/api/reports/dashboard', { token: t.tokens.staff });
    assert.deepEqual(staff.body.orders.overpaid, [], 'money figures stay with Owner and Admin');
    const detail = await t.request('GET', `/api/orders/${orders.main}`, { token: t.tokens.owner });
    assert.deepEqual([detail.body.totals.payment_status, detail.body.totals.overpaid_by, detail.body.totals.remaining], ['Overpaid', 250, 0]);

    const payments = await t.request('GET', '/api/reports/export/payments.csv', { token: t.tokens.owner });
    const lines = payments.text.slice(1).trim().split('\r\n');
    assert.equal(lines[0], 'Date,Receipt no.,Order,Customer,Payment type,Amount (PHP),Received by');
    assert.ok(lines.some((l) => /,Given after sync,New order,Juan Dela Cruz,Cash,300,production$/.test(l)), lines.join('\n'));
    assert.ok(lines.some((l) => /,Cash,0,Not recorded$/.test(l)), 'a payment from before this update');
    const ordersCsv = await t.request('GET', '/api/reports/export/orders.csv', { token: t.tokens.owner });
    assert.match(ordersCsv.text, /Balance \(PHP\),Payment status,Materials/);
    assert.match(ordersCsv.text, /,Overpaid,/);
  });
});

describe('Sync status (changes waiting to sync)', () => {
  let t;
  before(async () => {
    t = await startTestServer();
    await t.login('staff');
    await t.login('owner');
  });
  after(async () => { await t.close(); });

  it('reports the offline-only mode and counts the changes waiting, per table', async () => {
    assert.equal((await t.request('GET', '/api/sync/status')).status, 401, 'needs a login');
    const empty = await t.request('GET', '/api/sync/status', { token: t.tokens.staff });
    assert.equal(empty.status, 200, empty.text);
    assert.deepEqual([empty.body.cloud, empty.body.pending, empty.body.pending_total, empty.body.conflicts], ['disabled', {}, 0, 0]);

    const item = await t.request('POST', '/api/inventory', { token: t.tokens.owner, body: fixtures.ITEMS[1] });
    const cust = await t.request('POST', '/api/customers', { token: t.tokens.owner, body: fixtures.CUSTOMERS[1] });
    const order = await t.request('POST', '/api/orders', {
      token: t.tokens.owner,
      body: { customer_id: cust.body.customer.customer_id, production_deadline: shopDate(3), total_quote_amount: 600,
        required_items: [{ inventory_id: item.body.item.inventory_id, quantity_needed: 2 }] }
    });
    await t.request('POST', `/api/orders/${order.body.order_id}/payments`, { token: t.tokens.owner, body: { amount: 300, payment_type: 'GCash' } });
    await t.run("UPDATE customers SET sync_conflict = 'changed online' WHERE customer_id = ?", [cust.body.customer.customer_id]);

    const s = await t.request('GET', '/api/sync/status', { token: t.tokens.staff });
    assert.deepEqual(s.body.pending, { inventory_items: 1, order_profiles: 1, order_items: 1, payments: 1, inventory_audit_log: 1 });
    assert.equal(s.body.pending_total, 5);
    assert.equal(s.body.conflicts, 1, 'a record held back by a conflict is counted there, not as waiting');
    assert.deepEqual([s.body.last_sync_at, s.body.last_sync_result, s.body.syncing], [null, null, false]);

    const status = await t.request('GET', '/api/status');
    assert.deepEqual([status.body.status, status.body.cloud], ['online', 'disabled']);
    assert.ok(!/postgres|neon|DATABASE_URL/i.test(status.text), 'no connection details');
  });
});
