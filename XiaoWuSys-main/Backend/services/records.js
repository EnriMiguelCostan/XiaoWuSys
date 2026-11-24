// ==========================================
// RECORD ACCESS LAYER (Audit fixes M7 existence checks, M9 transactions, M10 read shapes)
//
// One definition per entity drives the SELECT list for BOTH databases, and one serializer
// turns rows from either into the SAME JSON shape:
//   money      -> number (2 dp)          Postgres NUMERIC comes back as a string otherwise
//   rate       -> number (3 dp)          usage per piece, NUMERIC(10,3) (migration 011)
//   timestamp  -> 'YYYY-MM-DDTHH:MM:SS'  Postgres Date objects vs SQLite text otherwise
//   date       -> 'YYYY-MM-DD'           a calendar day (migration 015: cheque date)
//   + version      cloud last_modified (online) / last cloud version seen (offline)
//   + sync_status  'synced' | 'pending_insert' | 'pending_update'
//   + sync_conflict true when an offline edit is blocked by a newer cloud edit (C3)
// ==========================================
const sqlite3 = require('sqlite3');
const { isConnectionError } = require('../utils/dbErrors');
const { PG_VERSION_FORMAT } = require('../utils/localSync');

const ENTITIES = {
  order_profiles: {
    id: 'order_id',
    fields: {
      order_id: 'text', customer_id: 'text', date_created: 'timestamp', production_deadline: 'timestamp',
      production_status: 'text', design_drive_link: 'text', total_quote_amount: 'money',
      stock_reserved: 'bool', approved_by: 'text', approved_at: 'timestamp',
      tracking_no: 'text', // XM-YYYY-NNNN, given by the cloud database (null until an offline order syncs)
      // PB 5 (migration 009): who last changed the order, and their role then. Used to decide
      // whether a higher rank may replace a conflicting change. Null for older orders.
      last_edited_by: 'text', last_edited_role: 'text',
      // PB 11 / PB 12 (migration 011): the quote's breakdown (total = subtotal - discount)
      subtotal_amount: 'money', discount_amount: 'money', discount_reason: 'text',
      // PB 23 (migration 012): why the Owner cancelled (voided) the order
      cancellation_reason: 'text',
      // PB 23 / D2 (migration 013): archived (hidden, read-only, kept forever) and by whom
      archived_at: 'timestamp', archived_by: 'text',
      // migration 015: instructions for the job, and the quote's labor / incidental parts
      order_description: 'text', labor_amount: 'money', incidental_amount: 'money',
      adjustment_amount: 'money', adjustment_reason: 'text', // a price cut after approval, with its reason
      branch_id: 'text' // migration 016: the client's branch this order is for (null = the main branch)
    }
  },
  // migration 016: a client's other branches (the client's own address is the main branch)
  customer_branches: {
    id: 'branch_id',
    fields: {
      branch_id: 'text', customer_id: 'text', branch_name: 'text', address: 'text', contact_person: 'text',
      contact_number: 'text', email: 'text', notes: 'text', archived_at: 'timestamp', archived_by: 'text',
      created_by: 'text', created_at: 'timestamp'
    }
  },
  // migration 016: delivery batches planned ahead (pieces per batch, date, ready or not)
  order_delivery_plans: {
    id: 'plan_id',
    fields: {
      plan_id: 'text', order_id: 'text', batch_no: 'int', planned_quantity: 'int', planned_date: 'date',
      ready_at: 'timestamp', ready_by: 'text', notes: 'text', created_by: 'text', created_at: 'timestamp'
    }
  },
  // migration 015: sizes / names / numbers printed on an order (no stock of their own)
  order_print_details: {
    id: 'print_detail_id',
    fields: {
      print_detail_id: 'text', order_id: 'text', line_item_id: 'text', print_type: 'text', quantity: 'int',
      size: 'text', custom_name: 'text', custom_number: 'text', notes: 'text', created_by: 'text', created_at: 'timestamp'
    }
  },
  // migration 015: pieces handed to the customer, batch by batch
  order_deliveries: {
    id: 'delivery_id',
    fields: {
      delivery_id: 'text', order_id: 'text', batch_no: 'int', quantity: 'int', delivered_at: 'timestamp', method: 'text',
      received_by_name: 'text', notes: 'text', recorded_by: 'text', created_at: 'timestamp',
      plan_id: 'text' // migration 016: the planned batch this hand-over belongs to
    }
  },
  // migration 015: supplier profiles
  suppliers: {
    id: 'supplier_id',
    fields: {
      supplier_id: 'text', supplier_name: 'text', contact_person: 'text', contact_number: 'text', email: 'text',
      address: 'text', notes: 'text', archived_at: 'timestamp', archived_by: 'text', created_at: 'timestamp'
    }
  },
  // migration 015: stock in (SI-), stock out (SO-), stock count (SC-). Cloud only (not mirrored)
  stock_documents: {
    id: 'document_id',
    fields: {
      document_id: 'text', document_type: 'text', document_no: 'text', reason: 'text', supplier_id: 'text', order_id: 'text',
      reference_type: 'text', reference_no: 'text', occurred_at: 'timestamp', notes: 'text', total_cost: 'money',
      recorded_by: 'text', recorded_role: 'text', created_at: 'timestamp', edited_at: 'timestamp', edited_by: 'text',
      voided_at: 'timestamp', voided_by: 'text', void_reason: 'text'
    }
  },
  stock_document_lines: {
    id: 'line_id',
    fields: {
      line_id: 'text', document_id: 'text', line_no: 'int', inventory_id: 'text', item_name: 'text', unit: 'text',
      quantity: 'int', system_quantity: 'int', unit_cost: 'money'
    }
  },
  // migration 015: the stock card, one row per change of the quantity on hand. Cloud only
  stock_movements: {
    id: 'movement_id',
    fields: {
      movement_id: 'text', inventory_id: 'text', item_name: 'text', movement_type: 'text', quantity_change: 'int',
      balance_after: 'int', unit_cost: 'money', reference_type: 'text', reference_id: 'text', reference_no: 'text',
      note: 'text', performed_by: 'text', performed_role: 'text', occurred_at: 'timestamp', created_at: 'timestamp'
    }
  },
  // PB 22 (migration 012): rent, electricity, wages... for the true-cost P&L
  overhead_expenses: {
    id: 'expense_id',
    fields: {
      expense_id: 'text', expense_date: 'timestamp', category: 'text', description: 'text', amount: 'money',
      recorded_by: 'text'
    }
  },
  // PB 15 (migration 011): how much of a consumable one piece of a blank uses, and when
  consumable_rates: {
    id: 'rate_id',
    fields: {
      rate_id: 'text', product_inventory_id: 'text', consumable_inventory_id: 'text',
      quantity_per_piece: 'rate', trigger_status: 'text'
    }
  },
  // PB 15 (migration 011): what an order's status changes took from stock (exactly once each)
  order_consumables_log: {
    id: 'log_id',
    fields: {
      log_id: 'text', order_id: 'text', trigger_status: 'text', consumable_inventory_id: 'text',
      quantity_deducted: 'int', shortfall: 'int', deducted_at: 'timestamp',
      unit_cost: 'money' // PB 22 (migration 013): the consumable's cost when it was taken (null on older rows)
    }
  },
  // PB 14 (migration 010): one row per status change, written in the cloud only
  order_status_history: {
    id: 'history_id',
    fields: {
      history_id: 'text', order_id: 'text', from_status: 'text', to_status: 'text',
      changed_by: 'text', changed_role: 'text', changed_at: 'timestamp'
    }
  },
  order_items: {
    id: 'line_item_id',
    fields: {
      line_item_id: 'text', order_id: 'text', inventory_id: 'text', product_type: 'text', quantity: 'int',
      size: 'text', custom_name: 'text', custom_number: 'text', price: 'money',
      unit_cost: 'money' // PB 22 (migration 013): the blank's cost when the order was Completed (null before)
    }
  },
  payments: {
    id: 'payment_id',
    fields: {
      payment_id: 'text', order_id: 'text', amount: 'money', payment_date: 'timestamp', payment_type: 'text',
      received_by: 'text', // user_id from the login token (migration 008); null for older payments
      receipt_no: 'text',  // AR-YYYY-NNNN, given by the cloud database (null until an offline payment syncs)
      // PB 23 (migration 012): a void is a negative payment pointing at the one it reverses
      voids_payment_id: 'text', void_reason: 'text',
      // migration 015: who paid and the details each method needs; refunds; verification.
      // payment_date is when the customer paid (may be earlier than recorded_at)
      payer_name: 'text', reference_no: 'text', bank_name: 'text', account_name: 'text', cheque_no: 'text',
      cheque_date: 'date', payment_notes: 'text', is_refund: 'bool', refund_reason: 'text',
      verified_by: 'text', verified_at: 'timestamp', recorded_at: 'timestamp'
    }
  },
  material_loss: {
    id: 'loss_id',
    fields: {
      loss_id: 'text', order_id: 'text', inventory_id: 'text', quantity_lost: 'int', loss_reason: 'text',
      date_recorded: 'timestamp', financial_cost: 'money',
      // PB 18 / PB 19 (migration 012): standard reason, diagnosed cause, order status at the time
      reason_code: 'text', loss_category: 'text', production_stage: 'text', is_statistical_anomaly: 'bool',
      loss_batch_id: 'text', // migration 015: losses recorded together (bulk waste)
      print_detail_id: 'text' // migration 016: the print line it ruined (e.g. jersey #10, size L)
    }
  },
  inventory_items: {
    id: 'inventory_id',
    fields: {
      inventory_id: 'text', item_name: 'text', item_category: 'text', quantity_available: 'int',
      quantity_reserved: 'int', minimum_threshold: 'int', unit_cost: 'money',
      unit: 'text', supplier: 'text', deleted_at: 'timestamp', deleted_by: 'text',
      selling_price: 'money', // PB 11 (migration 011): charged per piece before volume discounts
      supplier_id: 'text', has_sizes: 'bool', // migration 015: usual supplier; a garment (print details have sizes)
      requires_pressing: 'bool' // migration 016: a T-shirt, so its orders go through the heat press
    }
  },
  customers: {
    id: 'customer_id',
    fields: {
      customer_id: 'text', full_name: 'text', contact_number: 'text', platform_source: 'text',
      archived_at: 'timestamp', archived_by: 'text', // PB 23 / D2 (migration 013)
      // migration 015: client profile
      customer_type: 'text', contact_person: 'text', email: 'text', address: 'text', social_media: 'text', notes: 'text',
      // migration 016: the contact person's own details (apart from the client's)
      contact_person_number: 'text', contact_person_email: 'text', contact_person_social: 'text'
    }
  }
};

// Row filters for the catalog vs. the Recycle Bin (same SQL in Postgres and SQLite)
const ACTIVE_ITEM_SQL = 'deleted_at IS NULL AND purged_at IS NULL';
const BIN_ITEM_SQL = 'deleted_at IS NOT NULL AND purged_at IS NULL';

// ---------- SELECT lists ----------
const columnExpr = (dialect, alias, col, type) => {
  const ref = alias ? `${alias}.${col}` : col;
  if (type === 'timestamp') {
    return dialect === 'pg'
      ? `to_char(${ref}, 'YYYY-MM-DD"T"HH24:MI:SS') AS ${col}`
      : `strftime('%Y-%m-%dT%H:%M:%S', ${ref}) AS ${col}`;
  }
  if (type === 'date') {
    return dialect === 'pg' ? `to_char(${ref}, 'YYYY-MM-DD') AS ${col}` : `substr(${ref}, 1, 10) AS ${col}`;
  }
  if ((type === 'money' || type === 'rate') && dialect === 'pg') return `${ref}::text AS ${col}`;
  return `${ref} AS ${col}`;
};

const selectList = (table, dialect, alias = '') => {
  const { fields } = ENTITIES[table];
  const ref = (c) => (alias ? `${alias}.${c}` : c);
  const cols = Object.entries(fields).map(([col, type]) => columnExpr(dialect, alias, col, type));
  if (dialect === 'pg') {
    cols.push(`to_char(${ref('last_modified')}, '${PG_VERSION_FORMAT}') AS version`,
      `'synced' AS sync_status`, `NULL AS sync_conflict`);
  } else {
    cols.push(`${ref('cloud_last_modified')} AS version`, `${ref('sync_status')} AS sync_status`,
      `${ref('sync_conflict')} AS sync_conflict`);
  }
  return cols.join(', ');
};

const serialize = (table, row) => {
  if (!row) return null;
  const out = {};
  for (const [col, type] of Object.entries(ENTITIES[table].fields)) {
    const v = row[col];
    if (v === undefined || v === null) out[col] = type === 'bool' ? false : null;
    else if (type === 'money') out[col] = Math.round(Number(v) * 100) / 100;
    else if (type === 'rate') out[col] = Math.round(Number(v) * 1000) / 1000; // NUMERIC(10,3)
    else if (type === 'int') out[col] = Number(v);
    else if (type === 'bool') out[col] = v === true || v === 1 || v === '1' || v === 't' || v === 'true';
    else out[col] = String(v);
  }
  out.version = row.version || null;
  out.sync_status = row.sync_status || 'synced';
  out.sync_conflict = Boolean(row.sync_conflict);
  return out;
};

// ---------- SQLite promise helpers ----------
const sqliteAll = (db, sql, params = []) =>
  new Promise((resolve, reject) => db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows))));
const sqliteGet = (db, sql, params = []) =>
  new Promise((resolve, reject) => db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row))));
const sqliteRun = (db, sql, params = []) =>
  new Promise((resolve, reject) =>
    db.run(sql, params, function (err) { return err ? reject(err) : resolve({ changes: this.changes }); })
  );

// ---------- Reads with C5-aware fallback ----------
// raw: optional SQL condition valid in both dialects (e.g. ACTIVE_ITEM_SQL), never user input
// filters: [column, value] (equals) or [column, value, 'LIKE']. The column and operator are
// always written in code; only the value comes from the request, and it is always a parameter.
const FILTER_OPERATORS = new Set(['=', 'LIKE']);
const buildWhere = (filters, dialect, raw = null) => {
  const params = [];
  const clauses = filters
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([col, value, op = '=']) => {
      if (!FILTER_OPERATORS.has(op)) throw new Error(`Unsupported filter operator: ${op}`);
      params.push(value);
      return `${col} ${op} ${dialect === 'pg' ? `$${params.length}` : '?'}`;
    });
  if (raw) clauses.push(`(${raw})`);
  return { sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
};

// Lists rows. Online results also include matching local rows that were created offline and
// are not in Neon yet, so a record never "disappears" between creation and the next sync.
const listRecords = async (req, table, { filters = [], where = null, orderBy, limit = 1000, offset = 0 } = {}) => {
  const spec = ENTITIES[table];
  const order = orderBy || spec.id;
  try {
    const cond = buildWhere(filters, 'pg', where);
    const { rows } = await req.pgPool.query(
      `SELECT ${selectList(table, 'pg')} FROM ${table} ${cond.sql}
        ORDER BY ${order} LIMIT ${Number(limit)} OFFSET ${Number(offset)}`,
      cond.params
    );
    const records = rows.map((r) => serialize(table, r));

    let unsynced = [];
    try {
      const local = buildWhere([...filters, ['sync_status', 'pending_insert']], 'sqlite', where);
      const seen = new Set(records.map((r) => r[spec.id]));
      unsynced = (await sqliteAll(req.localDb, `SELECT ${selectList(table, 'sqlite')} FROM ${table} ${local.sql} ORDER BY ${order}`, local.params))
        .map((r) => serialize(table, r))
        .filter((r) => !seen.has(r[spec.id]));
    } catch (localErr) {
      console.error(`⚠️ Could not read unsynced local ${table}:`, localErr.message);
    }
    return { source: 'cloud', records: [...records, ...unsynced], unsynced: unsynced.length };
  } catch (err) {
    if (!isConnectionError(err)) throw err;
    const cond = buildWhere(filters, 'sqlite', where);
    const rows = await sqliteAll(
      req.localDb,
      `SELECT ${selectList(table, 'sqlite')} FROM ${table} ${cond.sql}
        ORDER BY ${order} LIMIT ${Number(limit)} OFFSET ${Number(offset)}`,
      cond.params
    );
    return { source: 'local', records: rows.map((r) => serialize(table, r)), unsynced: 0 };
  }
};

// COUNT(*) with the same cloud-first / local-fallback rule -> { source, count }
const countRecords = async (req, table, { filters = [], where = null } = {}) => {
  try {
    const cond = buildWhere(filters, 'pg', where);
    const { rows } = await req.pgPool.query(`SELECT COUNT(*)::int AS n FROM ${table} ${cond.sql}`, cond.params);
    return { source: 'cloud', count: rows[0].n };
  } catch (err) {
    if (!isConnectionError(err)) throw err;
    const cond = buildWhere(filters, 'sqlite', where);
    const row = await sqliteGet(req.localDb, `SELECT COUNT(*) AS n FROM ${table} ${cond.sql}`, cond.params);
    return { source: 'local', count: Number(row.n) };
  }
};

const getRecord = async (req, table, id) => {
  const { source, records } = await listRecords(req, table, { filters: [[ENTITIES[table].id, id]], limit: 1 });
  return { source, record: records[0] || null };
};

// Where can a write that references this record go?
//   'cloud' -> it exists in Neon
//   'local' -> it exists only in the local cache (created offline, not synced yet, or Neon is down)
//   null    -> it does not exist
// A local row that is already 'synced' but missing from a reachable Neon was deleted there.
const locateRecord = async (req, table, id) => {
  const idCol = ENTITIES[table].id;
  try {
    const { rowCount } = await req.pgPool.query(`SELECT 1 FROM ${table} WHERE ${idCol} = $1`, [id]);
    if (rowCount > 0) return { location: 'cloud', cloudReachable: true };
    const local = await sqliteGet(req.localDb, `SELECT sync_status FROM ${table} WHERE ${idCol} = ?`, [id]);
    return { location: local && local.sync_status === 'pending_insert' ? 'local' : null, cloudReachable: true };
  } catch (err) {
    if (!isConnectionError(err)) throw err;
    const local = await sqliteGet(req.localDb, `SELECT 1 AS ok FROM ${table} WHERE ${idCol} = ?`, [id]);
    return { location: local ? 'local' : null, cloudReachable: false };
  }
};

// user_id -> username, for showing who did something (e.g. who received a payment).
// Cloud first; the local copy of the accounts (pull-synced) when the cloud is unreachable.
// Never returns password hashes or roles.
const userNames = async (req, ids) => {
  const wanted = [...new Set(ids.filter(Boolean))];
  if (wanted.length === 0) return new Map();
  try {
    const { rows } = await req.pgPool.query('SELECT user_id, username FROM users WHERE user_id = ANY($1::text[])', [wanted]);
    return new Map(rows.map((r) => [r.user_id, r.username]));
  } catch (err) {
    if (!isConnectionError(err)) throw err;
    const rows = await sqliteAll(req.localDb,
      `SELECT user_id, username FROM users WHERE user_id IN (${wanted.map(() => '?').join(', ')})`, wanted);
    return new Map(rows.map((r) => [r.user_id, r.username]));
  }
};

const readLocal = async (db, table, id) =>
  serialize(table, await sqliteGet(db, `SELECT ${selectList(table, 'sqlite')} FROM ${table} WHERE ${ENTITIES[table].id} = ?`, [id]));

// ---------- Transactions ----------

// Postgres: runs fn(client) inside BEGIN/COMMIT on ONE pooled client.
// If the connection drops before COMMIT is sent, Neon rolls back and the error is rethrown
// (callers may safely fall back offline). If it drops DURING commit the outcome is unknown,
// so the error is tagged commitUnknown and callers must NOT retry offline.
const withPgTransaction = async (pgPool, fn) => {
  const client = await pgPool.connect();
  let broken = null;
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    try {
      await client.query('COMMIT');
    } catch (commitErr) {
      broken = commitErr;
      if (isConnectionError(commitErr)) commitErr.commitUnknown = true;
      throw commitErr;
    }
    return result;
  } catch (err) {
    if (!broken) {
      await client.query('ROLLBACK').catch((rbErr) => { broken = rbErr; });
      if (isConnectionError(err)) broken = err;
    }
    throw err;
  } finally {
    client.release(broken || undefined); // discard clients whose connection broke
  }
};

// SQLite: the server shares ONE connection across all requests, so BEGIN/COMMIT on it could
// swallow other requests' statements into this transaction. Instead, open a short-lived
// dedicated connection. BEGIN IMMEDIATE takes the write lock up front; the main connection
// waits (busyTimeout) instead of interleaving.
// PB 26: transactions of THIS server on the same file run one after the other (an in-process
// queue). Without it, a burst of offline writes (100+ at once) had every request open its own
// connection and race for SQLite's single write lock; past busyTimeout the losers failed with
// SQLITE_BUSY. Each transaction is a few milliseconds, so queueing is far faster than racing.
// Never call withLocalTransaction from inside another one (it would wait for itself).
const localQueues = new Map(); // dbPath -> promise of the last queued transaction
const withLocalTransaction = (dbPath, fn) => {
  const previous = localQueues.get(dbPath) || Promise.resolve();
  const run = previous.then(() => runLocalTransaction(dbPath, fn));
  const settled = run.then(() => {}, () => {});
  localQueues.set(dbPath, settled);
  settled.then(() => { if (localQueues.get(dbPath) === settled) localQueues.delete(dbPath); });
  return run;
};

const runLocalTransaction = (dbPath, fn) =>
  new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath, async (openErr) => {
      if (openErr) return reject(openErr);
      db.configure('busyTimeout', 5000);
      let began = false;
      try {
        await sqliteRun(db, 'PRAGMA foreign_keys = ON');
        await sqliteRun(db, 'BEGIN IMMEDIATE');
        began = true;
        const result = await fn(db);
        await sqliteRun(db, 'COMMIT');
        resolve(result);
      } catch (err) {
        if (began) await sqliteRun(db, 'ROLLBACK').catch(() => {});
        reject(err);
      } finally {
        db.close();
      }
    });
  });

module.exports = {
  ENTITIES,
  ACTIVE_ITEM_SQL,
  BIN_ITEM_SQL,
  countRecords,
  selectList,
  serialize,
  listRecords,
  getRecord,
  locateRecord,
  readLocal,
  userNames,
  withPgTransaction,
  withLocalTransaction,
  sqliteAll,
  sqliteGet,
  sqliteRun
};
