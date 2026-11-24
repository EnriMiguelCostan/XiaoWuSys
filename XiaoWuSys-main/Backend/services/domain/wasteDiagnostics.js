// ==========================================
// WASTE DIAGNOSTICS (PB 18 / PB 19; pure rules: no HTTP, no SQL)
//
// Every material loss gets a standard reason code and, where the evidence allows, a cause:
//   'Machine Failure'  two or more losses during Printing / Pressing within 60 minutes of each
//                      other (any order, any operator): the press or printer is the common factor
//   'Product Defect'   the reason is a supplier defect, or this item's losses are far above the
//                      other items' (more than 2 standard deviations above their average)
//   'Human Error'      the order was rushed (Printing -> next step in under 5 minutes), or the
//                      reason itself is a human one (misprint, wrong size / name, storage)
// Checked in that order: a stated supplier defect first, then a cluster of machine-step losses,
// then the statistics, then a rushed step, then the reason's own category. No evidence and no
// code -> null ("Not classified").
//
// is_statistical_anomaly is set only by the statistics (the dashboard lists these), never by a
// reason code alone. The test compares the item's total against the OTHER items' totals
// (leave-one-out), needs at least 3 of them as a baseline, and is done in exact integer maths.
// Timestamps are the server's UTC text ('YYYY-MM-DDTHH:MM:SS'), like date_created.
// ==========================================

const LOSS_CATEGORIES = ['Machine Failure', 'Human Error', 'Product Defect'];
const NOT_CLASSIFIED = 'Not classified';

const REASON_CODES = {
  misprint_alignment: { label: 'Misprint / alignment error', category: 'Human Error' },
  sizing_encoding_error: { label: 'Wrong size / name / number printed', category: 'Human Error' },
  heat_press_scorch: { label: 'Heat press scorch / temperature spike', category: 'Machine Failure' },
  printer_head_banding: { label: 'Printer nozzle clog / banding / inkblot', category: 'Machine Failure' },
  supplier_defect: { label: 'Defective blank / pinhole / stain from supplier', category: 'Product Defect' },
  damaged_in_storage: { label: 'Damaged or lost in storage / handling', category: 'Human Error' }
};
const REASON_CODE_LIST = Object.keys(REASON_CODES);
const HUMAN_CODES = REASON_CODE_LIST.filter((c) => REASON_CODES[c].category === 'Human Error');

const CLUSTER_STAGES = ['Printing', 'Pressing'];
const CLUSTER_WINDOW_MINUTES = 60;
const RUSH_MINUTES = 5;
const SIGMA_LIMIT = 2;
const MIN_BASELINE_ITEMS = 3;

// Older screens and the API before migration 012 send free text only: map the common words
// to a code so the loss is still counted in the right group. Unknown text -> null.
const INFER_RULES = [
  ['supplier_defect', /\b(supplier|defect(ive)?|pinhole|stain(ed)?|factory)\b/i],
  ['heat_press_scorch', /\b(scorch(ed)?|burn(t|ed)?|heat ?press|temperature)\b/i],
  ['printer_head_banding', /\b(clog(ged)?|banding|nozzle|ink ?blot|smudge|printer)\b/i],
  ['sizing_encoding_error', /\b(wrong (size|name|number|spelling)|typo|misspell(ed)?|encod(e|ing))\b/i],
  ['misprint_alignment', /\b(mis-?print(ed)?|align(ment)?|off-?cent(er|re)|crooked)\b/i],
  ['damaged_in_storage', /\b(damaged?|lost|storage|handling|torn|wet|dropped|missing)\b/i]
];
const inferReasonCode = (text) => {
  if (typeof text !== 'string' || text.trim() === '') return null;
  const hit = INFER_RULES.find(([, re]) => re.test(text));
  return hit ? hit[0] : null;
};

const reasonLabel = (code) => (REASON_CODES[code] ? REASON_CODES[code].label : null);
const categoryLabel = (category) => category || NOT_CLASSIFIED;

const toMs = (utcText) => {
  if (!utcText) return NaN;
  const text = String(utcText).replace(' ', 'T');
  return Date.parse(/[zZ]|[+-]\d{2}:\d{2}$/.test(text) ? text : `${text}Z`);
};

// Another loss during a machine step within the window of this one -> its loss_id list
// loss / others: { loss_id, production_stage, date_recorded }
const clusterMates = (loss, others = []) => {
  if (!CLUSTER_STAGES.includes(loss.production_stage)) return [];
  const at = toMs(loss.date_recorded);
  if (!Number.isFinite(at)) return [];
  const windowMs = CLUSTER_WINDOW_MINUTES * 60 * 1000;
  return others
    .filter((o) => o.loss_id !== loss.loss_id && CLUSTER_STAGES.includes(o.production_stage))
    .filter((o) => {
      const t = toMs(o.date_recorded);
      return Number.isFinite(t) && Math.abs(t - at) <= windowMs;
    })
    .map((o) => o.loss_id);
};

// Did the order leave Printing (for Pressing or Completed) less than 5 minutes after entering it?
// history: [{ from_status, to_status, changed_at }] in any order
const wasRushed = (history = []) => {
  const rows = [...history].sort((a, b) => toMs(a.changed_at) - toMs(b.changed_at));
  let enteredPrinting = null;
  for (const h of rows) {
    if (h.to_status === 'Printing') enteredPrinting = toMs(h.changed_at);
    else if (h.from_status === 'Printing' && ['Pressing', 'Ready', 'Completed'].includes(h.to_status) && enteredPrinting !== null) {
      const spent = toMs(h.changed_at) - enteredPrinting;
      if (Number.isFinite(spent) && spent >= 0 && spent < RUSH_MINUTES * 60 * 1000) return true;
      enteredPrinting = null;
    }
  }
  return false;
};

// Is this item's total loss more than 2 standard deviations above the other items' average?
//   x = the item's total, others = the other items' totals (whole numbers, at least 3 of them)
// x > mean + 2*sd  <=>  n*x - S > 0  and  (n*x - S)^2 * (n - 1) > 4 * n * (n*Q - S^2)
// with n, S = sum, Q = sum of squares of the others, and sd the sample standard deviation.
const isLossAnomaly = (x, others = []) => {
  const n = BigInt(others.length);
  if (others.length < MIN_BASELINE_ITEMS) return false;
  const S = others.reduce((s, v) => s + BigInt(v), 0n);
  const Q = others.reduce((s, v) => s + BigInt(v) * BigInt(v), 0n);
  const diff = n * BigInt(x) - S;
  if (diff <= 0n) return false;
  const k = BigInt(SIGMA_LIMIT * SIGMA_LIMIT);
  return diff * diff * (n - 1n) > k * n * (n * Q - S * S);
};

// Average and sample standard deviation, for showing the baseline (not used for the decision)
const baselineOf = (others = []) => {
  if (others.length < MIN_BASELINE_ITEMS) return null;
  const n = others.length;
  const mean = others.reduce((s, v) => s + v, 0) / n;
  const sd = Math.sqrt(others.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1));
  return { items: n, mean: Math.round(mean * 100) / 100, sd: Math.round(sd * 100) / 100 };
};

// The cause of one loss.
//   loss:      { loss_id, inventory_id, reason_code, production_stage, date_recorded, quantity_lost }
//   nearby:    other losses (any order) around the same time: [{ loss_id, production_stage, date_recorded }]
//   history:   the order's status changes (empty when the loss is not linked to an order)
//   itemTotals: [{ inventory_id, quantity }] total quantity lost per item, INCLUDING this loss
// -> { loss_category, is_statistical_anomaly, rule, note, cluster_with, baseline }
//    rule: 'supplier_code' | 'machine_cluster' | 'statistical' | 'rushed_step' | 'reason_code' | null
const classifyWaste = ({ loss, nearby = [], history = [], itemTotals = [] }) => {
  const mates = clusterMates(loss, nearby);
  const mine = itemTotals.find((t) => t.inventory_id === loss.inventory_id);
  const others = itemTotals.filter((t) => t.inventory_id !== loss.inventory_id).map((t) => Number(t.quantity) || 0);
  const anomaly = Boolean(mine) && isLossAnomaly(Number(mine.quantity) || 0, others);
  const baseline = baselineOf(others);
  const result = (loss_category, rule, note) => ({
    loss_category, is_statistical_anomaly: anomaly, rule, note, cluster_with: mates, baseline
  });

  if (loss.reason_code === 'supplier_defect') {
    return result('Product Defect', 'supplier_code', 'Reported as a defect from the supplier.');
  }
  if (mates.length > 0) {
    return result('Machine Failure', 'machine_cluster',
      `${mates.length + 1} losses during printing or pressing within ${CLUSTER_WINDOW_MINUTES} minutes: check the machine.`);
  }
  if (anomaly) {
    return result('Product Defect', 'statistical',
      `This item's losses are far above the other items' (more than ${SIGMA_LIMIT} standard deviations): check the batch.`);
  }
  if (wasRushed(history)) {
    return result('Human Error', 'rushed_step', `The order left Printing less than ${RUSH_MINUTES} minutes after it started.`);
  }
  if (REASON_CODES[loss.reason_code]) {
    return result(REASON_CODES[loss.reason_code].category, 'reason_code', `From the reason: ${reasonLabel(loss.reason_code)}.`);
  }
  return result(null, null, 'Not enough information to name a cause.');
};

// SIA 1 / D1: a loss comes out of general stock (the order's reservation is untouched). When the
// free stock is gone afterwards, replacing the ruined pieces will need a restock first.
//   item: { item_name, quantity_available, quantity_reserved, unit }
// -> null | { code, message, free }   (never blocks the loss)
const replacementWarning = (item, { forOrder = false } = {}) => {
  if (!item) return null;
  const free = Number(item.quantity_available) - Number(item.quantity_reserved);
  if (free > 0) return null;
  return {
    code: 'REPLACEMENT_STOCK_DEPLETED',
    free,
    message: `No free "${item.item_name}" is left after this loss`
      + (forOrder ? ', so replacing the ruined pieces may delay this order.' : '.')
      + ' Restock it before more is needed.'
  };
};

module.exports = {
  replacementWarning,
  LOSS_CATEGORIES,
  NOT_CLASSIFIED,
  REASON_CODES,
  REASON_CODE_LIST,
  HUMAN_CODES,
  CLUSTER_STAGES,
  CLUSTER_WINDOW_MINUTES,
  RUSH_MINUTES,
  SIGMA_LIMIT,
  MIN_BASELINE_ITEMS,
  inferReasonCode,
  reasonLabel,
  categoryLabel,
  clusterMates,
  wasRushed,
  isLossAnomaly,
  baselineOf,
  classifyWaste
};
