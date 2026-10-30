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
  for (const p of payments) {
    const c = toCentavos(p.amount);
    paidC += c;
    if (!p.sync_status || p.sync_status === 'synced') syncedC += c;
  }
  const requiredC = Math.ceil(quoteC / 2);
  return {
    quote: toPesos(quoteC),
    total_paid: toPesos(paidC),
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

// Why the payment form is hidden for this order, in plain words (null = it is shown)
const paymentBlockedReason = (order, summary) => {
  if (!order) return null;
  if (order.production_status === 'Cancelled') return 'This order was cancelled, so it cannot take payments.';
  if (summary.quote <= 0) return 'The Owner must set the quote before payments can be recorded.';
  if (summary.remaining <= 0) return 'This order is fully paid.';
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
  paymentBlockedReason
};
