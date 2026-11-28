// Egress fix (November 2026): the offline cache is refreshed incrementally, the background sync
// waits while nothing is pending, live stock pushes carry only the changed items, and Neon's
// "quota exceeded" refusal counts as the cloud being unreachable. Runs without PostgreSQL: the
// cloud is a small scripted stand-in that answers the refresh queries for inventory_items.
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { prepareDatabase } = require('./helpers/testServer');
const { SYNC_TABLES, _internals } = require('../services/sync');
const { sqliteRun, sqliteGet, sqliteAll, listRecords } = require('../services/records');
const { isConnectionError, isQuotaExceededError } = require('../utils/dbErrors');
const { shouldRunScheduledSync } = require('../services/syncSchedule');
const { withAvailability, buildInventoryDelta, applyInventoryDelta } = require('../services/inventorySnapshot');

const { refreshLocalCache, cloudKeyOf } = _internals;
const flat = (sql) => sql.replace(/\s+/g, ' ').trim();
const ITEM_COLUMNS = SYNC_TABLES.find((t) => t.table === 'inventory_items').columns;

// A cloud with one table (inventory_items). Every other table answers nothing, as an empty table.
const createInventoryCloud = (key = 'ep-demo.ap-southeast-1.aws.neon.tech/neondb') => {
  const items = new Map();
  const log = [];
  let tick = 0;
  const nextVersion = () => `2026-11-27T08:${String(10 + Math.floor(tick / 60)).padStart(2, '0')}:${String(tick++ % 60).padStart(2, '0')}.000000`;
  const asRow = (item) => ({ ...Object.fromEntries(ITEM_COLUMNS.map((c) => [c, item[c] ?? null])), version: item.version });
  const cloud = {
    items, log,
    options: { connectionString: `postgresql://owner:secret@${key.split('/')[0]}/${key.split('/')[1]}?sslmode=require` },
    put: (id, fields = {}) => items.set(id, {
      inventory_id: id, item_name: `Item ${id}`, item_category: 'Blanks', quantity_available: '10', quantity_reserved: '0',
      minimum_threshold: '2', unit_cost: '100.00', unit: 'pcs', selling_price: '150.00', has_sizes: 'false',
      requires_pressing: 'false', print_pricing: 'false', ...(items.get(id) || {}), ...fields, version: nextVersion()
    }),
    query: async (sql, params = []) => {
      const q = flat(sql);
      log.push(q);
      if (/^SELECT COUNT\(\*\)::int AS cloud_rows, .* FROM inventory_items$/.test(q)) {
        const versions = [...items.values()].map((i) => i.version).sort();
        return { rows: [{ cloud_rows: items.size, max_version: versions.length ? versions[versions.length - 1] : null }] };
      }
      if (/ FROM inventory_items WHERE last_modified >= \(\$1::timestamp - interval '5 minutes'\)$/.test(q)) {
        const at = (v) => Date.parse(`${String(v).slice(0, 23)}Z`);
        const since = at(params[0]) - 5 * 60 * 1000;
        const rows = [...items.values()].filter((i) => at(i.version) >= since).map(asRow);
        return { rows, rowCount: rows.length };
      }
      if (/^SELECT .* FROM inventory_items$/.test(q) && q.includes('AS version')) {
        const rows = [...items.values()].map(asRow);
        return { rows, rowCount: rows.length };
      }
      if (q === 'SELECT inventory_id FROM inventory_items') return { rows: [...items.keys()].map((inventory_id) => ({ inventory_id })) };
      return { rows: [], rowCount: 0 }; // every other table: empty
    }
  };
  return cloud;
};

const fullReads = (cloud) => cloud.log.filter((q) => /^SELECT .* FROM inventory_items$/.test(q) && q.includes('AS version')).length;
const changeReads = (cloud) => cloud.log.filter((q) => q.includes('FROM inventory_items WHERE last_modified >=')).length;

describe('Egress fix: the offline cache is refreshed incrementally', () => {
  let dir;
  let db;
  let cloud;
  const refresh = async () => {
    const summary = { inventory_changed: false };
    await refreshLocalCache(cloud, db, summary);
    return summary;
  };
  const localItem = (id) => sqliteGet(db, 'SELECT item_name, quantity_available, sync_status FROM inventory_items WHERE inventory_id = ?', [id]);

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaowusys-egress-'));
  });
  beforeEach(async () => {
    if (db) await new Promise((r) => db.close(r));
    db = await prepareDatabase(path.join(dir, `cache-${Date.now()}-${Math.random()}.db`));
    cloud = createInventoryCloud();
    cloud.put('inv-1');
    cloud.put('inv-2');
    cloud.put('inv-3');
  });
  after(async () => {
    if (db) await new Promise((r) => db.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reads every row once, then nothing at all while the cloud has not changed', async () => {
    const first = await refresh();
    assert.equal(fullReads(cloud), 1, 'the first refresh reads the table in full');
    assert.equal(first.inventory_changed, true);
    assert.equal((await localItem('inv-2')).item_name, 'Item inv-2');

    cloud.log.length = 0;
    const second = await refresh();
    assert.deepEqual([fullReads(cloud), changeReads(cloud)], [0, 0], 'no rows are read when nothing changed');
    assert.equal(second.inventory_changed, false);
    assert.ok(cloud.log.some((q) => q.includes('AS cloud_rows')), 'only the small row-count question is asked');
  });

  it('reads only the rows changed since the last refresh', async () => {
    await refresh();
    cloud.log.length = 0;
    cloud.put('inv-2', { quantity_available: '4', item_name: 'Jersey (Large)' });
    const summary = await refresh();
    assert.deepEqual([fullReads(cloud), changeReads(cloud)], [0, 1]);
    assert.deepEqual(await localItem('inv-2'), { item_name: 'Jersey (Large)', quantity_available: 4, sync_status: 'synced' });
    assert.equal(summary.inventory_changed, true);

    cloud.put('inv-4', { item_name: 'Mug' }); // added on another branch: new rows come with the changes
    cloud.log.length = 0;
    await refresh();
    assert.deepEqual([fullReads(cloud), changeReads(cloud)], [0, 1]);
    assert.equal((await localItem('inv-4')).item_name, 'Mug');
  });

  it('notices a row deleted in the cloud and reads the table in full to remove it', async () => {
    await refresh();
    cloud.items.delete('inv-3'); // a permanent delete leaves no last_modified behind
    cloud.log.length = 0;
    const summary = await refresh();
    assert.equal(fullReads(cloud), 1, 'the row count no longer matches: read in full');
    assert.equal(await localItem('inv-3'), undefined, 'and the deleted item leaves the cache');
    assert.equal(summary.inventory_changed, true);

    cloud.log.length = 0;
    await refresh();
    assert.equal(fullReads(cloud), 0, 'once the counts agree again, no more full reads');
  });

  it('keeps rows saved offline out of the count, so they never cause a full read', async () => {
    await refresh();
    await sqliteRun(db, `INSERT INTO inventory_items (inventory_id, item_name, item_category, quantity_available, quantity_reserved,
                           minimum_threshold, unit_cost, sync_status) VALUES ('inv-offline', 'Tarp', 'Blanks', 3, 0, 1, 50, 'pending_insert')`);
    cloud.log.length = 0;
    await refresh();
    assert.deepEqual([fullReads(cloud), changeReads(cloud)], [0, 0]);
  });

  it('starts again with a full read for another cloud database, or after the daily backstop', async () => {
    await refresh();
    const other = createInventoryCloud('ep-other.ap-southeast-1.aws.neon.tech/neondb');
    for (const [id, item] of cloud.items) other.items.set(id, { ...item });
    const previous = cloud;
    cloud = other;
    await refresh();
    assert.equal(fullReads(other), 1, 'a watermark from one project is never used on another');

    cloud = previous;
    await refresh(); // back to the first project: full again (the watermark now belongs to "other")
    previous.log.length = 0;
    await sqliteRun(db, "UPDATE cache_watermarks SET full_at = 0 WHERE table_name = 'inventory_items'");
    await refresh();
    assert.equal(fullReads(previous), 1, 'older than FULL_REFRESH_MS: read in full as a backstop');
  });

  it('falls back to the old full refresh when the cloud cannot report its size', async () => {
    const silent = { query: async (sql) => {
      const q = flat(sql);
      if (q.includes('AS cloud_rows')) return { rows: [] };
      if (/^SELECT .* FROM inventory_items$/.test(q)) return { rows: [] };
      return { rows: [] };
    } };
    cloud = silent;
    await refresh();
    const [mark] = await sqliteAll(db, "SELECT * FROM cache_watermarks WHERE table_name = 'inventory_items'");
    assert.equal(mark, undefined, 'no watermark is kept without a row count');
  });

  it('names the cloud by host and database only, never the password', () => {
    assert.equal(cloudKeyOf(createInventoryCloud()), 'ep-demo.ap-southeast-1.aws.neon.tech/neondb');
    assert.equal(cloudKeyOf({ query: async () => ({ rows: [] }) }), '');
  });
});

describe('Egress fix: the background sync waits while there is nothing to do', () => {
  const now = Date.parse('2026-11-27T02:00:00Z');
  const minutesAgo = (m) => new Date(now - m * 60 * 1000).toISOString();

  it('syncs at once when work is waiting or the live link is down', () => {
    assert.deepEqual(shouldRunScheduledSync({ pendingCount: 2, listening: true, lastSyncAt: minutesAgo(1), now }), { run: true, reason: 'pending' });
    assert.deepEqual(shouldRunScheduledSync({ pendingCount: 0, listening: false, lastSyncAt: minutesAgo(1), now }), { run: true, reason: 'no_live_link' });
    assert.equal(shouldRunScheduledSync({ pendingCount: 0, listening: true, lastSyncAt: null, now }).run, true);
  });

  it('skips while idle and live, and catches up every 30 minutes', () => {
    assert.deepEqual(shouldRunScheduledSync({ pendingCount: 0, listening: true, lastSyncAt: minutesAgo(10), now, idleMs: 30 * 60 * 1000 }),
      { run: false, reason: 'up_to_date' });
    assert.deepEqual(shouldRunScheduledSync({ pendingCount: 0, listening: true, lastSyncAt: minutesAgo(31), now, idleMs: 30 * 60 * 1000 }),
      { run: true, reason: 'idle_interval' });
  });
});

describe('Egress fix: a used-up Neon quota counts as the cloud being unreachable', () => {
  const quotaError = (message) => Object.assign(new Error(message), { code: 'XX000', severity: 'ERROR' });

  it('falls back offline for the data transfer and compute time quotas', () => {
    const transfer = quotaError('Your project has exceeded the data transfer quota. Upgrade your plan to increase limits.');
    const compute = quotaError('Your account or project has exceeded the compute time quota. Upgrade your plan to increase limits.');
    assert.equal(isQuotaExceededError(transfer), true);
    assert.equal(isConnectionError(transfer), true);
    assert.equal(isConnectionError(compute), true);
    assert.equal(isConnectionError(Object.assign(new Error(transfer.message), { name: 'NeonDbError' })), true, 'also without a code');
  });

  it('does not fall back for the storage quota or ordinary errors', () => {
    assert.equal(isConnectionError(quotaError('Your project has exceeded the logical size quota.')), false, 'reads still work there');
    assert.equal(isConnectionError(quotaError('internal error')), false);
    assert.equal(isConnectionError(Object.assign(new Error('duplicate key'), { code: '23505' })), false);
  });
});

describe('Egress fix: live stock pushes carry only the changed items', () => {
  let dir;
  let db;
  const item = (id, name, qty, extra = {}) => withAvailability({
    inventory_id: id, item_name: name, item_category: 'Blanks', quantity_available: qty, quantity_reserved: 0,
    minimum_threshold: 2, unit_cost: 100, sync_status: 'synced', ...extra
  });

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaowusys-delta-'));
    db = await prepareDatabase(path.join(dir, 'cache.db'));
    for (const [id, name, qty, deleted] of [['inv-a', 'Apron', 5, null], ['inv-b', 'Banner', 1, null], ['inv-c', 'Cap', 4, '2026-11-20T00:00:00']]) {
      await sqliteRun(db, `INSERT INTO inventory_items (inventory_id, item_name, item_category, quantity_available, quantity_reserved,
                             minimum_threshold, unit_cost, deleted_at, sync_status) VALUES (?, ?, 'Blanks', ?, 0, 2, 100, ?, 'synced')`,
      [id, name, qty, deleted]);
    }
  });
  after(async () => {
    await new Promise((r) => db.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reads only the asked-for items from the cloud', async () => {
    const queries = [];
    const pgPool = { query: async (sql, params) => { queries.push({ sql: flat(sql), params }); return { rows: [] }; } };
    await buildInventoryDelta({ pgPool, localDb: db }, ['inv-a', 'inv-a', 'inv-b']);
    assert.match(queries[0].sql, /WHERE inventory_id = ANY\(\$1::text\[\]\) AND \(deleted_at IS NULL AND purged_at IS NULL\)/);
    assert.deepEqual(queries[0].params, [['inv-a', 'inv-b']]);
  });

  it('works from the local cache offline, and reports items that left the catalog', async () => {
    const offline = { query: async () => { throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }); } };
    const delta = await buildInventoryDelta({ pgPool: offline, localDb: db }, ['inv-b', 'inv-c', 'inv-gone']);
    assert.equal(delta.source, 'local');
    assert.deepEqual(delta.items.map((i) => i.inventory_id), ['inv-b']);
    assert.deepEqual(delta.removed_ids, ['inv-c', 'inv-gone'], 'in the Recycle Bin or deleted');
  });

  it('merges a delta into the last full snapshot and recomputes the summary', () => {
    const snapshot = { source: 'cloud', fetched_at: null, summary: { recycle_bin: 1 }, categories: ['Blanks'],
      items: [item('inv-a', 'Apron', 5), item('inv-b', 'Banner', 1)] };
    const next = applyInventoryDelta(snapshot,
      { source: 'cloud', items: [item('inv-b', 'Banner', 9), item('inv-0', 'Aardvark tee', 0, { item_category: 'Shirts' })], removed_ids: ['inv-a'] },
      { recycleBin: 2 });
    assert.deepEqual(next.items.map((i) => [i.inventory_id, i.stock_status]), [['inv-0', 'out_of_stock'], ['inv-b', 'in_stock']]);
    assert.deepEqual([next.summary.total_items, next.summary.out_of_stock, next.summary.recycle_bin, next.summary.total_units], [2, 1, 2, 9]);
    assert.deepEqual(next.categories, ['Blanks', 'Shirts']);
    assert.equal(snapshot.items.length, 2, 'the old snapshot is left as it was');
  });

  it('accepts IN lists in record filters for both databases', async () => {
    const { records } = await listRecords({ pgPool: { query: async () => { throw Object.assign(new Error('x'), { code: 'ENOTFOUND' }); } }, localDb: db },
      'inventory_items', { filters: [['inventory_id', ['inv-a', 'inv-c'], 'IN']] });
    assert.deepEqual(records.map((r) => r.inventory_id).sort(), ['inv-a', 'inv-c']);
  });
});
