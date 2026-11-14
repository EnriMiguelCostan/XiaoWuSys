// ==========================================
// WASTE (PB 18 / PB 19 / PB 20): gathering the evidence for a new loss inside its transaction,
// and reading losses for the screens. The rules are in services/domain/wasteDiagnostics.js.
// ==========================================
const { selectList, serialize, sqliteAll, sqliteGet } = require('./records');
const { readBoth, REMOVED_ITEM } = require('./consumables');
const {
  classifyWaste, reasonLabel, categoryLabel, CLUSTER_STAGES, CLUSTER_WINDOW_MINUTES
} = require('./domain/wasteDiagnostics');

const TS = 'YYYY-MM-DD"T"HH24:MI:SS';
const STAGE_LIST_SQL = CLUSTER_STAGES.map((s) => `'${s}'`).join(', ');
// Two losses at the same moment must see each other, or neither would find the cluster:
// diagnoses are taken one at a time (a transaction-level lock, released at COMMIT / ROLLBACK).
const DIAGNOSIS_LOCK = 'xiaowusys:material_loss_diagnosis';

// Adds the new loss to the per-item totals -> [{ inventory_id, quantity }]
const withThisLoss = (rows, inventory_id, quantity_lost) => {
  const totals = rows.map((r) => ({ inventory_id: r.inventory_id, quantity: Number(r.quantity) }));
  const mine = totals.find((t) => t.inventory_id === inventory_id);
  if (mine) mine.quantity += quantity_lost;
  else totals.push({ inventory_id, quantity: quantity_lost });
  return totals;
};

// Cloud, inside the loss transaction and BEFORE the INSERT. CURRENT_TIMESTAMP is fixed for the
// whole transaction, so "now" here is exactly the date_recorded the new row will get.
//   input: { loss_id, inventory_id, order_id, reason_code, quantity_lost }
// -> { production_stage, diagnosis }
const diagnoseInCloud = async (client, input) => {
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [DIAGNOSIS_LOCK]);
  let production_stage = null;
  let history = [];
  if (input.order_id) {
    const order = await client.query('SELECT production_status FROM order_profiles WHERE order_id = $1', [input.order_id]);
    production_stage = order.rows[0] ? order.rows[0].production_status : null;
    history = (await client.query(
      `SELECT from_status, to_status, to_char(changed_at, '${TS}.MS') AS changed_at FROM order_status_history WHERE order_id = $1`,
      [input.order_id])).rows;
  }
  const now = (await client.query(`SELECT to_char(CURRENT_TIMESTAMP::timestamp, '${TS}.MS') AS now`)).rows[0].now;
  const nearby = CLUSTER_STAGES.includes(production_stage) ? (await client.query(
    `SELECT loss_id, production_stage, to_char(date_recorded, '${TS}.MS') AS date_recorded FROM material_loss
      WHERE production_stage IN (${STAGE_LIST_SQL})
        AND date_recorded BETWEEN CURRENT_TIMESTAMP::timestamp - interval '${CLUSTER_WINDOW_MINUTES} minutes'
                              AND CURRENT_TIMESTAMP::timestamp + interval '${CLUSTER_WINDOW_MINUTES} minutes'`)).rows : [];
  const totals = (await client.query(
    'SELECT inventory_id, SUM(quantity_lost)::int AS quantity FROM material_loss WHERE inventory_id IS NOT NULL GROUP BY inventory_id')).rows;
  const diagnosis = classifyWaste({
    loss: { ...input, production_stage, date_recorded: now },
    nearby,
    history,
    itemTotals: withThisLoss(totals, input.inventory_id, input.quantity_lost)
  });
  return { production_stage, diagnosis };
};

// The earlier losses of a machine-step cluster become 'Machine Failure' too (cloud only; a stated
// supplier defect keeps its cause) -> the loss_ids that changed
const escalateClusterInCloud = async (client, lossIds) => {
  if (lossIds.length === 0) return [];
  const { rows } = await client.query(
    `UPDATE material_loss SET loss_category = 'Machine Failure'
      WHERE loss_id = ANY($1::text[]) AND reason_code IS DISTINCT FROM 'supplier_defect'
        AND loss_category IS DISTINCT FROM 'Machine Failure'
      RETURNING loss_id`, [lossIds]);
  return rows.map((r) => r.loss_id);
};

// Offline: the same evidence from this computer's copy (inside its local transaction)
const diagnoseLocally = async (tx, input) => {
  let production_stage = null;
  let history = [];
  if (input.order_id) {
    const order = await sqliteGet(tx, 'SELECT production_status FROM order_profiles WHERE order_id = ?', [input.order_id]);
    production_stage = order ? order.production_status : null;
    history = await sqliteAll(tx,
      `SELECT from_status, to_status, strftime('%Y-%m-%dT%H:%M:%f', changed_at) AS changed_at FROM order_status_history WHERE order_id = ?`,
      [input.order_id]);
  }
  const now = (await sqliteGet(tx, "SELECT strftime('%Y-%m-%dT%H:%M:%S', 'now') AS now")).now;
  const window = CLUSTER_WINDOW_MINUTES / (24 * 60);
  const nearby = CLUSTER_STAGES.includes(production_stage) ? await sqliteAll(tx,
    `SELECT loss_id, production_stage, strftime('%Y-%m-%dT%H:%M:%S', date_recorded) AS date_recorded FROM material_loss
      WHERE production_stage IN (${STAGE_LIST_SQL})
        AND julianday(date_recorded) BETWEEN julianday('now') - ${window} AND julianday('now') + ${window}`) : [];
  const totals = await sqliteAll(tx,
    'SELECT inventory_id, SUM(quantity_lost) AS quantity FROM material_loss WHERE inventory_id IS NOT NULL GROUP BY inventory_id');
  const diagnosis = classifyWaste({
    loss: { ...input, production_stage, date_recorded: now },
    nearby,
    history,
    itemTotals: withThisLoss(totals, input.inventory_id, input.quantity_lost)
  });
  return { production_stage, diagnosis };
};

// A loss as the screens show it: the stored fields plus the item's name and plain labels
const shownLoss = (loss, row = {}) => ({
  ...loss,
  item_name: row.item_name || REMOVED_ITEM,
  unit: row.unit || null,
  reason_label: reasonLabel(loss.reason_code),
  category_label: categoryLabel(loss.loss_category)
});

const LOSS_SQL = (dialect, where) => `
  SELECT ${selectList('material_loss', dialect, 'l')}, i.item_name AS item_name, i.unit AS unit
    FROM material_loss l LEFT JOIN inventory_items i ON i.inventory_id = l.inventory_id
   ${where}
   ORDER BY l.date_recorded DESC, l.loss_id`;

// Losses recorded against one order, newest first -> { source, losses }
// Online, losses saved offline and not synced yet are listed too.
const loadOrderLosses = async (req, orderId) => {
  const { source, rows } = await readBoth(req, LOSS_SQL('pg', 'WHERE l.order_id = $1'), LOSS_SQL('sqlite', 'WHERE l.order_id = ?'), [orderId]);
  let all = rows;
  if (source === 'cloud') {
    try {
      const seen = new Set(rows.map((r) => r.loss_id));
      const pending = await sqliteAll(req.localDb, LOSS_SQL('sqlite', "WHERE l.order_id = ? AND l.sync_status = 'pending_insert'"), [orderId]);
      all = [...pending.filter((r) => !seen.has(r.loss_id)), ...rows];
    } catch (err) {
      console.error('⚠️ Could not read unsynced local losses:', err.message);
    }
  }
  return { source, losses: all.map((row) => shownLoss(serialize('material_loss', row), row)) };
};

// Every loss (newest first, up to limit), for the dashboard and the waste export
const loadAllLosses = async (req, { limit = 10000 } = {}) => {
  const lim = `LIMIT ${Number(limit)}`;
  const { source, rows } = await readBoth(req, `${LOSS_SQL('pg', '')} ${lim}`, `${LOSS_SQL('sqlite', '')} ${lim}`, []);
  let all = rows;
  if (source === 'cloud') {
    try {
      const seen = new Set(rows.map((r) => r.loss_id));
      const pending = await sqliteAll(req.localDb, LOSS_SQL('sqlite', "WHERE l.sync_status = 'pending_insert'"));
      all = [...pending.filter((r) => !seen.has(r.loss_id)), ...rows];
    } catch (err) {
      console.error('⚠️ Could not read unsynced local losses:', err.message);
    }
  }
  return { source, losses: all.map((row) => shownLoss(serialize('material_loss', row), row)) };
};

module.exports = { diagnoseInCloud, escalateClusterInCloud, diagnoseLocally, loadOrderLosses, loadAllLosses, shownLoss };
