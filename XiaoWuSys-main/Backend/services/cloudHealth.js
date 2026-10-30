// ==========================================
// CLOUD HEALTH (PB 3 / PB 4): is the cloud database reachable right now?
//
//   state  'unknown'     until the first cloud query finishes
//          'reachable'   the last cloud query worked
//          'unreachable' the last cloud query failed with a CONNECTION error (C5). Data errors
//                        (bad values, constraints) say nothing about the connection and are ignored.
//          'disabled'    offline-only mode (CLOUD_DISABLED=true or no DATABASE_URL)
//
// Signals come from watchPool(): every query the server already makes reports its outcome,
// so the routes do not change. While reachable there is NO probing at all (D3), so Neon can
// still suspend when the shop is idle. Only while unreachable does it try "SELECT 1" every
// probeMs, and the first success flips it back to reachable. onChange(next, previous) is
// called on every change; onReconnect() once per unreachable -> reachable flip.
// ==========================================
const { isConnectionError } = require('../utils/dbErrors');

// onReconnect() runs exactly once per unreachable -> reachable flip (server.js: syncAndNotify).
const createCloudHealth = ({
  pgPool, cloudDisabled = false, probeMs = 15000, onChange = () => {}, onReconnect = () => {}, now = Date.now, log = console
}) => {
  let state = cloudDisabled ? 'disabled' : 'unknown';
  let since = now();
  let timer = null;
  let probing = false;
  let probes = 0;

  const stopProbing = () => {
    if (timer) clearInterval(timer);
    timer = null;
  };

  const probe = async () => {
    if (probing || state !== 'unreachable') return;
    probing = true;
    probes += 1;
    try {
      await pgPool.query('SELECT 1');
      reportSuccess(); // eslint-disable-line no-use-before-define
    } catch (err) {
      reportFailure(err); // eslint-disable-line no-use-before-define
    } finally {
      probing = false;
    }
  };

  const startProbing = () => {
    if (timer) return;
    timer = setInterval(() => { probe(); }, probeMs);
    if (typeof timer.unref === 'function') timer.unref(); // never keeps the process alive
  };

  const setState = (next) => {
    if (state === 'disabled' || state === next) return;
    const previous = state;
    state = next;
    since = now();
    if (next === 'unreachable') startProbing();
    else stopProbing();
    if (next === 'unreachable') log.warn('☁️  Cloud database unreachable: working on this computer until it is back.');
    if (next === 'reachable' && previous === 'unreachable') log.log('☁️  Cloud database reachable again.');
    const call = (fn, ...args) => {
      try {
        const r = fn(...args);
        if (r && typeof r.catch === 'function') r.catch((err) => log.error('⚠️ Cloud health listener failed:', err.message));
      } catch (err) {
        log.error('⚠️ Cloud health listener failed:', err.message);
      }
    };
    call(onChange, next, previous);
    if (next === 'reachable' && previous === 'unreachable') call(onReconnect);
  };

  const reportSuccess = () => setState('reachable');
  const reportFailure = (err) => { if (isConnectionError(err)) setState('unreachable'); };

  return {
    state: () => state,
    since: () => since,
    probeCount: () => probes,
    reportSuccess,
    reportFailure,
    probe,
    stop: stopProbing
  };
};

// Wraps a pg Pool so every query reports to cloudHealth. Everything else passes through
// unchanged (same results, same errors, same callback/promise styles).
// Clients from connect() are wrapped per checkout, so transaction queries report too.
const watchPool = (pool, health) => {
  const track = (promise) => promise.then(
    (result) => { health.reportSuccess(); return result; },
    (err) => { health.reportFailure(err); throw err; }
  );
  const passThrough = (target, prop) => {
    const value = target[prop];
    return typeof value === 'function' ? value.bind(target) : value;
  };
  // query(text, params?, callback?) in both styles, as pg supports
  const watchedQuery = (target) => (...args) => {
    const callback = typeof args[args.length - 1] === 'function' ? args.pop() : null;
    const promise = track(Promise.resolve().then(() => target.query(...args)));
    if (!callback) return promise;
    promise.then((r) => callback(null, r), (e) => callback(e));
    return undefined;
  };
  const watchClient = (client) => new Proxy(client, {
    get: (target, prop) => (prop === 'query' ? watchedQuery(target) : passThrough(target, prop))
  });

  return new Proxy(pool, {
    get: (target, prop) => {
      if (prop === 'query') return watchedQuery(target);
      if (prop === 'connect') {
        return (...args) => {
          if (typeof args[args.length - 1] === 'function') return target.connect(...args); // callback style: untouched
          return track(target.connect(...args)).then(watchClient);
        };
      }
      return passThrough(target, prop);
    }
  });
};

module.exports = { createCloudHealth, watchPool };
