// PB 3 / PB 4: the connection watcher. It learns from the queries the server already makes,
// never checks the cloud while it is reachable (so Neon can sleep when the shop is idle),
// checks every few seconds only while it is unreachable, and starts ONE sync when it is back.
// probeMs is shortened to 20 ms so the test runs quickly; the server uses 15 s.
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { createCloudHealth, watchPool } = require('../services/cloudHealth');

const PROBE_MS = 20;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const quiet = { log: () => {}, warn: () => {}, error: () => {} };

// A pretend cloud: "up" answers every query, "down" refuses the connection
const createFakePool = () => {
  const pool = {
    up: true,
    calls: [],
    query: async (sql) => {
      pool.calls.push(sql);
      if (!pool.up) throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
      if (sql === 'BAD') throw Object.assign(new Error('duplicate key'), { code: '23505' });
      return { rows: [{ ok: 1 }], rowCount: 1 };
    },
    connect: async () => {
      if (!pool.up) throw Object.assign(new Error('timeout exceeded when trying to connect'), {});
      return { query: pool.query, release: () => { pool.released = (pool.released || 0) + 1; } };
    },
    on() { return this; }
  };
  return pool;
};

describe('Cloud health watcher', () => {
  let pool;
  let health;
  let watched;
  let changes;
  let reconnects;

  beforeEach(() => {
    pool = createFakePool();
    changes = [];
    reconnects = 0;
    health = createCloudHealth({
      pgPool: pool, probeMs: PROBE_MS, log: quiet,
      onChange: (next, previous) => changes.push(`${previous}->${next}`),
      onReconnect: () => { reconnects += 1; }
    });
    watched = watchPool(pool, health);
  });
  afterEach(() => health.stop());

  it('learns the state from normal queries, and never probes while the cloud is reachable', async () => {
    assert.equal(health.state(), 'unknown');
    const r = await watched.query('SELECT NOW()');
    assert.deepEqual(r.rows, [{ ok: 1 }], 'results pass through unchanged');
    assert.equal(health.state(), 'reachable');
    await wait(PROBE_MS * 5);
    assert.deepEqual(pool.calls, ['SELECT NOW()'], 'no extra queries while online');
    assert.equal(health.probeCount(), 0);
  });

  it('ignores data errors: only a connection error means the cloud is unreachable', async () => {
    await watched.query('SELECT 1');
    await assert.rejects(watched.query('BAD'), { code: '23505' });
    assert.equal(health.state(), 'reachable');
  });

  it('probes every few seconds only while unreachable, and syncs exactly once when the cloud is back', async () => {
    await watched.query('SELECT 1');
    pool.up = false;
    await assert.rejects(watched.query('SELECT * FROM orders'), { code: 'ECONNREFUSED' }, 'the error still reaches the route');
    assert.equal(health.state(), 'unreachable');
    await wait(PROBE_MS * 5.5);
    const probes = health.probeCount();
    assert.ok(probes >= 2 && probes <= 8, `about one probe per ${PROBE_MS} ms (got ${probes})`);
    assert.ok(pool.calls.slice(2).every((sql) => sql === 'SELECT 1'), 'a probe is only SELECT 1');
    assert.equal(reconnects, 0);

    pool.up = true;
    await wait(PROBE_MS * 3);
    assert.equal(health.state(), 'reachable');
    await watched.query('SELECT 2'); // more successes do not start more syncs
    await watched.query('SELECT 3');
    assert.equal(reconnects, 1, 'one sync on reconnect');
    assert.deepEqual(changes, ['unknown->reachable', 'reachable->unreachable', 'unreachable->reachable']);

    const afterBack = health.probeCount();
    await wait(PROBE_MS * 4);
    assert.equal(health.probeCount(), afterBack, 'probing stops once the cloud is back');
  });

  it('also watches transactions (connect) and the callback style the server uses at start-up', async () => {
    pool.up = false;
    await assert.rejects(watched.connect());
    assert.equal(health.state(), 'unreachable');
    pool.up = true;
    const client = await watched.connect();
    assert.equal(health.state(), 'reachable');
    await client.query('BEGIN');
    client.release();
    assert.equal(pool.released, 1, 'release goes to the real client');

    const err = await new Promise((resolve) => watched.query('SELECT NOW()', (e) => resolve(e)));
    assert.equal(err, null);
  });

  it('stays "disabled" in offline-only mode', async () => {
    const off = createCloudHealth({ pgPool: pool, cloudDisabled: true, probeMs: PROBE_MS, log: quiet, onReconnect: () => { reconnects += 1; } });
    off.reportFailure(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }));
    off.reportSuccess();
    await wait(PROBE_MS * 2);
    assert.deepEqual([off.state(), off.probeCount(), reconnects], ['disabled', 0, 0]);
  });
});
