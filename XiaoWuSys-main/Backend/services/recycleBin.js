// ==========================================
// RECYCLE BIN: permanent delete + automatic clean-up
//
// Deleting from the Catalog only sets deleted_at (soft delete, restorable). Items leave the
// bin permanently only from here, always in BOUNDED batches so a huge bin never locks the
// table or slows the website:
//   - one transaction per batch of BATCH_SIZE rows, rows locked in a fixed order
//   - "Empty Recycle Bin" handles at most MAX_BATCHES_PER_REQUEST batches per call and
//     reports what is left (the UI simply calls again)
//   - a background janitor purges items older than RETENTION_DAYS, a few batches per run
//
// Every purged item gets a 'purged' audit row holding its full snapshot (the backup).
// Rows that past orders / material losses still reference are ARCHIVED (purged_at set,
// hidden everywhere) instead of deleted, so order history never breaks.
// Permanent delete is cloud-only: an offline purge could not be undone or replicated safely.
// ==========================================
const { selectList, serialize, withPgTransaction, sqliteRun, BIN_ITEM_SQL } = require('./records');
const { snapshotOf, auditCloudBulk } = require('./inventoryAudit');
const { isConnectionError } = require('../utils/dbErrors');
const { LOCAL_NOW } = require('../utils/localSync');

const BATCH_SIZE = 100;
const MAX_BATCHES_PER_REQUEST = 10;
const RETENTION_DAYS = Math.max(1, Number(process.env.RECYCLE_BIN_RETENTION_DAYS) || 30);
const JANITOR_INTERVAL_MS = 6 * 60 * 60 * 1000; // every 6 hours
const JANITOR_MAX_BATCHES = 5;

// Purges the given bin items inside an open transaction. Ignores IDs that are not in the bin.
// -> { purged: [{ inventory_id, item_name, mode: 'deleted' | 'archived' }] }
const purgeInCloud = async (client, ids, actor) => {
  if (ids.length === 0) return { purged: [] };
  const { rows } = await client.query(
    `SELECT ${selectList('inventory_items', 'pg', 'i')},
            (EXISTS (SELECT 1 FROM order_items oi WHERE oi.inventory_id = i.inventory_id)
             OR EXISTS (SELECT 1 FROM material_loss ml WHERE ml.inventory_id = i.inventory_id)) AS referenced
       FROM inventory_items i
      WHERE i.inventory_id = ANY($1::text[]) AND i.deleted_at IS NOT NULL AND i.purged_at IS NULL
      ORDER BY i.inventory_id
      FOR UPDATE OF i`,
    [ids]
  );
  if (rows.length === 0) return { purged: [] };

  const toDelete = rows.filter((r) => !r.referenced).map((r) => r.inventory_id);
  const toArchive = rows.filter((r) => r.referenced).map((r) => r.inventory_id);

  await auditCloudBulk(client, actor, 'purged', rows.map((r) => ({
    inventory_id: r.inventory_id,
    item_name: r.item_name,
    details: { mode: r.referenced ? 'archived' : 'deleted', item: snapshotOf(serialize('inventory_items', r)) }
  })));
  if (toDelete.length) await client.query('DELETE FROM inventory_items WHERE inventory_id = ANY($1::text[])', [toDelete]);
  if (toArchive.length) await client.query('UPDATE inventory_items SET purged_at = NOW() WHERE inventory_id = ANY($1::text[])', [toArchive]);

  return {
    purged: rows.map((r) => ({ inventory_id: r.inventory_id, item_name: r.item_name, mode: r.referenced ? 'archived' : 'deleted' }))
  };
};

// Mirror a cloud purge into the local cache right away (best effort; sync would catch up)
const applyPurgeLocally = async (localDb, purged) => {
  const deleted = purged.filter((p) => p.mode === 'deleted').map((p) => p.inventory_id);
  const archived = purged.filter((p) => p.mode === 'archived').map((p) => p.inventory_id);
  try {
    if (deleted.length) {
      await sqliteRun(localDb,
        `DELETE FROM inventory_items WHERE inventory_id IN (SELECT value FROM json_each(?))
           AND NOT EXISTS (SELECT 1 FROM order_items oi WHERE oi.inventory_id = inventory_items.inventory_id)
           AND NOT EXISTS (SELECT 1 FROM material_loss ml WHERE ml.inventory_id = inventory_items.inventory_id)`,
        [JSON.stringify(deleted)]);
    }
    const leftover = [...archived, ...deleted];
    if (leftover.length) {
      await sqliteRun(localDb,
        `UPDATE inventory_items SET purged_at = ${LOCAL_NOW} WHERE inventory_id IN (SELECT value FROM json_each(?))`,
        [JSON.stringify(leftover)]);
    }
  } catch (err) {
    console.error('⚠️ Could not apply the purge to the local cache (next sync will):', err.message);
  }
};

// One bounded batch, oldest deletions first. olderThanDays limits it to expired items.
const purgeNextBatch = (pgPool, actor, { olderThanDays = null } = {}) =>
  withPgTransaction(pgPool, async (client) => {
    const { rows } = await client.query(
      `SELECT inventory_id FROM inventory_items
        WHERE ${BIN_ITEM_SQL}
          AND ($1::int IS NULL OR deleted_at < NOW() - make_interval(days => $1::int))
        ORDER BY deleted_at, inventory_id
        LIMIT ${BATCH_SIZE}`,
      [olderThanDays]
    );
    return purgeInCloud(client, rows.map((r) => r.inventory_id), actor);
  });

const countBin = async (pgPool, olderThanDays = null) => {
  const { rows } = await pgPool.query(
    `SELECT COUNT(*)::int AS n FROM inventory_items
      WHERE ${BIN_ITEM_SQL} AND ($1::int IS NULL OR deleted_at < NOW() - make_interval(days => $1::int))`,
    [olderThanDays]
  );
  return rows[0].n;
};

// Runs up to maxBatches batches. -> { purged: [...], remaining }
const purgeBatches = async ({ pgPool, localDb }, actor, { maxBatches = MAX_BATCHES_PER_REQUEST, olderThanDays = null } = {}) => {
  const purged = [];
  for (let i = 0; i < maxBatches; i++) {
    const batch = await purgeNextBatch(pgPool, actor, { olderThanDays });
    if (batch.purged.length === 0) break;
    purged.push(...batch.purged);
    await applyPurgeLocally(localDb, batch.purged);
    if (batch.purged.length < BATCH_SIZE) break;
  }
  return { purged, remaining: await countBin(pgPool, olderThanDays) };
};

// Background clean-up of expired bin items. Skips quietly while Neon is unreachable.
const startRecycleBinJanitor = ({ pgPool, localDb, inventoryEvents }) => {
  const actor = { user_id: 'system', role: 'System' };
  const runOnce = async () => {
    try {
      const { purged } = await purgeBatches({ pgPool, localDb }, actor,
        { maxBatches: JANITOR_MAX_BATCHES, olderThanDays: RETENTION_DAYS });
      if (purged.length > 0) {
        console.log(`🗑️  Recycle Bin: auto-purged ${purged.length} item(s) older than ${RETENTION_DAYS} days`);
        if (inventoryEvents) inventoryEvents.notifyChanged(purged.map((p) => p.inventory_id), 'recycle_bin_auto_purge');
      }
    } catch (err) {
      if (!isConnectionError(err)) console.error('⚠️ Recycle Bin clean-up failed:', err.message);
    }
  };
  const first = setTimeout(runOnce, 60 * 1000); // shortly after start-up
  const timer = setInterval(runOnce, JANITOR_INTERVAL_MS);
  first.unref?.();
  timer.unref?.();
  return { runOnce, stop: () => { clearTimeout(first); clearInterval(timer); } };
};

module.exports = {
  BATCH_SIZE,
  RETENTION_DAYS,
  purgeInCloud,
  applyPurgeLocally,
  purgeBatches,
  startRecycleBinJanitor
};
