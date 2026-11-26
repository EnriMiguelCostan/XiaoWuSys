// Batch 1: Owner-only money decisions (PB 2), the buttons each account may use, order
// numbers in searches (PB 6) and the stock check shown before Approve / Resume (PB 9).
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, shopDate, fixtures } = require('./helpers/testServer');
const { capabilitiesFor, can, rolesWith } = require('../services/domain/permissions');
const { allowedActions } = require('../services/domain/orderLifecycle');
const { buildStockCheck, stockNeeds } = require('../services/domain/stockCheck');

describe('Who may do what (rules only)', () => {
  it('keeps prices, discounts and voids for the Owner alone; the Owner or an Admin approves', () => {
    for (const cap of ['set_quote', 'apply_discount', 'void_order']) {
      assert.deepEqual(rolesWith(cap), ['Owner'], cap);
    }
    // Adviser consultation (second round): Staff and Production create orders, the Owner or an Admin approves them
    assert.deepEqual(rolesWith('approve_order'), ['Owner', 'Admin']);
    assert.ok(can('Staff', 'create_order') && !can('Staff', 'approve_order'));
    assert.ok(can('Production', 'create_order') && !can('Production', 'approve_order'));
    assert.ok(can('Admin', 'view_finance'));
    assert.ok(!can('Admin', 'set_quote'));
    assert.deepEqual(capabilitiesFor('Production'), capabilitiesFor('Staff'), 'Production works like Staff (November 2026)');
    assert.throws(() => can('Owner', 'fly_to_the_moon'), /Unknown capability/);
  });

  it('offers each role only the buttons it may use, per order status', () => {
    const pending = { production_status: 'Pending', total_quote_amount: 1500 };
    assert.deepEqual(allowedActions(pending, 'Owner'), {
      approve: true, statuses: ['Cancelled'], edit_deadline: true, edit_quote: true, generate_quote: true, apply_discount: true,
      link_design: true, add_items: true, record_payment: true, max_payment: 1500, payment_blocked_reason: null, print_receipt: true,
      print_quote: true, void_payment: true, log_loss: false, archive_order: false, restore_order: false,
      // migration 015
      edit_description: true, add_print_details: true, record_delivery: false, max_delivery: 0, complete_blocked_reason: null,
      complete_with_balance: false, refund_payment: false, max_refund: 0, verify_payment: true, edit_payment: true, adjust_price: false,
      // migration 016
      approve_without_quote: false, plan_deliveries: true, manage_design_files: true,
      // migration 017
      cancel: true, update_progress: false, max_adjustment: 0, status_needs_confirm: {}
    });
    assert.deepEqual(allowedActions(pending, 'Admin'), {
      approve: true, statuses: ['Cancelled'], edit_deadline: true, edit_quote: false, generate_quote: false, apply_discount: false,
      link_design: true, add_items: true, record_payment: true, max_payment: 1500, payment_blocked_reason: null, print_receipt: true,
      print_quote: true, void_payment: false, log_loss: false, archive_order: false, restore_order: false,
      // migration 015
      edit_description: true, add_print_details: true, record_delivery: false, max_delivery: 0, complete_blocked_reason: null,
      complete_with_balance: false, refund_payment: false, max_refund: 0, verify_payment: true, edit_payment: true, adjust_price: false,
      // migration 016
      approve_without_quote: false, plan_deliveries: true, manage_design_files: true,
      // migration 017: an Admin may cancel; a price cut only up to the late-delivery suggestion (none here)
      cancel: true, update_progress: false, max_adjustment: 0, status_needs_confirm: {}
    });
    assert.equal(allowedActions({ production_status: 'Pending', total_quote_amount: 0 }, 'Owner').print_quote, false, 'no quotation to print yet');
    assert.equal(allowedActions({ production_status: 'Pending', total_quote_amount: 0 }, 'Admin').approve_without_quote, true, 'the quote is optional');
    assert.equal(allowedActions({ production_status: 'Pending', total_quote_amount: 0 }, 'Staff').approve_without_quote, false);
    assert.deepEqual(allowedActions({ production_status: 'Printing' }, 'Staff').statuses, ['Ready'], 'no Cancel after approval, no Completed before Ready, Pressing counted per item');
    assert.deepEqual(allowedActions({ production_status: 'Delayed' }, 'Staff').statuses, ['Pending', 'Cancelled'], 'not approved yet: anyone may cancel');
    const approved = allowedActions({ production_status: 'Approved', total_quote_amount: 900 }, 'Owner');
    assert.deepEqual([approved.edit_quote, approved.generate_quote, approved.apply_discount], [false, false, false], 'the quote is frozen after approval');
    const unpriced = allowedActions({ production_status: 'Printing', total_quote_amount: 0 }, 'Owner');
    assert.deepEqual([unpriced.edit_quote, unpriced.generate_quote], [false, false], 'migration 017: the price is final once printing starts');
    const approvedUnpriced = allowedActions({ production_status: 'Approved', total_quote_amount: 0 }, 'Owner');
    assert.deepEqual([approvedUnpriced.edit_quote, approvedUnpriced.generate_quote], [true, true], 'approved without a quote: the price can still be set before printing');
    const closed = allowedActions({ production_status: 'Cancelled' }, 'Owner');
    assert.deepEqual([closed.statuses, closed.edit_deadline, closed.record_payment, closed.log_loss, closed.void_payment],
      [[], false, false, false, true], 'a cancelled order can still have its payments voided (refunds)');
    for (const order of [pending, { production_status: 'Printing', total_quote_amount: 900 }, { production_status: 'Completed' }]) {
      assert.deepEqual(allowedActions(order, 'Production'), allowedActions(order, 'Staff'), 'Production gets the same buttons as Staff');
    }
  });

  it('adds up lines of the same material and reports what is short', () => {
    const items = [
      { inventory_id: 'a', quantity: 3, product_type: 'Shirt' },
      { inventory_id: 'a', quantity: 2, product_type: 'Shirt' },
      { inventory_id: null, quantity: 9, product_type: 'Print detail' },
      { inventory_id: 'gone', quantity: 4, product_type: 'Old mug' }
    ];
    assert.deepEqual(stockNeeds(items), [{ inventory_id: 'a', quantity_needed: 5 }, { inventory_id: 'gone', quantity_needed: 4 }]);
    const check = buildStockCheck({ production_status: 'Delayed', stock_reserved: false }, items, {
      source: 'cloud', missing: ['gone'], shortages: [{ inventory_id: 'a', item_name: 'Shirt', requested: 5, available: 2, shortfall: 3 }]
    });
    assert.equal(check.sufficient, false);
    assert.deepEqual(check.shortfalls.map((s) => [s.item_name, s.needed, s.free, s.shortfall, s.missing]),
      [['Shirt', 5, 2, 3, false], ['Old mug', 4, 0, 4, true]]);
    const held = buildStockCheck({ production_status: 'Pending', stock_reserved: true }, items, null);
    assert.deepEqual([held.needs_reservation, held.sufficient], [false, true], 'an order that holds its stock is covered');
  });
});

describe('Owner-only rules and order screens (API)', () => {
  let t;
  const items = {};
  const customers = {};
  let pendingId;
  let delayedId;

  before(async () => {
    t = await startTestServer();
    await Promise.all(['owner', 'admin', 'staff', 'production'].map((u) => t.login(u)));
    for (const it of fixtures.ITEMS) {
      const r = await t.request('POST', '/api/inventory', { token: t.tokens.staff, body: it });
      items[it.item_name] = r.body.item.inventory_id;
    }
    for (const c of fixtures.CUSTOMERS) {
      const r = await t.request('POST', '/api/customers', { token: t.tokens.staff, body: c });
      customers[c.full_name] = r.body.customer.customer_id;
    }
    const pending = await t.request('POST', '/api/orders', {
      token: t.tokens.staff,
      body: { customer_id: customers['Maria Santos'], production_deadline: shopDate(6), required_items: [{ inventory_id: items['Custom Shirt'], quantity_needed: 20 }] }
    });
    pendingId = pending.body.order_id;
    const delayed = await t.request('POST', '/api/orders', {
      token: t.tokens.staff,
      body: {
        customer_id: customers['Juan Dela Cruz'], production_deadline: shopDate(30), resolution: 'Delayed',
        required_items: [{ inventory_id: items['Custom Shirt'], quantity_needed: 400 }, { inventory_id: items['Valiant Columnar Notebook'], quantity_needed: 2 }]
      }
    });
    delayedId = delayed.body.order_id;
  });
  after(async () => { await t.close(); });

  it('tells each account at login what it may do', async () => {
    const owner = await t.request('POST', '/api/auth/login', { body: { username: 'owner', password: fixtures.PASSWORD } });
    for (const cap of ['set_quote', 'void_order', 'approve_order', 'apply_discount']) assert.ok(owner.body.capabilities.includes(cap), cap);
    const admin = await t.request('POST', '/api/auth/login', { body: { username: 'admin', password: fixtures.PASSWORD } });
    for (const cap of ['set_quote', 'void_order', 'apply_discount']) assert.ok(!admin.body.capabilities.includes(cap), cap);
    assert.ok(admin.body.capabilities.includes('approve_order'), 'the Admin approves job orders too');
    assert.ok(admin.body.capabilities.includes('view_finance'));
  });

  it('answers "who am I" from the login token', async () => {
    const r = await t.request('GET', '/api/auth/me', { token: t.tokens.staff });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.user, { user_id: 'u-staff', role: 'Staff' });
    assert.ok(r.body.capabilities.includes('create_order'));
    assert.ok(!r.body.capabilities.includes('set_quote'));
    assert.equal((await t.request('GET', '/api/auth/me')).status, 401);
  });

  it('shows the Owner the price and cancel buttons, and the Admin the approve and cancel buttons', async () => {
    const owner = await t.request('GET', `/api/orders/${pendingId}`, { token: t.tokens.owner });
    assert.equal(owner.status, 200, owner.text);
    assert.deepEqual([owner.body.allowed_actions.approve, owner.body.allowed_actions.edit_quote, owner.body.allowed_actions.statuses],
      [true, true, ['Cancelled']]);
    const admin = await t.request('GET', `/api/orders/${pendingId}`, { token: t.tokens.admin });
    assert.deepEqual([admin.body.allowed_actions.approve, admin.body.allowed_actions.edit_quote, admin.body.allowed_actions.statuses],
      [true, false, ['Cancelled']]);
    assert.equal(admin.body.allowed_actions.edit_deadline, true);
    const list = await t.request('GET', '/api/orders', { token: t.tokens.admin });
    assert.ok(Array.isArray(list.body.capabilities) && !list.body.capabilities.includes('set_quote'));
  });

  it('lets the Admin cancel (the change itself needs the cloud), and keeps "shop\u2019s fault" for managers', async () => {
    const r = await t.request('PATCH', `/api/orders/${delayedId}/status`, { token: t.tokens.admin, body: { status: 'Cancelled' } });
    assert.equal(r.status, 503, 'allowed: only the cloud is missing here');
    const fault = await t.request('PATCH', `/api/orders/${delayedId}/status`, { token: t.tokens.staff, body: { status: 'Cancelled', shop_fault: true } });
    assert.deepEqual([fault.status, fault.body.error], [403, 'CANCEL_NEEDS_MANAGER']);
    const resume = await t.request('PATCH', `/api/orders/${delayedId}/status`, { token: t.tokens.admin, body: { status: 'Pending' } });
    assert.equal(resume.status, 503, 'Resume is still allowed for the Admin (it only needs the cloud)');
  });

  it('still lets staff record a customer\u2019s "cancel" choice when an order is halted for stock', async () => {
    const r = await t.request('POST', '/api/orders', {
      token: t.tokens.staff,
      body: { customer_id: customers['Maria Santos'], production_deadline: shopDate(3), resolution: 'Cancelled', required_items: [{ inventory_id: items['Deli A4 Paper'], quantity_needed: 50 }] }
    });
    assert.equal(r.status, 201, r.text);
    assert.equal(r.body.production_status, 'Cancelled');
    assert.equal(r.body.order.stock_reserved, false, 'nothing was reserved, so nothing had to be released');
  });

  it('greys out Approve / Resume when the free stock does not cover the order', async () => {
    const r = await t.request('GET', `/api/orders/${delayedId}`, { token: t.tokens.owner });
    const check = r.body.stock_check;
    assert.deepEqual([check.needs_reservation, check.sufficient], [true, false]);
    const shirt = check.shortfalls.find((s) => s.inventory_id === items['Custom Shirt']);
    assert.deepEqual([shirt.item_name, shirt.needed, shirt.free, shirt.shortfall], ['Custom Shirt', 400, 361, 39]);
    assert.ok(!check.shortfalls.some((s) => s.inventory_id === items['Valiant Columnar Notebook']), 'enough notebooks');

    const held = await t.request('GET', `/api/orders/${pendingId}`, { token: t.tokens.production });
    assert.deepEqual([held.body.stock_check.needs_reservation, held.body.stock_check.sufficient], [false, true]);
  });

  it('counts a material that was deleted as missing', async () => {
    const order = await t.request('POST', '/api/orders', {
      token: t.tokens.staff,
      body: { customer_id: customers['Juan Dela Cruz'], production_deadline: shopDate(9), resolution: 'Delayed', required_items: [{ inventory_id: items['B&E Oslo Drawing Paper'], quantity_needed: 2 }] }
    });
    assert.equal((await t.request('DELETE', `/api/inventory/${items['B&E Oslo Drawing Paper']}`, { token: t.tokens.staff })).status, 200);
    const r = await t.request('GET', `/api/orders/${order.body.order_id}`, { token: t.tokens.owner });
    assert.equal(r.body.stock_check.sufficient, false);
    assert.deepEqual(r.body.stock_check.shortfalls.map((s) => [s.missing, s.needed]), [[true, 2]]);
  });

  it('finds an order by its number, ignoring upper/lower case', async () => {
    await t.run("UPDATE order_profiles SET tracking_no = 'XM-2026-0007' WHERE order_id = ?", [pendingId]);
    const r = await t.request('GET', '/api/orders?tracking_no=xm-2026-0007', { token: t.tokens.production });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.body.orders.map((o) => [o.order_id, o.tracking_no]), [[pendingId, 'XM-2026-0007']]);
    const bad = await t.request('GET', '/api/orders?tracking_no=2026-7', { token: t.tokens.production });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.message, 'Order number must look like XM-2026-0123.');
    assert.equal(bad.body.details[0].field, 'tracking_no');
  });
});
