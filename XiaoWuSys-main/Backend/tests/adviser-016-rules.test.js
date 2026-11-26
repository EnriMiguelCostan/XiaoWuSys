// Migration 016 (adviser consultation, second round): the pure rules, no database needed.
//   Ready status, the optional quote, T-shirt-only pressing, delivery batches planned ahead,
//   delivery status for the Orders list, consumables on the new steps, design-file checks.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  STATUS_TRANSITIONS, allowedActions, quoteLocked, fulfillmentSummary, completionCheck, planSummary, deliveryStatus, IN_PRODUCTION_STATUSES
} = require('../services/domain/orderLifecycle');
const { rolesWith, can } = require('../services/domain/permissions');
const { triggersFor } = require('../services/domain/consumables');
const { checkUpload, cleanFileName, isPreviewable, contentDisposition, MAX_FILE_BYTES } = require('../services/designFiles');

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3]);

describe('Approvals (point 16) and the optional quote (point 10)', () => {
  it('lets Staff and Production create orders but only the Owner or an Admin approve them', () => {
    assert.deepEqual(rolesWith('approve_order'), ['Owner', 'Admin']);
    for (const role of ['Staff', 'Production']) {
      assert.ok(can(role, 'create_order'), role);
      assert.equal(allowedActions({ production_status: 'Pending', total_quote_amount: 1000 }, role).approve, false, role);
    }
    for (const role of ['Owner', 'Admin']) {
      assert.equal(allowedActions({ production_status: 'Pending', total_quote_amount: 1000 }, role).approve, true, role);
    }
  });

  it('allows approving without a quote, and keeps the price open until one is set', () => {
    assert.equal(allowedActions({ production_status: 'Pending', total_quote_amount: 0 }, 'Admin').approve_without_quote, true);
    assert.equal(allowedActions({ production_status: 'Pending', total_quote_amount: 500 }, 'Admin').approve_without_quote, false);
    assert.equal(quoteLocked('Approved', 0), false, 'approved without a quote: the Owner may still price it');
    assert.equal(quoteLocked('Printing', 0), true, 'migration 017: the price is final once printing starts');
    assert.equal(quoteLocked('Printing', 800), true, 'approved with a quote: frozen (the downpayment was based on it)');
    assert.equal(quoteLocked('Pending', 800), false);
    assert.equal(quoteLocked('Completed', 0), true, 'a closed order is never re-priced');
    assert.equal(quoteLocked('Cancelled', 0), true);
    assert.equal(allowedActions({ production_status: 'Approved', total_quote_amount: 0 }, 'Owner').edit_quote, true);
    assert.equal(allowedActions({ production_status: 'Approved', total_quote_amount: 0 }, 'Admin').edit_quote, false, 'pricing stays with the Owner');
    assert.equal(allowedActions({ production_status: 'Ready', total_quote_amount: 0 }, 'Owner').edit_quote, false);
  });
});

describe('Order statuses (point 13) and pressing for T-shirts only (point 15)', () => {
  it('adds Ready between production and the hand-over', () => {
    assert.ok(STATUS_TRANSITIONS.Printing.includes('Ready') && STATUS_TRANSITIONS.Pressing.includes('Ready'));
    assert.deepEqual(STATUS_TRANSITIONS.Ready, ['Completed', 'Cancelled']);
    assert.ok(IN_PRODUCTION_STATUSES.includes('Ready'));
    const ready = completionCheck({ order: { production_status: 'Ready' }, summary: { quote: 100, remaining: 0 }, fulfillment: fulfillmentSummary({ pieces_ordered: 4 }) });
    assert.equal(ready.ready, true, 'a Ready order can be completed');
  });

  it('never offers Pressing as a status: it is counted per item (migration 019)', () => {
    const shirts = allowedActions({ production_status: 'Printing' }, 'Staff', null, { needs_pressing: true, has_garments: true });
    const jerseys = allowedActions({ production_status: 'Printing' }, 'Staff', null, { needs_pressing: false, has_garments: true });
    assert.deepEqual([shirts.statuses, jerseys.statuses], [['Ready'], ['Ready']]);
  });

  it('takes the consumables once, whichever way the order reaches Completed', () => {
    assert.deepEqual(triggersFor('Printing', 'Ready'), ['Pressing'], 'skipping the press: its rates are taken now');
    assert.deepEqual(triggersFor('Pressing', 'Ready'), []);
    assert.deepEqual(triggersFor('Ready', 'Completed'), ['Pressing', 'Completed'], 'what is not taken yet (the log skips the rest)');
  });
});

describe('Delivery batches planned ahead (points 4 and 6) and the delivery status (points 5 and 13)', () => {
  const plans = [
    { plan_id: 'p1', batch_no: 1, planned_quantity: 30, planned_date: '2026-11-20', ready_at: '2026-11-19T08:00:00' },
    { plan_id: 'p2', batch_no: 2, planned_quantity: 20, planned_date: '2026-11-30', ready_at: null }
  ];

  it('says for each batch whether it can be delivered', () => {
    const none = planSummary(plans[1], [], '2026-11-24');
    assert.deepEqual([none.state, none.can_deliver, none.overdue], ['In production', false, false]);
    const ready = planSummary(plans[0], [], '2026-11-24');
    assert.deepEqual([ready.state, ready.can_deliver, ready.overdue], ['Ready', true, true], 'planned for the 20th, not delivered: overdue');
    const part = planSummary(plans[0], [{ plan_id: 'p1', quantity: 10 }], '2026-11-24');
    assert.deepEqual([part.state, part.delivered, part.remaining, part.can_deliver], ['Partly delivered', 10, 20, true]);
    const done = planSummary(plans[0], [{ plan_id: 'p1', quantity: 30 }], '2026-11-24');
    assert.deepEqual([done.state, done.overdue, done.can_deliver], ['Delivered', false, false]);
  });

  it('completes only once every planned batch is delivered', () => {
    const f = fulfillmentSummary({ pieces_ordered: 50, deliveries: [{ plan_id: 'p1', quantity: 30 }], plans });
    assert.deepEqual([f.pieces_planned, f.pieces_unplanned, f.plans_open], [50, 0, 1]);
    const check = completionCheck({ order: { production_status: 'Ready' }, summary: { quote: 1000, remaining: 0 }, fulfillment: f });
    assert.equal(check.ready, false);
    assert.ok(check.missing.some((m) => m.code === 'BATCHES_NOT_DELIVERED' && /#2/.test(m.message)));
    assert.equal(check.auto_handover, false, 'planned batches are never handed over automatically');
    const all = fulfillmentSummary({ pieces_ordered: 50, deliveries: [{ plan_id: 'p1', quantity: 30 }, { plan_id: 'p2', quantity: 20 }], plans });
    assert.equal(completionCheck({ order: { production_status: 'Ready' }, summary: { quote: 1000, remaining: 0 }, fulfillment: all }).ready, true);
  });

  it('gives the Orders list a delivery status', () => {
    assert.equal(deliveryStatus(fulfillmentSummary({ pieces_ordered: 0 })), null);
    assert.equal(deliveryStatus(fulfillmentSummary({ pieces_ordered: 5 })), 'Not delivered');
    assert.equal(deliveryStatus(fulfillmentSummary({ pieces_ordered: 5, deliveries: [{ quantity: 2 }] })), 'Partly delivered');
    assert.equal(deliveryStatus(fulfillmentSummary({ pieces_ordered: 5, deliveries: [{ quantity: 5 }] })), 'Delivered');
  });

  it('lets batches be planned and marked ready by the day-to-day roles', () => {
    assert.equal(allowedActions({ production_status: 'Pending', total_quote_amount: 0 }, 'Staff').plan_deliveries, true);
    assert.equal(allowedActions({ production_status: 'Ready', total_quote_amount: 0 }, 'Production').plan_deliveries, true);
    assert.equal(allowedActions({ production_status: 'Completed' }, 'Owner').plan_deliveries, false);
  });
});

describe('Design files from the computer (point 2)', () => {
  it('accepts design formats and refuses the rest', () => {
    const ok = checkUpload({ name: 'C:\\Users\\shop\\front design.png', buffer: PNG });
    assert.equal(ok.error, undefined);
    assert.deepEqual([ok.file_name, ok.mime_type, ok.previewable], ['front design.png', 'image/png', true]);
    assert.match(checkUpload({ name: 'virus.exe', buffer: PNG }).error, /cannot be attached/);
    assert.match(checkUpload({ name: 'empty.pdf', buffer: Buffer.alloc(0) }).error, /empty/);
    assert.match(checkUpload({ name: 'huge.pdf', buffer: Buffer.alloc(MAX_FILE_BYTES + 1) }).error, /too large/);
    assert.match(checkUpload({ name: '', buffer: PNG }).error, /needs a name/);
  });

  it('only shows real images in the page; everything else downloads', () => {
    assert.equal(isPreviewable('image/png', PNG), true);
    assert.equal(isPreviewable('image/png', Buffer.from('<svg onload=alert(1)>....')), false, 'a fake PNG is never shown inline');
    assert.equal(checkUpload({ name: 'logo.svg', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>') }).previewable, false);
    assert.equal(cleanFileName('../../etc/passwd'), 'passwd');
    assert.equal(cleanFileName('a"b<c>.pdf'), 'abc.pdf');
    assert.match(contentDisposition('attachment', 'Disenyo ñ.pdf'), /^attachment; filename="Disenyo _.pdf"; filename\*=UTF-8''Disenyo%20%C3%B1.pdf$/);
  });
});
