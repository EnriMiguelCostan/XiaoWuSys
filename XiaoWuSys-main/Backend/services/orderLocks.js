// ==========================================
// ORDER EDIT LOCKS - "OWNER PREVAILS" (Audit fix H2)
// Server-side source of truth for who is editing which order.
//  - Identity and role come from the verified JWT, never from the client payload.
//  - A higher-ranked role may take over a lock held by a lower-ranked role.
//  - Locks expire after LOCK_TTL_MS unless the holder renews them (heartbeat).
//  - REST write routes call assertCanEdit() and return 409 when blocked.
// Scope: in-memory, per backend process. Cross-branch conflicts are caught by the
// optimistic version checks (C3) in the routes and in services/sync.js.
// ==========================================

const ROLE_RANK = { Owner: 4, Admin: 3, Production: 2, Staff: 1 };
const LOCK_TTL_MS = 2 * 60 * 1000;

const rankOf = (role) => ROLE_RANK[role] || 0;

const createOrderLockManager = ({ ttlMs = LOCK_TTL_MS, now = () => Date.now() } = {}) => {
  const locks = new Map(); // orderId -> { orderId, userId, role, socketId, acquiredAt, expiresAt }

  const active = (orderId) => {
    const lock = locks.get(orderId);
    if (lock && lock.expiresAt <= now()) {
      locks.delete(orderId);
      return null;
    }
    return lock || null;
  };

  const publicView = (lock) =>
    lock && {
      orderId: lock.orderId,
      userId: lock.userId,
      role: lock.role,
      expiresAt: new Date(lock.expiresAt).toISOString()
    };

  // Returns { granted, lock, previous?, reason? }
  const acquire = (orderId, user, socketId) => {
    const current = active(orderId);
    const fresh = {
      orderId,
      userId: user.user_id,
      role: user.role,
      socketId,
      acquiredAt: now(),
      expiresAt: now() + ttlMs
    };

    if (!current || current.userId === user.user_id) {
      if (current) fresh.acquiredAt = current.acquiredAt; // renewal keeps original start
      locks.set(orderId, fresh);
      return { granted: true, lock: fresh };
    }

    if (rankOf(user.role) > rankOf(current.role)) {
      locks.set(orderId, fresh);
      return { granted: true, lock: fresh, previous: current };
    }

    return { granted: false, lock: current, reason: `Order is being edited by a ${current.role} user.` };
  };

  const release = (orderId, userId) => {
    const current = active(orderId);
    if (current && current.userId === userId) {
      locks.delete(orderId);
      return true;
    }
    return false;
  };

  // Frees every lock held by a disconnected socket; returns released order IDs
  const releaseBySocket = (socketId) => {
    const released = [];
    for (const [orderId, lock] of locks) {
      if (lock.socketId === socketId) {
        locks.delete(orderId);
        released.push(orderId);
      }
    }
    return released;
  };

  // REST guard: null if the user may write, otherwise a 409 payload
  const assertCanEdit = (orderId, user) => {
    const current = active(orderId);
    if (!current || current.userId === user.user_id) return null;
    if (rankOf(user.role) > rankOf(current.role)) return null; // Owner prevails
    return {
      error: 'ORDER_LOCKED',
      message: `This order is currently being edited by a ${current.role} user. Try again when they finish.`,
      lock: publicView(current)
    };
  };

  const snapshot = () => {
    const out = [];
    for (const orderId of [...locks.keys()]) {
      const lock = active(orderId);
      if (lock) out.push(publicView(lock));
    }
    return out;
  };

  return { acquire, release, releaseBySocket, assertCanEdit, snapshot, publicView };
};

module.exports = { createOrderLockManager, ROLE_RANK, LOCK_TTL_MS };
