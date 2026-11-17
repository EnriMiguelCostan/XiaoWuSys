// Account management while ONLINE. The users table lives in the cloud, so this test gives the
// app a small in-memory stand-in for the users table (users only) and checks every rule:
// who may manage whom, sign-out on deactivate / reset / password change, offline caching.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const bcrypt = require('bcrypt');
const { prepareDatabase } = require('./helpers/testServer');
const { createApp } = require('../app');
const { createOrderLockManager } = require('../services/orderLocks');

const PASSWORD = 'XiaoMei2026';

// Answers exactly the SQL statements routes/auth.js sends for the users table
const createUsersCloud = (users, audit = []) => {
  const cutoffText = (ms) => new Date(Number(ms)).toISOString().replace('T', ' ').replace('Z', '');
  const copy = (u) => ({ ...u });
  const pool = {
    query: async (sql, p = []) => {
      const q = sql.replace(/\s+/g, ' ').trim();
      if (/^SELECT .* FROM users WHERE username = \$1/.test(q)) return { rows: [...users.values()].filter((u) => u.username === p[0]).map(copy) };
      if (/^SELECT .* FROM users WHERE user_id = \$1/.test(q)) return { rows: users.has(p[0]) ? [copy(users.get(p[0]))] : [] };
      // GET /users: the everyday list (not removed) or "Show removed" (removed only)
      if (/^SELECT .* FROM users WHERE removed_at IS NULL ORDER BY/.test(q)) return { rows: [...users.values()].filter((u) => !u.removed_at).map(copy) };
      if (/^SELECT .* FROM users WHERE removed_at IS NOT NULL ORDER BY/.test(q)) return { rows: [...users.values()].filter((u) => u.removed_at).map(copy) };
      // Remove / restore lock the one account
      if (/^SELECT .* FROM users WHERE user_id = \$1 FOR UPDATE$/.test(q)) return { rows: users.has(p[0]) ? [copy(users.get(p[0]))] : [] };
      if (q.startsWith('UPDATE users SET is_active = FALSE, removed_at = NOW()')) {
        Object.assign(users.get(p[0]), { is_active: false, removed_at: '2026-11-16 12:00:00', removed_by: p[1], tokens_valid_after: cutoffText(p[2]) });
        return { rows: [copy(users.get(p[0]))], rowCount: 1 };
      }
      if (q.startsWith('UPDATE users SET removed_at = NULL, removed_by = NULL')) {
        Object.assign(users.get(p[0]), { removed_at: null, removed_by: null });
        return { rows: [copy(users.get(p[0]))], rowCount: 1 };
      }
      if (q.startsWith('INSERT INTO audit_log')) {
        audit.push({ entity: p[1], entity_id: p[2], action: p[3], performed_by: p[5] });
        return { rows: [], rowCount: 1 };
      }
      if (q.startsWith('SELECT COUNT(*)::int AS n FROM users')) {
        return { rows: [{ n: [...users.values()].filter((u) => u.is_active && p[0].includes(u.role) && u.user_id !== p[1]).length }] };
      }
      if (q.startsWith('INSERT INTO users')) {
        if ([...users.values()].some((u) => u.username === p[1])) throw Object.assign(new Error('duplicate key'), { code: '23505' });
        const u = { user_id: p[0], username: p[1], password_hash: p[2], role: p[3], is_active: true, tokens_valid_after: null, created_at: '2026-10-27 00:00:00' };
        users.set(p[0], u);
        return { rows: [copy(u)] };
      }
      // PATCH /users/:id locks the target + every active manager (FOR UPDATE)
      if (/^SELECT .* FROM users WHERE user_id = \$1 OR \(is_active = TRUE AND role = ANY\(\$2::text\[\]\)\) ORDER BY user_id FOR UPDATE$/.test(q)) {
        return {
          rows: [...users.values()].filter((u) => u.user_id === p[0] || (u.is_active && p[1].includes(u.role)))
            .sort((a, b) => a.user_id.localeCompare(b.user_id)).map(copy)
        };
      }
      if (q.startsWith('UPDATE users SET role = $2, is_active = $3')) {
        // Same SQL guard as the route: removing a manager needs another active manager
        const [id, role, isActive, at, managerRoles] = p;
        const staysManager = isActive === true && (managerRoles || []).includes(role);
        const other = [...users.values()].some((u) => u.user_id !== id && u.is_active && (managerRoles || []).includes(u.role));
        if (!users.has(id) || (managerRoles && !staysManager && !other)) return { rows: [], rowCount: 0 };
        Object.assign(users.get(id), { role, is_active: isActive, tokens_valid_after: cutoffText(at) });
        return { rows: [copy(users.get(id))], rowCount: 1 };
      }
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(q)) return { rows: [] };
      if (q.startsWith('UPDATE users SET password_hash = $2')) {
        Object.assign(users.get(p[0]), { password_hash: p[1], tokens_valid_after: cutoffText(p[2]) });
        return { rows: [copy(users.get(p[0]))] };
      }
      throw new Error(`unexpected SQL in test: ${q.slice(0, 80)}`);
    },
    // withPgTransaction: one "client" that runs on the same in-memory table. Calls are
    // already sequential in this single-process test; the real lock is tested on Postgres.
    connect: async () => ({ query: (sql, p) => pool.query(sql, p), release: () => {} })
  };
  return pool;
};

describe('Account management (online)', () => {
  let server; let base; let localDb; let dir;
  const users = new Map();
  const audit = [];
  const tokens = {};

  const call = async (method, url, body, token) => {
    const res = await fetch(base + url, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: res.status, body: await res.json() };
  };
  const login = async (username, password = PASSWORD) => {
    const r = await call('POST', '/api/auth/login', { username, password });
    assert.equal(r.status, 200, `${username} login: ${JSON.stringify(r.body)}`);
    tokens[username] = r.body.token;
    return r.body.token;
  };
  // A logged-in probe that touches no other table: an empty password change is a 400 when the
  // session is valid, and a 401 when it was signed out
  const sessionOk = async (token) => (await call('POST', '/api/auth/change-password', {}, token)).status === 400;

  before(async () => {
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-that-is-long-enough-for-hs256-0123456789';
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaowusys-accounts-'));
    const dbPath = path.join(dir, 'cache.db');
    localDb = await prepareDatabase(dbPath, { users: [] });
    const hash = await bcrypt.hash(PASSWORD, 4);
    for (const [user_id, username, role] of [['u-owner', 'owner', 'Owner'], ['u-admin', 'admin', 'Admin'], ['u-staff', 'staff', 'Staff']]) {
      users.set(user_id, { user_id, username, password_hash: hash, role, is_active: true, tokens_valid_after: null, created_at: '2026-10-01 00:00:00' });
    }
    const app = createApp({
      pgPool: createUsersCloud(users, audit), localDb, localDbPath: dbPath, orderLocks: createOrderLockManager(),
      inventoryEvents: { notifyChanged() {} }, syncAndNotify: async () => ({}), listConflicts: async () => []
    });
    server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
    await Promise.all(['owner', 'admin', 'staff'].map((u) => login(u)));
  });
  after(async () => {
    await new Promise((r) => server.close(r));
    await new Promise((r) => localDb.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('saves an account on this computer after an online login, for offline use', async () => {
    const row = await new Promise((r) => localDb.get("SELECT username, password_hash FROM users WHERE user_id = 'u-staff'", (e, x) => r(x)));
    assert.equal(row.username, 'staff');
    assert.equal(row.password_hash, users.get('u-staff').password_hash, 'only the hash is stored');
  });

  it('creates accounts and refuses a taken username', async () => {
    const r = await call('POST', '/api/auth/register', { username: 'rin.production', password: 'Rin12345', role: 'Production' }, tokens.admin);
    assert.equal(r.status, 201);
    assert.equal(r.body.user.role, 'Production');
    const dup = await call('POST', '/api/auth/register', { username: 'rin.production', password: 'Rin12345', role: 'Staff' }, tokens.admin);
    assert.equal(dup.status, 409);
    assert.equal(dup.body.error, 'USERNAME_TAKEN');
  });

  it('does not let an Admin touch an Owner, or make anyone an Owner', async () => {
    assert.equal((await call('PATCH', '/api/auth/users/u-owner', { is_active: false }, tokens.admin)).status, 403);
    assert.equal((await call('POST', '/api/auth/users/u-owner/reset-password', { new_password: 'Hacked123' }, tokens.admin)).status, 403);
    assert.equal((await call('PATCH', '/api/auth/users/u-staff', { role: 'Owner' }, tokens.admin)).status, 400);
  });

  it('signs a deactivated account out at once and blocks its login', async () => {
    assert.ok(await sessionOk(tokens.staff));
    const r = await call('PATCH', '/api/auth/users/u-staff', { is_active: false }, tokens.admin);
    assert.equal(r.status, 200);
    assert.equal(r.body.user.is_active, false);
    assert.ok(!(await sessionOk(tokens.staff)), 'old session ended');
    assert.equal((await call('POST', '/api/auth/login', { username: 'staff', password: PASSWORD })).status, 403);
    assert.equal((await call('PATCH', '/api/auth/users/u-staff', { is_active: true }, tokens.admin)).status, 200);
    assert.ok(!(await sessionOk(tokens.staff)), 'the old session stays ended after reactivation');
    assert.ok(await sessionOk(await login('staff')), 'a new login works');
  });

  it('does not let anyone change or deactivate themselves', async () => {
    const r = await call('PATCH', '/api/auth/users/u-owner', { is_active: false }, tokens.owner);
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'CANNOT_CHANGE_SELF');
  });

  it('always keeps at least one active Owner or Admin', async () => {
    const second = await call('POST', '/api/auth/register', { username: 'owner2', password: 'Owner2222', role: 'Owner' }, tokens.owner);
    assert.equal(second.status, 201);
    await login('owner2', 'Owner2222');
    // Another branch deactivated the Admin and this Owner a moment ago; this Owner's token is
    // still valid here. Deactivating owner2 now would leave nobody able to manage accounts.
    users.get('u-admin').is_active = false;
    users.get('u-owner').is_active = false;
    const r = await call('PATCH', `/api/auth/users/${second.body.user.user_id}`, { is_active: false }, tokens.owner);
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'LAST_MANAGER');
    users.get('u-admin').is_active = true;
    users.get('u-owner').is_active = true;
  });

  it('resets a forgotten password and signs that person out', async () => {
    const before = await login('staff');
    const r = await call('POST', '/api/auth/users/u-staff/reset-password', { new_password: 'NewPass99' }, tokens.owner2);
    assert.equal(r.status, 200);
    assert.ok(!(await sessionOk(before)));
    assert.equal((await call('POST', '/api/auth/login', { username: 'staff', password: PASSWORD })).status, 401, 'old password no longer works');
    await login('staff', 'NewPass99');
  });

  it('changes your own password, ends your other sessions and keeps this device logged in', async () => {
    const wrong = await call('POST', '/api/auth/change-password', { current_password: 'Wrong999', new_password: 'Owner3333' }, tokens.owner2);
    assert.equal(wrong.status, 400);
    assert.equal(wrong.body.error, 'WRONG_PASSWORD');
    const r = await call('POST', '/api/auth/change-password', { current_password: 'Owner2222', new_password: 'Owner3333' }, tokens.owner2);
    assert.equal(r.status, 200);
    assert.ok(!(await sessionOk(tokens.owner2)), 'other sessions ended');
    assert.ok(await sessionOk(r.body.token), 'the returned token works');
  });

  it('removes a Staff account (deactivated + hidden, kept for the records) and restores it', async () => {
    const admin = await login('admin');
    const staffSession = await login('staff', 'NewPass99');

    // Owner and Admin accounts can never be removed; nobody removes themselves
    const manager = await call('POST', '/api/auth/users/u-owner/remove', undefined, admin);
    assert.deepEqual([manager.status, manager.body.error], [403, 'CANNOT_REMOVE_MANAGER']);
    assert.equal((await call('POST', '/api/auth/users/u-admin/remove', undefined, admin)).status, 400);
    // Production / Staff cannot remove anyone
    assert.equal((await call('POST', '/api/auth/users/u-owner/remove', undefined, staffSession)).status, 403);

    const r = await call('POST', '/api/auth/users/u-staff/remove', undefined, admin);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.user.is_active, false);
    assert.ok(r.body.user.removed_at);
    assert.ok(!(await sessionOk(staffSession)), 'signed out at once');
    assert.equal((await call('POST', '/api/auth/login', { username: 'staff', password: 'NewPass99' })).status, 403);
    assert.deepEqual(audit.at(-1), { entity: 'users', entity_id: 'u-staff', action: 'account_removed', performed_by: 'u-admin' });
    assert.ok(users.has('u-staff'), 'never deleted');

    // Hidden from the everyday list, shown by "Show removed" only
    const everyday = await call('GET', '/api/auth/users', undefined, admin);
    assert.ok(!everyday.body.users.some((u) => u.user_id === 'u-staff'));
    const removed = await call('GET', '/api/auth/users?removed=only', undefined, admin);
    assert.deepEqual(removed.body.users.map((u) => u.user_id), ['u-staff']);
    assert.equal(removed.body.removed_only, true);
    assert.equal((await call('GET', '/api/auth/users?removed=maybe', undefined, admin)).status, 400);

    // A removed account takes no other change until restored
    const again = await call('POST', '/api/auth/users/u-staff/remove', undefined, admin);
    assert.equal(again.body.error, 'ALREADY_REMOVED');
    const activate = await call('PATCH', '/api/auth/users/u-staff', { is_active: true }, admin);
    assert.deepEqual([activate.status, activate.body.error], [409, 'ACCOUNT_REMOVED']);
    const reset = await call('POST', '/api/auth/users/u-staff/reset-password', { new_password: 'Other123' }, admin);
    assert.deepEqual([reset.status, reset.body.error], [409, 'ACCOUNT_REMOVED']);

    // Restore: back in the list, still deactivated until a manager reactivates it
    const back = await call('POST', '/api/auth/users/u-staff/restore', undefined, admin);
    assert.equal(back.status, 200, JSON.stringify(back.body));
    assert.deepEqual([back.body.user.removed_at, back.body.user.is_active], [null, false]);
    assert.equal(audit.at(-1).action, 'account_restored');
    assert.equal((await call('POST', '/api/auth/users/u-staff/restore', undefined, admin)).body.error, 'NOT_REMOVED');
    assert.ok((await call('GET', '/api/auth/users', undefined, admin)).body.users.some((u) => u.user_id === 'u-staff'));
    assert.equal((await call('PATCH', '/api/auth/users/u-staff', { is_active: true }, admin)).status, 200);
    await login('staff', 'NewPass99');
  });
});
