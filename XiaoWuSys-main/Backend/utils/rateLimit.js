// ==========================================
// LOGIN BRUTE-FORCE PROTECTION (in memory, per server process)
// After MAX_FAILURES wrong passwords for the same username from the same address within
// WINDOW_MS, that pair is locked for LOCK_MS. A separate per-address cap stops one machine
// from guessing many usernames. A successful login clears the username's counter.
// No dependency needed; entries expire on their own, so memory stays bounded.
// ==========================================

const createLoginLimiter = ({
  maxFailures = Number(process.env.LOGIN_MAX_FAILURES) || 5,
  maxPerAddress = 30,
  windowMs = 15 * 60 * 1000,
  lockMs = 15 * 60 * 1000,
  now = () => Date.now()
} = {}) => {
  const failures = new Map(); // key -> { count, first, lockedUntil }
  const perAddress = new Map(); // ip -> { count, first }

  const prune = () => {
    const t = now();
    for (const [k, v] of failures) if (t - v.first > windowMs && (!v.lockedUntil || v.lockedUntil < t)) failures.delete(k);
    for (const [k, v] of perAddress) if (t - v.first > windowMs) perAddress.delete(k);
  };
  const timer = setInterval(prune, 60 * 1000);
  timer.unref?.();

  const keyOf = (ip, username) => `${ip}|${String(username || '').trim().toLowerCase()}`;

  // -> null if allowed, else { retryAfterSeconds }
  const check = (ip, username) => {
    const t = now();
    const entry = failures.get(keyOf(ip, username));
    if (entry && entry.lockedUntil && entry.lockedUntil > t) {
      return { retryAfterSeconds: Math.ceil((entry.lockedUntil - t) / 1000) };
    }
    const addr = perAddress.get(ip);
    if (addr && t - addr.first <= windowMs && addr.count >= maxPerAddress) {
      return { retryAfterSeconds: Math.ceil((addr.first + windowMs - t) / 1000) };
    }
    return null;
  };

  const recordFailure = (ip, username) => {
    const t = now();
    const key = keyOf(ip, username);
    let entry = failures.get(key);
    if (!entry || t - entry.first > windowMs) entry = { count: 0, first: t, lockedUntil: 0 };
    entry.count += 1;
    if (entry.count >= maxFailures) entry.lockedUntil = t + lockMs;
    failures.set(key, entry);

    let addr = perAddress.get(ip);
    if (!addr || t - addr.first > windowMs) addr = { count: 0, first: t };
    addr.count += 1;
    perAddress.set(ip, addr);
    return { remaining: Math.max(0, maxFailures - entry.count), locked: entry.count >= maxFailures };
  };

  const recordSuccess = (ip, username) => failures.delete(keyOf(ip, username));
  const stop = () => clearInterval(timer);

  return { check, recordFailure, recordSuccess, stop };
};

module.exports = { createLoginLimiter };
