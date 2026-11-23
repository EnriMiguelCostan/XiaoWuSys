// ==========================================
// PAYMENT RULES (PB 21; pure rules: no HTTP, no SQL)
//
// All money is compared in integer centavos, so ₱999.99 never turns into 999.9899999.
//
//   payment_status   'Unpaid' | 'Partial' | 'Fully Paid' | 'Overpaid'
//                    Separate from the production status (D4): an order can be Printing and
//                    Partial at the same time.
//   remaining        what the order can still take (never below 0)
//   overpaid_by      paid above the quote. Only happens when branches together overpay while
//                    offline (D2): sync never refuses a payment, so the Owner reviews it and
//                    refunds by hand.
//   downpayment      50% of the quote, rounded up to the centavo (like the approve route).
//                    Only payments already in the cloud count toward it ("paid_synced").
// ==========================================

const DOWNPAYMENT_STATUSES = ['Pending', 'Delayed']; // not approved yet

const toCentavos = (pesos) => Math.round(Number(pesos || 0) * 100);
const toPesos = (centavos) => Math.round(centavos) / 100;

// '₱1,234.50' (for messages; screens format numbers themselves)
const pesoText = (pesos) =>
  `₱${Number(pesos || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const statusFor = (quoteC, paidC) => {
  if (paidC <= 0) return 'Unpaid';
  if (quoteC <= 0 || paidC > quoteC) return 'Overpaid';
  return paidC === quoteC ? 'Fully Paid' : 'Partial';
};

// payments: [{ amount, sync_status }] (sync_status missing = in the cloud)
const paymentSummary = ({ quote, payments = [] }) => {
  const quoteC = Math.max(0, toCentavos(quote));
  let paidC = 0;
  let syncedC = 0;
  let refundedC = 0;
  for (const p of payments) {
    const c = toCentavos(p.amount);
    paidC += c;
    if (!p.sync_status || p.sync_status === 'synced') syncedC += c;
    if (p.is_refund) refundedC -= c; // migration 015: refunds are negative entries
  }
  const requiredC = Math.ceil(quoteC / 2);
  return {
    quote: toPesos(quoteC),
    total_paid: toPesos(paidC),
    total_refunded: toPesos(refundedC),
    remaining: toPesos(Math.max(0, quoteC - paidC)),
    overpaid_by: toPesos(Math.max(0, paidC - quoteC)),
    payment_status: statusFor(quoteC, paidC),
    downpayment: {
      required: toPesos(requiredC),
      paid_synced: toPesos(syncedC),
      met: quoteC > 0 && syncedC >= requiredC
    }
  };
};

// The totals right after each payment, in the order given (oldest first), for receipts:
// -> [{ payment_id, paid_to_date, remaining_after, status_after }]
const runningTotals = ({ quote, payments = [] }) => {
  const quoteC = Math.max(0, toCentavos(quote));
  let paidC = 0;
  return payments.map((p) => {
    paidC += toCentavos(p.amount);
    return {
      payment_id: p.payment_id,
      paid_to_date: toPesos(paidC),
      remaining_after: toPesos(Math.max(0, quoteC - paidC)),
      status_after: statusFor(quoteC, paidC)
    };
  });
};

// Whether a new payment may be recorded now. Amounts in pesos; paid = what is already paid
// in the view being checked (the cloud online, the local copy offline).
// -> null (allowed) | { status, body: { error, message, ...details } }
const checkPayment = ({ status, quote, paid, amount }) => {
  if (status === 'Cancelled') {
    return {
      status: 409,
      body: { error: 'ORDER_CLOSED', message: 'This order was cancelled, so it cannot take payments.' }
    };
  }
  const quoteC = toCentavos(quote);
  if (quoteC <= 0) {
    return {
      status: 422,
      body: { error: 'QUOTE_REQUIRED', message: 'This order has no price yet. Ask the Owner to set the quote before recording a payment.' }
    };
  }
  const paidC = toCentavos(paid);
  const remainingC = Math.max(0, quoteC - paidC);
  if (toCentavos(amount) > remainingC) {
    return {
      status: 409,
      body: {
        error: 'PAYMENT_EXCEEDS_BALANCE',
        message: remainingC === 0
          ? 'This order is already fully paid, so no more payments can be added.'
          : `The most this order can take now is ${pesoText(toPesos(remainingC))} (the remaining balance).`,
        remaining: toPesos(remainingC),
        total_paid: toPesos(paidC),
        total_quote_amount: toPesos(quoteC)
      }
    };
  }
  return null;
};

// Non-blocking notes after a payment (UAC exception for PB 21). Only for orders that are not
// approved yet. paidTotal includes this payment; paidSynced counts cloud payments only.
const downpaymentWarnings = ({ status, quote, paidTotal, paidSynced }) => {
  if (!DOWNPAYMENT_STATUSES.includes(status)) return [];
  const requiredC = Math.ceil(Math.max(0, toCentavos(quote)) / 2);
  if (requiredC <= 0) return [];
  const totalC = toCentavos(paidTotal);
  if (totalC < requiredC) {
    return [{
      code: 'DOWNPAYMENT_SHORT',
      message: `Not enough downpayment to start production: ${pesoText(toPesos(requiredC - totalC))} more is needed (50% of the quote).`
    }];
  }
  if (toCentavos(paidSynced) < requiredC) {
    return [{
      code: 'DOWNPAYMENT_NOT_SYNCED',
      message: 'The downpayment is complete, but some of it was saved offline. It counts for approval once it syncs to the cloud.'
    }];
  }
  return [];
};

// ---------- PB 23: voiding a payment (D3: never edited or deleted, only reversed) ----------
// Production has started on the strength of the downpayment in these statuses
const DOWNPAYMENT_LOCKED_STATUSES = ['Approved', 'Printing', 'Pressing'];

// May this payment be voided now? Amounts in pesos; paidSynced = what the cloud holds for the
// order now (voids included), quote = the order's quote.
//   payment: { amount, voided } (voided: a reversal for it already exists)
// -> null (allowed) | { status, body }
const checkPaymentVoid = ({ status, quote, paidSynced, payment, confirmBreak = false }) => {
  const amountC = toCentavos(payment.amount);
  if (amountC <= 0) {
    return {
      status: 409,
      body: { error: 'PAYMENT_NOT_VOIDABLE', message: 'This entry is itself a void, so it cannot be voided.' }
    };
  }
  if (payment.voided) {
    return {
      status: 409,
      body: { error: 'PAYMENT_ALREADY_VOIDED', message: 'This payment was already voided.' }
    };
  }
  if (DOWNPAYMENT_LOCKED_STATUSES.includes(status) && !confirmBreak) {
    const requiredC = Math.ceil(Math.max(0, toCentavos(quote)) / 2);
    const afterC = toCentavos(paidSynced) - amountC;
    if (afterC < requiredC) {
      return {
        status: 409,
        body: {
          error: 'VOID_BREAKS_DOWNPAYMENT',
          message: `This order is already in production. Voiding this payment leaves ${pesoText(toPesos(afterC))} paid, below the `
            + `50% downpayment of ${pesoText(toPesos(requiredC))}. Cancel the order first, or confirm that you want to void it anyway.`,
          required: toPesos(requiredC),
          paid_after: toPesos(afterC)
        }
      };
    }
  }
  return null;
};

// Which payments may still be voided, and which entries are voids -> per payment_id
//   { voided, voided_by_receipt_no, is_void, voids_receipt_no, can_void }
// Only cloud payments can be voided (voiding needs the cloud, and the receipt number).
const voidStatusOf = (payments = []) => {
  const byId = new Map(payments.map((p) => [p.payment_id, p]));
  const reversalOf = new Map(payments.filter((p) => p.voids_payment_id).map((p) => [p.voids_payment_id, p]));
  return new Map(payments.map((p) => {
    const reversal = reversalOf.get(p.payment_id);
    const isVoid = Boolean(p.voids_payment_id);
    return [p.payment_id, {
      voided: Boolean(reversal),
      voided_by_receipt_no: reversal ? reversal.receipt_no || null : null,
      is_void: isVoid,
      voids_receipt_no: isVoid ? (byId.get(p.voids_payment_id) || {}).receipt_no || null : null,
      can_void: !isVoid && !reversal && toCentavos(p.amount) > 0 && (!p.sync_status || p.sync_status === 'synced')
    }];
  }));
};

// Why the payment form is hidden for this order, in plain words (null = it is shown)
const paymentBlockedReason = (order, summary) => {
  if (!order) return null;
  if (order.production_status === 'Cancelled') return 'This order was cancelled, so it cannot take payments.';
  if (summary.quote <= 0) return 'The Owner must set the quote before payments can be recorded.';
  if (summary.remaining <= 0) return 'This order is fully paid.';
  return null;
};

// ---------- Migration 015: what each payment method needs ----------
// Each method lists the details a person can use to find and check the money later ("how do
// you know they paid, and who paid?"). Fields a method does not use are not saved for it.
//   required  must be filled in
//   optional  may be filled in
const PAYMENT_DETAIL_FIELDS = {
  payer_name: { label: 'Paid by (name)', max: 255, hint: 'Who handed over or sent the money, if not the customer.' },
  reference_no: { label: 'Reference / transaction number', max: 100 },
  bank_name: { label: 'Bank', max: 100 },
  account_name: { label: 'Sender account name or number', max: 255 },
  cheque_no: { label: 'Cheque number', max: 50 },
  cheque_date: { label: 'Date on the cheque', type: 'date' },
  payment_notes: { label: 'Notes', max: 500 }
};
const PAYMENT_METHOD_RULES = {
  Cash: { required: [], optional: ['payer_name', 'payment_notes'], verify: false },
  GCash: {
    required: ['reference_no'], optional: ['account_name', 'payer_name', 'payment_notes'], verify: true,
    labels: { reference_no: 'GCash reference number (13 digits)', account_name: 'Sender GCash name or number' }
  },
  Maya: {
    required: ['reference_no'], optional: ['account_name', 'payer_name', 'payment_notes'], verify: true,
    labels: { reference_no: 'Maya reference number', account_name: 'Sender Maya name or number' }
  },
  PayPal: {
    required: ['reference_no'], optional: ['account_name', 'payer_name', 'payment_notes'], verify: true,
    labels: { reference_no: 'PayPal transaction ID', account_name: 'Sender PayPal email or name' }
  },
  'Bank Transfer': {
    required: ['bank_name', 'reference_no'], optional: ['account_name', 'payer_name', 'payment_notes'], verify: true,
    labels: { bank_name: 'Bank the money came from', reference_no: 'Transfer reference number', account_name: 'Sender account name' }
  },
  Cheque: {
    required: ['bank_name', 'cheque_no', 'cheque_date'], optional: ['account_name', 'payer_name', 'payment_notes'], verify: true,
    labels: { bank_name: 'Bank on the cheque', account_name: 'Account name on the cheque' }
  },
  'Credit/Debit Card': {
    required: ['reference_no'], optional: ['bank_name', 'account_name', 'payer_name', 'payment_notes'], verify: true,
    labels: { reference_no: 'Approval code', bank_name: 'Card issuer (bank)', account_name: 'Cardholder name' }
  },
  Other: { required: ['payment_notes'], optional: ['reference_no', 'payer_name'], verify: true, labels: { payment_notes: 'How it was paid' } }
};
const PAYMENT_DETAIL_NAMES = Object.keys(PAYMENT_DETAIL_FIELDS);

// The form each method shows -> [{ value, verify, fields: [{ name, label, required, type, max, hint }] }]
const paymentMethodForms = (types) => types.map((value) => {
  const rule = PAYMENT_METHOD_RULES[value] || PAYMENT_METHOD_RULES.Other;
  return {
    value,
    verify: rule.verify,
    fields: [...rule.required, ...rule.optional].map((name) => ({
      name,
      label: (rule.labels && rule.labels[name]) || PAYMENT_DETAIL_FIELDS[name].label,
      required: rule.required.includes(name),
      type: PAYMENT_DETAIL_FIELDS[name].type || 'text',
      max: PAYMENT_DETAIL_FIELDS[name].max || null,
      hint: PAYMENT_DETAIL_FIELDS[name].hint || null
    }))
  };
});

// The details sent with a payment, checked for its method.
//   body: the request body; type: the payment method
// -> { errors: [{ field, message }], details: { payer_name, reference_no, ... } (null where unused) }
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
//   allOptional: a refund names how the money went back, but none of the method's fields are forced
const checkPaymentDetails = (type, body = {}, { allOptional = false } = {}) => {
  const base = PAYMENT_METHOD_RULES[type] || PAYMENT_METHOD_RULES.Other;
  const rule = allOptional ? { ...base, required: [], optional: [...base.required, ...base.optional] } : base;
  const allowed = new Set([...rule.required, ...rule.optional]);
  const errors = [];
  const details = Object.fromEntries(PAYMENT_DETAIL_NAMES.map((n) => [n, null]));
  for (const name of PAYMENT_DETAIL_NAMES) {
    const raw = body[name];
    const spec = PAYMENT_DETAIL_FIELDS[name];
    const label = (rule.labels && rule.labels[name]) || spec.label;
    const empty = raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '');
    if (!allowed.has(name)) continue; // not used by this method: ignored, never saved
    if (empty) {
      if (rule.required.includes(name)) errors.push({ field: name, message: `${label} is required for ${type}.` });
      continue;
    }
    if (typeof raw !== 'string') { errors.push({ field: name, message: `${label} must be written as text.` }); continue; }
    const text = raw.trim().replace(/\s+/g, ' ');
    if (spec.type === 'date') {
      const m = DATE_ONLY.exec(text);
      const d = m && new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
      if (!m || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3] || text < '2018-01-01' || text > '2034-12-31') {
        errors.push({ field: name, message: `${label} must be a real date. Pick it from the calendar.` });
        continue;
      }
    } else if (text.length > spec.max) {
      errors.push({ field: name, message: `${label} is too long. Keep it to ${spec.max} characters or fewer.` });
      continue;
    }
    details[name] = text;
  }
  return { errors, details };
};

// Does this payment still need someone to confirm the money arrived? (non-cash, not verified)
const needsVerification = (p) => Boolean(p) && toCentavos(p.amount) > 0 && !p.voids_payment_id && !p.is_refund
  && Boolean((PAYMENT_METHOD_RULES[p.payment_type] || PAYMENT_METHOD_RULES.Other).verify) && !p.verified_at;

// ---------- Migration 015: refunds (money given back) ----------
// A refund is a NEGATIVE payment with a reason, like a void, but for money that really went
// back to the customer (a void corrects a payment recorded by mistake).
//   Cancelled order: up to what was paid (net of earlier voids and refunds).
//   Any other order: only what was paid ABOVE the bill (overpaid). To give money back for a late
//   delivery or a mistake, the Owner first lowers the bill (price cut); the difference becomes
//   "overpaid" and is refunded.
const REFUND_REASONS = ['Order cancelled', 'Paid more than the bill', 'Late delivery (price cut)', 'Production error (price cut)', 'Other'];
const maxRefund = ({ status, quote, paidNet }) => {
  const paidC = Math.max(0, toCentavos(paidNet));
  if (status === 'Cancelled') return toPesos(paidC);
  return toPesos(Math.max(0, paidC - Math.max(0, toCentavos(quote))));
};
const checkRefund = ({ status, quote, paidNet, amount }) => {
  const maxC = toCentavos(maxRefund({ status, quote, paidNet }));
  if (toCentavos(paidNet) <= 0) {
    return { status: 409, body: { error: 'NOTHING_TO_REFUND', message: 'Nothing has been paid on this order, so there is nothing to refund.' } };
  }
  if (maxC <= 0) {
    return {
      status: 409,
      body: {
        error: 'REFUND_NOT_ALLOWED',
        message: 'Refunds are for cancelled orders, or for money paid above the bill. To give money back for a late delivery or a mistake, '
          + 'first lower the bill with a price cut, then refund what was paid above it.'
      }
    };
  }
  if (toCentavos(amount) > maxC) {
    return {
      status: 409,
      body: { error: 'REFUND_EXCEEDS_PAID', message: `The most that can be refunded now is ${pesoText(toPesos(maxC))}.`, max_refund: toPesos(maxC) }
    };
  }
  return null;
};

module.exports = {
  DOWNPAYMENT_STATUSES,
  toCentavos,
  toPesos,
  pesoText,
  paymentSummary,
  runningTotals,
  checkPayment,
  downpaymentWarnings,
  paymentBlockedReason,
  DOWNPAYMENT_LOCKED_STATUSES,
  checkPaymentVoid,
  voidStatusOf,
  PAYMENT_DETAIL_FIELDS,
  PAYMENT_DETAIL_NAMES,
  PAYMENT_METHOD_RULES,
  paymentMethodForms,
  checkPaymentDetails,
  needsVerification,
  REFUND_REASONS,
  maxRefund,
  checkRefund
};
