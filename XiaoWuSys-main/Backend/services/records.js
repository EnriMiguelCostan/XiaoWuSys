// ==========================================
// RECORD ACCESS LAYER (Audit fixes M7 existence checks, M9 transactions, M10 read shapes)
//
// One definition per entity drives the SELECT list for BOTH databases, and one serializer
// turns rows from either into the SAME JSON shape:
//   money      -> number (2 dp)          Postgres NUMERIC comes back as a string otherwise
//   timestamp  -> 'YYYY-MM-DDTHH:MM:SS'  Postgres Date objects vs SQLite text otherwise
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
      production_status: 'text', design_drive_link: 'text', total_quote_amount: 'money'
    }
  },
  order_items: {
    id: 'line_item_id',
    fields: {
      line_item_id: 'text', order_id: 'text', inventory_id: 'text', product_type: 'text', quantity: 'int',
      size: 'text', custom_name: 'text', custom_number: 'text', price: 'money'
    }
  },
  payments: {
    id: 'payment_id',
    fields: { payment_id: 'text', order_id: 'text', amount: 'money', payment_date: 'timestamp', payment_type: 'text' }
  },
  material_loss: {
    id: 'loss_id',
    fields: {
      loss_id: 'text', order_id: 'text', inventory_id: 'text', quantity_lost: 'int', loss_reason: 'text',
      date_recorded: 'timestamp', financial_cost: 'money'
    }
  },
  inventory_items: {
    id: 'inventory_id',
    fields: {
      inventory_id: 'text', item_name: 'text', item_category: 'text', quantity_available: 'int',
      quantity_reserved: 'int', minimum_threshold: 'int', unit_cost: 'money'
    }
  },
  customers: {
    id: 'customer_id',
    fields: { customer_id: 'text', full_name: 'text', contact_number: 'text', platform_source: 'text' }
  }
};

// ---------- SELECT lists ----------
const columnExpr = (dialect, alias, col, type) => {
  const ref = alias ? `${alias}.${col}` : col;
  if (type === 'timestamp') {
    return dialect === 'pg'
      ? `to_char(${ref}, 'YYYY-MM-DD"T"HH24:MI:SS') AS ${col}`
      : `strftime('%Y-%m-%dT%H:%M:%S', ${ref}) AS ${col}`;
  }
  if (type === 'money' && dialect === 'pg') return `${ref}::text AS ${col}`;
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
    if (v === undefined || v === null) out[col] = null;
    else if (type === 'money') out[col] = Math.round(Number(v) * 100) / 100;
    else if (type === 'int') out[col] = Number(v);
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
const buildWhere = (filters, dialect) => {
  const params = [];
  const clauses = filters
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([col, value]) => {
      params.push(value);
      return `${col} = ${dialect === 'pg' ? `$${params.length}` : '?'}`;
    });
  return { sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
};

// Lists rows. Online results also include matching local rows that were created offline and
// are not in Neon yet, so a record never "disappears" between creation and the next sync.
const listRecords = async (req, table, { filters = [], orderBy, limit = 1000, offset = 0 } = {}) => {
  const spec = ENTITIES[table];
  const order = orderBy || spec.id;
  try {
    const where = buildWhere(filters, 'pg');
    const { rows } = await req.pgPool.query(
      `SELECT ${selectList(table, 'pg')} FROM ${table} ${where.sql}
        ORDER BY ${order} LIMIT ${Number(limit)} OFFSET ${Number(offset)}`,
      where.params
    );
    const records = rows.map((r) => serialize(table, r));

    let unsynced = [];
    try {
      const local = buildWhere([...filters, ['sync_status', 'pending_insert']], 'sqlite');
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
    const where = buildWhere(filters, 'sqlite');
    const rows = await sqliteAll(
      req.localDb,
      `SELECT ${selectList(table, 'sqlite')} FROM ${table} ${where.sql}
        ORDER BY ${order} LIMIT ${Number(limit)} OFFSET ${Number(offset)}`,
      where.params
    );
    return { source: 'local', records: rows.map((r) => serialize(table, r)), unsynced: 0 };
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
const withLocalTransaction = (dbPath, fn) =>
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
  selectList,
  serialize,
  listRecords,
  getRecord,
  locateRecord,
  readLocal,
  withPgTransaction,
  withLocalTransaction,
  sqliteAll,
  sqliteGet,
  sqliteRun
};
