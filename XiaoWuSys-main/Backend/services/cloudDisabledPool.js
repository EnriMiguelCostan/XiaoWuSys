// ==========================================
// OFFLINE-ONLY MODE (CLOUD_DISABLED=true, or no DATABASE_URL)
// A stand-in for the pg Pool that always answers "cloud unreachable". Every route then takes
// its normal offline path (SQLite), exactly as during an internet outage. Used by the
// automated tests and by `npm run demo`, so the system can run with no Neon account at all.
// ==========================================
const unreachable = () => Object.assign(new Error('connect ECONNREFUSED (cloud disabled: offline-only mode)'), { code: 'ECONNREFUSED' });

const createCloudDisabledPool = () => ({
  offlineOnly: true,
  query(text, params, cb) {
    const callback = typeof params === 'function' ? params : cb;
    if (callback) { setImmediate(() => callback(unreachable())); return undefined; }
    return Promise.reject(unreachable());
  },
  connect() { return Promise.reject(unreachable()); },
  on() { return this; },
  end() { return Promise.resolve(); }
});

module.exports = { createCloudDisabledPool };
