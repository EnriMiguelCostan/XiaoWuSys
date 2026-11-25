// ==========================================
// SHOP POLICIES (migration 017; pure rules: no HTTP, no SQL)
//
// 1. CANCELLATION FEE BY STAGE: the client pays for work and materials already used up.
//      Pending / Delayed   nothing is kept
//      Approved            a layout and handling fee: 10% of the bill, at least ₱150
//      Printing            the downpayment: 50% of the bill
//      Pressing / Ready    everything paid (the pieces are made for this client only)
//      the shop's fault    nothing is kept, at any stage
//    suggested refund = what was paid - the fee (never below 0). An Admin may refund up to the
//    suggestion; only the Owner may give back more (goodwill), up to what was paid.
//
// 2. LATE DELIVERY: only when the shop is at fault (no client_delay_reason on the order).
//      1 day of grace, then 2% of the bill per day late, at most 10%.
//      7 days late or more: the client may also cancel with a full refund (the shop's fault).
//    Planned batches count on their own: only the late batches' share of the bill is cut.
//    An Admin may give a price cut up to the suggestion; only the Owner may give more.
//
// 3. ITEMS ADDED AFTER APPROVAL ("add-ons"):
//      Pending / Delayed   anyone; the quote is simply calculated again
//      Approved / Printing an Owner or Admin. The new lines are priced on their own and added to
//                          the bill. Close to the deadline (3 days or less) or when the add-on
//                          is more than 25% of the pieces, the deadline must move later, or the
//                          manager writes why the old deadline still holds
//      Pressing and later  no: production is finished. It is a new order.
//
// 4. PRODUCTION PROGRESS (order_items.qty_printed / qty_pressed): a line is ready when it is
//    printed, and pressed when its item needs the heat press. Consumables lines are not counted.
// ==========================================
const { toCentavos, toPesos, pesoText } = require('./payments');

const CANCEL_POLICY = { approvedPercent: 10, approvedMinimum: 150, printingPercent: 50 };
const CANCEL_STAGE_RULES = {
  Pending: 'Nothing is kept before the job order is approved.',
  Delayed: 'Nothing is kept before the job order is approved.',
  Approved: `The shop keeps a layout and handling fee: ${CANCEL_POLICY.approvedPercent}% of the bill, at least ₱${CANCEL_POLICY.approvedMinimum}.`,
  Printing: `Printing has started: the shop keeps the downpayment (${CANCEL_POLICY.printingPercent}% of the bill).`,
  Pressing: 'The pieces are made for this client: the shop keeps everything paid.',
  Ready: 'The pieces are made for this client: the shop keeps everything paid.'
};
const SHOP_FAULT_RULE = "The shop's fault: nothing is kept, everything paid is refunded.";

// -> { stage, rule, fee, kept, paid, suggested_refund, shop_fault }   (pesos)
//   bill: the bill before any price cut is irrelevant here; the current total_quote_amount is used
const cancellationTerms = ({ status, bill, paidNet, shopFault = false }) => {
  const billC = Math.max(0, toCentavos(bill));
  const paidC = Math.max(0, toCentavos(paidNet));
  let feeC = 0;
  if (!shopFault) {
    if (status === 'Approved') {
      feeC = Math.max(Math.round((billC * CANCEL_POLICY.approvedPercent) / 100), toCentavos(CANCEL_POLICY.approvedMinimum));
      if (billC > 0) feeC = Math.min(feeC, billC);
    } else if (status === 'Printing') {
      feeC = Math.ceil((billC * CANCEL_POLICY.printingPercent) / 100);
    } else if (status === 'Pressing' || status === 'Ready') {
      feeC = Math.max(billC, paidC);
    }
  }
  const keptC = Math.min(paidC, feeC);
  return {
    stage: status,
    rule: shopFault ? SHOP_FAULT_RULE : (CANCEL_STAGE_RULES[status] || 'Nothing is kept.'),
    fee: toPesos(feeC),
    kept: toPesos(keptC),
    paid: toPesos(paidC),
    suggested_refund: toPesos(paidC - keptC),
    shop_fault: Boolean(shopFault)
  };
};

// What may be refunded, and by whom -> { owner_max, admin_max, suggested }   (pesos)
//   Cancelled: the Owner up to everything paid; an Admin up to paid - the stored fee.
//   Open or completed: only what was paid above the bill (both roles).
const refundLimits = ({ status, bill, paidNet, cancellationFee = null }) => {
  const paidC = Math.max(0, toCentavos(paidNet));
  if (status === 'Cancelled') {
    const feeC = cancellationFee === null || cancellationFee === undefined ? 0 : Math.max(0, toCentavos(cancellationFee));
    const suggestedC = Math.max(0, paidC - feeC);
    return { owner_max: toPesos(paidC), admin_max: toPesos(suggestedC), suggested: toPesos(suggestedC) };
  }
  const overC = Math.max(0, paidC - Math.max(0, toCentavos(bill)));
  return { owner_max: toPesos(overC), admin_max: toPesos(overC), suggested: toPesos(overC) };
};

// ---------- Late delivery ----------
const LATE_POLICY = { graceDays: 1, percentPerDay: 2, maxPercent: 10, cancelAfterDays: 7 };
const dayOf = (text) => (text ? String(text).slice(0, 10) : null);
const daysBetween = (fromYmd, toYmd) => Math.round((Date.parse(`${toYmd}T00:00:00Z`) - Date.parse(`${fromYmd}T00:00:00Z`)) / 86400000);
const latePercent = (daysLate) => Math.min(LATE_POLICY.maxPercent, Math.max(0, (daysLate - LATE_POLICY.graceDays) * LATE_POLICY.percentPerDay));

// order: { production_deadline, production_status, total_quote_amount, adjustment_amount, client_delay_reason }
// deliveries: [{ quantity, delivered_at (shop day or timestamp), plan_id }]  plans: [{ plan_id, batch_no, planned_quantity, planned_date }]
// finishedDay: the shop day the order was completed (null while open); today: the shop day now
// -> { applies, client_caused, days_late, percent, amount, full_refund_eligible, batches: [...], note }
const lateDeliveryCut = ({ order, deliveries = [], plans = [], piecesOrdered = 0, finishedDay = null, today }) => {
  const billC = Math.max(0, toCentavos(order.total_quote_amount) + toCentavos(order.adjustment_amount));
  const empty = (note, extra = {}) => ({
    applies: false, client_caused: false, days_late: 0, percent: 0, amount: 0, full_refund_eligible: false, batches: [], note, ...extra
  });
  if (order.production_status === 'Cancelled') return empty('The order was cancelled.');
  if (order.client_delay_reason) return empty(`No price cut: the delay was the client's doing (${order.client_delay_reason}).`, { client_caused: true });
  const deadline = dayOf(order.production_deadline);
  if (!deadline || billC === 0) return empty('No deadline or no bill yet.');

  const sorted = [...deliveries].sort((a, b) => String(a.delivered_at).localeCompare(String(b.delivered_at)));
  // The day a group of pieces was all handed over: the delivery that completed it, else (open) today
  const doneDay = (wanted, list) => {
    let sum = 0;
    for (const d of list) {
      sum += Number(d.quantity || 0);
      if (sum >= wanted) return dayOf(d.delivered_at);
    }
    return finishedDay || today;
  };

  const datedPlans = plans.filter((p) => p.planned_date && Number(p.planned_quantity) > 0);
  if (datedPlans.length > 0 && piecesOrdered > 0) {
    let cutC = 0;
    let worst = 0;
    const batches = datedPlans.map((p) => {
      const end = doneDay(Number(p.planned_quantity), sorted.filter((d) => d.plan_id === p.plan_id));
      const due = dayOf(p.planned_date);
      const late = Math.max(0, daysBetween(due, end));
      const percent = latePercent(late);
      const shareC = Math.round((billC * Number(p.planned_quantity)) / piecesOrdered);
      const amountC = Math.round((shareC * percent) / 100);
      cutC += amountC;
      worst = Math.max(worst, late);
      return { batch_no: p.batch_no, planned_date: due, done_day: end, days_late: late, percent, amount: toPesos(amountC) };
    });
    cutC = Math.min(cutC, Math.round((billC * LATE_POLICY.maxPercent) / 100));
    return {
      applies: cutC > 0, client_caused: false, days_late: worst,
      percent: billC ? Math.round((cutC * 10000) / billC) / 100 : 0,
      amount: toPesos(cutC),
      full_refund_eligible: worst >= LATE_POLICY.cancelAfterDays && !['Completed'].includes(order.production_status),
      batches,
      note: cutC > 0 ? `Late batches: ${batches.filter((b) => b.amount > 0).map((b) => `#${b.batch_no} (${b.days_late} day${b.days_late === 1 ? '' : 's'})`).join(', ')}.` : 'Every batch was on time (1 day of grace).'
    };
  }

  const end = order.production_status === 'Completed' ? (finishedDay || doneDay(piecesOrdered, sorted)) : today;
  const late = Math.max(0, daysBetween(deadline, end));
  const percent = latePercent(late);
  const cutC = Math.round((billC * percent) / 100);
  return {
    applies: cutC > 0, client_caused: false, days_late: late, percent,
    amount: toPesos(cutC),
    full_refund_eligible: late >= LATE_POLICY.cancelAfterDays && order.production_status !== 'Completed',
    batches: [],
    note: late === 0 ? 'On time.' : late <= LATE_POLICY.graceDays ? `${late} day late: within the 1 day of grace.`
      : `${late} days late: ${percent}% of the bill (${pesoText(toPesos(cutC))}).`
  };
};

// ---------- Items added after approval ----------
const ADD_ON_POLICY = { deadlineDays: 3, maxShare: 25 };
const ADD_ON_OPEN = ['Pending', 'Delayed'];
const ADD_ON_MANAGED = ['Approved', 'Printing'];
// -> null (allowed as is) | { status, body } (refused) | { addOn: true, deadlineReview: bool }
const addOnCheck = ({ status, isManager, deadline, today, existingPieces, addPieces, newDeadline = null, keepReason = null }) => {
  if (ADD_ON_OPEN.includes(status)) return { addOn: false, deadlineReview: false };
  if (!ADD_ON_MANAGED.includes(status)) {
    return {
      status: 409,
      body: {
        error: 'ADD_ON_CLOSED',
        message: `This order is ${status}: production is finished, so items can no longer be added. Take the extra pieces as a new order.`
      }
    };
  }
  if (!isManager) {
    return {
      status: 403,
      body: { error: 'ADD_ON_NEEDS_MANAGER', message: 'The job order is approved. Only the Owner or an Admin can add items to it now.' }
    };
  }
  const due = dayOf(deadline);
  const close = Boolean(due && today && daysBetween(today, due) <= ADD_ON_POLICY.deadlineDays);
  const big = existingPieces > 0 && addPieces * 100 > existingPieces * ADD_ON_POLICY.maxShare;
  const review = close || big;
  if (review && !(newDeadline && due && dayOf(newDeadline) > due) && !(keepReason && String(keepReason).trim())) {
    return {
      status: 409,
      body: {
        error: 'ADD_ON_NEEDS_DEADLINE',
        message: (close ? `The deadline is ${ADD_ON_POLICY.deadlineDays} days away or less. ` : '')
          + (big ? `The extra ${addPieces} pieces are more than ${ADD_ON_POLICY.maxShare}% of the ${existingPieces} already ordered. ` : '')
          + 'Set a later deadline, or write why the current deadline still holds.',
        deadline: due,
        close_to_deadline: close,
        large_add_on: big
      }
    };
  }
  return { addOn: true, deadlineReview: review };
};

// ---------- Production progress ----------
// lines: [{ line_item_id, product_type, quantity, qty_printed, qty_pressed, requires_pressing, is_consumable }]
// status: the order's status. A step already passed says it for itself (orders from before
// migration 017 have no counts): Pressing = everything printed, Ready / Completed = all done.
// -> { lines: [{ ..., needs_pressing, printed, pressed, ready }], pieces, printed, pressed, ready, press_pieces,
//      all_printed, all_ready, needs_pressing }
const PRINTED_BY_STATUS = ['Pressing', 'Ready', 'Completed'];
const DONE_BY_STATUS = ['Ready', 'Completed'];
// The counts a status implies, on top of the recorded ones
const effectiveCounts = (l, status) => {
  const quantity = Number(l.quantity || 0);
  const needs = Boolean(l.requires_pressing);
  const printed = PRINTED_BY_STATUS.includes(status) ? quantity : Math.min(quantity, Math.max(0, Number(l.qty_printed || 0)));
  const pressed = !needs ? 0 : DONE_BY_STATUS.includes(status) ? quantity : Math.min(printed, Math.max(0, Number(l.qty_pressed || 0)));
  return { quantity, needs, printed, pressed };
};
const productionProgress = (lines = [], status = null) => {
  const shown = lines.filter((l) => !l.is_consumable).map((l) => {
    const { quantity, needs, printed, pressed } = effectiveCounts(l, status);
    return {
      line_item_id: l.line_item_id, product_type: l.product_type, size: l.size || null, quantity,
      needs_pressing: needs, printed, pressed, ready: needs ? pressed : printed
    };
  });
  const sum = (k) => shown.reduce((s, l) => s + l[k], 0);
  const pieces = sum('quantity');
  return {
    lines: shown,
    pieces,
    printed: sum('printed'),
    pressed: sum('pressed'),
    ready: sum('ready'),
    press_pieces: shown.filter((l) => l.needs_pressing).reduce((s, l) => s + l.quantity, 0),
    all_printed: shown.every((l) => l.printed >= l.quantity),
    all_ready: shown.every((l) => l.ready >= l.quantity),
    needs_pressing: shown.some((l) => l.needs_pressing)
  };
};

// A progress update -> { problem } | { updates: [{ line_item_id, printed, pressed }] }
//   sent: [{ line_item_id, printed?, pressed? }]   (whole numbers; left out = unchanged)
//   delivered: pieces already handed over (ready may never drop below it)
const checkProgressUpdate = ({ lines: recorded, sent, delivered = 0, status = null }) => {
  const lines = recorded.map((l) => {
    const e = effectiveCounts(l, status);
    return { ...l, qty_printed: e.printed, qty_pressed: e.pressed };
  });
  if (!Array.isArray(sent) || sent.length === 0) {
    return { problem: { status: 400, body: { error: 'VALIDATION_FAILED', message: 'Send at least one line.' } } };
  }
  const byId = new Map(lines.map((l) => [l.line_item_id, l]));
  const next = new Map(lines.map((l) => [l.line_item_id, { printed: Number(l.qty_printed || 0), pressed: Number(l.qty_pressed || 0) }]));
  for (const s of sent) {
    const line = s && byId.get(s.line_item_id);
    if (!line || line.is_consumable) {
      return { problem: { status: 400, body: { error: 'VALIDATION_FAILED', message: 'One of the lines is not an item of this order.' } } };
    }
    const n = next.get(line.line_item_id);
    for (const key of ['printed', 'pressed']) {
      if (s[key] === undefined || s[key] === null) continue;
      if (!Number.isInteger(s[key]) || s[key] < 0) {
        return { problem: { status: 400, body: { error: 'VALIDATION_FAILED', message: `${line.product_type}: ${key} must be a whole number, 0 or more.` } } };
      }
      n[key] = s[key];
    }
    if (!line.requires_pressing) n.pressed = 0;
    if (n.printed > Number(line.quantity)) {
      return { problem: { status: 422, body: { error: 'PROGRESS_TOO_HIGH', message: `${line.product_type}: only ${line.quantity} ordered, so at most ${line.quantity} can be printed.` } } };
    }
    if (n.pressed > n.printed) {
      return { problem: { status: 422, body: { error: 'PROGRESS_TOO_HIGH', message: `${line.product_type}: ${n.pressed} pressed but only ${n.printed} printed. A piece is printed before it is pressed.` } } };
    }
  }
  const after = productionProgress(lines.map((l) => ({ ...l, qty_printed: next.get(l.line_item_id).printed, qty_pressed: next.get(l.line_item_id).pressed })));
  if (after.ready < delivered) {
    return {
      problem: {
        status: 422,
        body: { error: 'PROGRESS_BELOW_DELIVERED', message: `${delivered} pieces were already handed over, so at least ${delivered} must stay ready.` }
      }
    };
  }
  return { updates: [...next].map(([line_item_id, v]) => ({ line_item_id, printed: v.printed, pressed: v.pressed })), after };
};

module.exports = {
  CANCEL_POLICY, CANCEL_STAGE_RULES, cancellationTerms, refundLimits,
  LATE_POLICY, latePercent, lateDeliveryCut,
  ADD_ON_POLICY, addOnCheck,
  productionProgress, checkProgressUpdate, effectiveCounts
};
