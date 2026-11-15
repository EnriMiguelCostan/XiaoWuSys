// Batch M6 part 4, rules only (no HTTP, no SQL): archived orders are read-only (PB 23, D2), and
// the P&L uses the unit cost kept when the order was completed / the consumable was taken (PB 22).
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { allowedActions, ARCHIVED_REASON } = require('../services/domain/orderLifecycle');
const { computePnl } = require('../services/domain/pnl');

describe('Archived orders (PB 23, D2)', () => {
  it('offers Archive for closed orders to the Owner and Admin only', () => {
    for (const status of ['Completed', 'Cancelled']) {
      const order = { production_status: status, total_quote_amount: 1000 };
      assert.deepEqual(['Owner', 'Admin', 'Production', 'Staff'].map((r) => allowedActions(order, r).archive_order), [true, true, false, false], status);
      assert.equal(allowedActions(order, 'Owner').restore_order, false, 'not archived yet');
    }
    for (const status of ['Pending', 'Approved', 'Printing', 'Pressing', 'Delayed']) {
      assert.equal(allowedActions({ production_status: status }, 'Owner').archive_order, false, `${status} is still open`);
    }
  });

  it('makes an archived order read-only: only printing and Restore remain', () => {
    const archived = { production_status: 'Completed', total_quote_amount: 1000, archived_at: '2026-11-01T00:00:00' };
    const owner = allowedActions(archived, 'Owner', { quote: 1000, remaining: 400, total_paid: 600, payment_status: 'Partial' });
    assert.deepEqual(
      [owner.record_payment, owner.max_payment, owner.void_payment, owner.statuses, owner.edit_quote, owner.log_loss, owner.archive_order, owner.restore_order],
      [false, 0, false, [], false, false, false, true]);
    assert.equal(owner.payment_blocked_reason, ARCHIVED_REASON);
    assert.deepEqual([owner.print_receipt, owner.print_quote], [true, true]);
    assert.equal(allowedActions(archived, 'Production').restore_order, false);
    assert.equal(allowedActions(archived, 'Staff').payment_blocked_reason, null, 'Staff cannot pay anyway');
  });
});

describe('Cost at the time in the P&L (PB 22)', () => {
  const base = {
    from: '2026-11-01',
    to: '2026-11-30',
    completions: [{ order_id: 'o1', changed_at: '2026-11-10T01:00:00' }],
    unitCosts: new Map([['shirt', 200], ['ink', 5]]) // today's catalog costs, after a price rise
  };
  it('uses the cost kept on the row, and today’s cost only for older rows', () => {
    const p = computePnl({
      ...base,
      orderItems: [
        { order_id: 'o1', inventory_id: 'shirt', quantity: 3, unit_cost: 120 },   // cost when completed
        { order_id: 'o1', inventory_id: 'shirt', quantity: 1, unit_cost: null }   // before migration 013
      ],
      consumablesLog: [
        { consumable_inventory_id: 'ink', quantity_deducted: 10, unit_cost: 2.5, deducted_at: '2026-11-09T01:00:00' },
        { consumable_inventory_id: 'ink', quantity_deducted: 2, deducted_at: '2026-11-09T01:00:00' }
      ]
    });
    assert.equal(p.cogs_blanks, 3 * 120 + 200);
    assert.equal(p.cogs_consumables, 10 * 2.5 + 2 * 5);
  });

  it('keeps a cost of zero as zero (a free sample is not repriced)', () => {
    const p = computePnl({ ...base, orderItems: [{ order_id: 'o1', inventory_id: 'shirt', quantity: 4, unit_cost: 0 }] });
    assert.equal(p.cogs_blanks, 0);
  });
});
