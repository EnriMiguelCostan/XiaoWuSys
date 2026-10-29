// ==========================================
// ACCOUNTS
//   POST  /api/auth/login                          everyone (rate limited; works offline for
//                                                   accounts that synced to this computer)
//   POST  /api/auth/change-password                any logged-in user (own password)
//   GET   /api/auth/users                          Owner, Admin
//   POST  /api/auth/register                       Owner, Admin (create an account)
//   PATCH /api/auth/users/:user_id                 Owner, Admin { role?, is_active? }
//   POST  /api/auth/users/:user_id/reset-password  Owner, Admin { new_password }
//
// Rules (always enforced here, whatever the UI shows):
//   - roles come from the verified token, never from the request body
//   - only an Owner can create, edit or reset another Owner
//   - nobody can change their own role or deactivate themselves
//   - at least one active Owner or Admin must always remain
//   - deactivating, changing a role or setting a password signs that account out everywhere
// Account changes need the cloud: they must reach every branch, and a wrong offline copy
// could lock people out.
// ==========================================
const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const router = express.Router();
const { verifyToken, requireRole } = require('../middleware/authMiddleware');
const { isConnectionError } = require('../utils/dbErrors');
const { createLoginLimiter } = require('../utils/rateLimit');
const { createValidator } = require('../utils/validation');
const { sqliteGet, sqliteAll, sqliteRun, withPgTransaction } = require('../services/records');
const { revokeUser, reactivateUser, isActiveValue, CUTOFF_SQL } = require('../services/sessions');

const ROLES = ['Owner', 'Admin', 'Production', 'Staff'];
const MANAGER_ROLES = ['Owner', 'Admin'];
// Sprint 11 / PB 13: an Owner may additionally create other Owners; an Admin cannot.
const allowedRolesFor = (callerRole) => (callerRole === 'Owner' ? ROLES : ROLES.filter((r) => r !== 'Owner'));
const MAX_USERNAME_LENGTH = 100; // users.username VARCHAR(100)
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_BYTES = 72;   // bcrypt ignores anything beyond 72 bytes
const BCRYPT_ROUNDS = 10;
const TOKEN_TTL = '8h';

const limiter = createLoginLimiter();
// Compared against when the username does not exist, so both cases take the same time
// (response timing cannot reveal which usernames exist)
let dummyHash = null;
const dummyCompare = async (password) => {
  if (!dummyHash) dummyHash = await bcrypt.hash('not-a-real-password-0', BCRYPT_ROUNDS);
  await bcrypt.compare(password, dummyHash);
  return false;
};
router.loginLimiter = limiter; // exposed for tests

// Plain-language password rule. -> error message or null
const passwordProblem = (password) => {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return `The password must be at least ${MIN_PASSWORD_LENGTH} characters long.`;
  }
  if (Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES) return 'The password is too long. Please use 72 characters or fewer.';
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) return 'The password must contain at least one letter and one number.';
  return null;
};

const fail = (res, status, error, message, extra = {}) => res.status(status).json({ error, message, ...extra });
const needsCloud = (res) => fail(res, 503, 'ACCOUNTS_REQUIRE_CLOUD',
  'Accounts can only be created or changed while the system is online. Please try again when the internet is back.');

// ims = issue time in milliseconds, so a sign-out cuts off exactly (iat only has 1-second precision)
const signToken = (user) => jwt.sign({ user_id: user.user_id, role: user.role, ims: Date.now() }, process.env.JWT_SECRET, { expiresIn: TOKEN_TTL });

const publicUser = (u) => ({
  user_id: u.user_id,
  username: u.username,
  role: u.role,
  is_active: isActiveValue(u.is_active),
  created_at: u.created_at ? String(u.created_at).replace(' ', 'T').slice(0, 19) : null
});

// Keeps the offline copy of an account current, so it can log in without internet.
// Stores the bcrypt hash only (never the password). Best effort: failures are only logged.
const cacheUserLocally = async (localDb, u) => {
  try {
    await sqliteRun(localDb,
      `INSERT INTO users (user_id, username, password_hash, role, is_active, tokens_valid_after, sync_status)
       VALUES (?, ?, ?, ?, ?, ?, 'synced')
       ON CONFLICT (user_id) DO UPDATE SET username = excluded.username, password_hash = excluded.password_hash,
         role = excluded.role, is_active = excluded.is_active, tokens_valid_after = excluded.tokens_valid_after`,
      [u.user_id, u.username, u.password_hash, u.role, isActiveValue(u.is_active) ? 1 : 0,
        u.tokens_valid_after ? String(u.tokens_valid_after) : null]);
  } catch (err) {
    console.error('⚠️ Could not save the account for offline login:', err.message);
  }
};

const USER_COLUMNS = 'user_id, username, password_hash, role, is_active, tokens_valid_after::text AS tokens_valid_after, created_at::text AS created_at';

// ==========================================
// LOGIN
// ==========================================
router.post('/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || username.trim() === '' || typeof password !== 'string' || password === '') {
    return fail(res, 400, 'VALIDATION_FAILED', 'Please enter your username and password.');
  }
  const name = username.trim();
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';

  const blocked = limiter.check(ip, name);
  if (blocked) {
    res.set('Retry-After', String(blocked.retryAfterSeconds));
    return fail(res, 429, 'TOO_MANY_ATTEMPTS',
      `Too many wrong passwords. For your security, please wait ${Math.ceil(blocked.retryAfterSeconds / 60)} minute(s) and try again.`,
      { retry_after_seconds: blocked.retryAfterSeconds });
  }

  // The same answer for "no such user" and "wrong password", so usernames cannot be guessed
  const wrong = (offline) => {
    const { remaining, locked } = limiter.recordFailure(ip, name);
    return fail(res, 401, 'INVALID_CREDENTIALS',
      (locked
        ? 'Wrong username or password. Too many attempts: please wait 15 minutes before trying again.'
        : `Wrong username or password.${remaining <= 2 ? ` ${remaining} attempt(s) left before a 15-minute wait.` : ''}`)
      + (offline ? ' (The system is offline right now: only accounts that have logged in on this computer before can log in.)' : ''),
      { offline: Boolean(offline) });
  };

  try {
    let user;
    let offline = false;
    try {
      const { rows } = await req.pgPool.query(`SELECT ${USER_COLUMNS} FROM users WHERE username = $1`, [name]);
      user = rows[0];
    } catch (err) {
      if (!isConnectionError(err)) throw err;
      offline = true;
      user = await sqliteGet(req.localDb,
        'SELECT user_id, username, password_hash, role, is_active, tokens_valid_after FROM users WHERE username = ?', [name]);
    }

    // Offline, an unknown account may simply never have logged in on this computer: the
    // message says so, without revealing whether the username exists.
    const passwordOk = user ? await bcrypt.compare(password, user.password_hash) : await dummyCompare(password);
    if (!passwordOk) return wrong(offline);
    if (!isActiveValue(user.is_active)) {
      return fail(res, 403, 'ACCOUNT_DEACTIVATED', 'This account has been deactivated. Please ask an Owner or Admin.');
    }

    limiter.recordSuccess(ip, name);
    if (!offline) await cacheUserLocally(req.localDb, user);
    const token = signToken(user);
    console.log(`✓ ${user.username} (${user.role}) logged in${offline ? ' (offline)' : ''}`);
    res.status(200).json({
      message: offline ? 'Logged in (offline mode).' : 'Login successful',
      token,
      role: user.role,
      user: publicUser(user),
      offline
    });
  } catch (error) {
    console.error('✗ Login Error:', error.message);
    fail(res, 500, 'INTERNAL_ERROR', 'Something went wrong while logging in. Please try again.');
  }
});

// Everything below needs a valid session
router.use(verifyToken);

// ==========================================
// CHANGE OWN PASSWORD -> { message, token } (a fresh token, so this device stays logged in)
// ==========================================
router.post('/change-password', async (req, res) => {
  const { current_password, new_password } = req.body || {};
  if (typeof current_password !== 'string' || current_password === '') {
    return fail(res, 400, 'VALIDATION_FAILED', 'Please enter your current password.');
  }
  const problem = passwordProblem(new_password);
  if (problem) return fail(res, 400, 'VALIDATION_FAILED', problem);
  if (new_password === current_password) return fail(res, 400, 'VALIDATION_FAILED', 'The new password must be different from the current one.');

  try {
    const { rows } = await req.pgPool.query(`SELECT ${USER_COLUMNS} FROM users WHERE user_id = $1`, [req.user.user_id]);
    const user = rows[0];
    if (!user || !isActiveValue(user.is_active)) return fail(res, 401, 'SESSION_ENDED', 'Your session has ended. Please log in again.');
    if (!(await bcrypt.compare(current_password, user.password_hash))) {
      return fail(res, 400, 'WRONG_PASSWORD', 'Your current password is not correct.');
    }
    const hash = await bcrypt.hash(new_password, BCRYPT_ROUNDS);
    const at = Date.now();
    const updated = await req.pgPool.query(
      `UPDATE users SET password_hash = $2, tokens_valid_after = ${CUTOFF_SQL('$3')} WHERE user_id = $1 RETURNING ${USER_COLUMNS}`,
      [user.user_id, hash, at]);
    revokeUser(user.user_id, { at });
    await cacheUserLocally(req.localDb, updated.rows[0]);
    console.log(`🔑 ${user.username} changed their password`);
    // The new token's iat is in the same second as the cut-off or later, so it stays valid
    res.status(200).json({ message: 'Your password was changed. Other devices have been signed out.', token: signToken(user) });
  } catch (err) {
    if (isConnectionError(err)) return needsCloud(res);
    console.error('✗ Change password error:', err.message);
    fail(res, 500, 'INTERNAL_ERROR', 'Something went wrong. Your password was not changed.');
  }
});

// ==========================================
// LIST ACCOUNTS (works offline from the local copy, read-only)
// ==========================================
router.get('/users', requireRole(MANAGER_ROLES), async (req, res) => {
  try {
    let rows;
    let source = 'cloud';
    try {
      rows = (await req.pgPool.query(`SELECT ${USER_COLUMNS} FROM users ORDER BY is_active DESC, role, username`)).rows;
    } catch (err) {
      if (!isConnectionError(err)) throw err;
      source = 'local';
      rows = await sqliteAll(req.localDb,
        'SELECT user_id, username, role, is_active, created_at FROM users ORDER BY is_active DESC, role, username');
    }
    res.status(200).json({ source, users: rows.map(publicUser), assignable_roles: allowedRolesFor(req.user.role) });
  } catch (err) {
    console.error('✗ List users error:', err.message);
    fail(res, 500, 'INTERNAL_ERROR', 'The list of accounts could not be loaded.');
  }
});

// ==========================================
// CREATE ACCOUNT (public sign-up is disabled: audit C1)
// Bootstrap the very first account with:  npm run create-admin
// ==========================================
router.post('/register', requireRole(MANAGER_ROLES), async (req, res) => {
  const { username, password, role } = req.body || {};
  const allowedRoles = allowedRolesFor(req.user.role);

  if (typeof username !== 'string' || username.trim() === '') return fail(res, 400, 'VALIDATION_FAILED', 'Please enter a username.');
  if (username.trim().length > MAX_USERNAME_LENGTH) return fail(res, 400, 'VALIDATION_FAILED', `The username must be ${MAX_USERNAME_LENGTH} characters or fewer.`);
  if (/\s/.test(username.trim())) return fail(res, 400, 'VALIDATION_FAILED', 'The username cannot contain spaces.');
  const problem = passwordProblem(password);
  if (problem) return fail(res, 400, 'VALIDATION_FAILED', problem);
  if (!allowedRoles.includes(role)) {
    return fail(res, 400, 'VALIDATION_FAILED', `Please choose a role: ${allowedRoles.join(', ')}.`);
  }

  try {
    const password_hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const { rows } = await req.pgPool.query(
      `INSERT INTO users (user_id, username, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING ${USER_COLUMNS}`,
      [crypto.randomUUID(), username.trim(), password_hash, role]);
    await cacheUserLocally(req.localDb, rows[0]);
    console.log(`👤 ${req.user.role} ${req.user.user_id} created ${rows[0].username} (${role})`);
    res.status(201).json({ message: `The account "${rows[0].username}" was created.`, user: publicUser(rows[0]) });
  } catch (error) {
    if (error.code === '23505') return fail(res, 409, 'USERNAME_TAKEN', 'That username is already taken. Please choose another one.');
    if (isConnectionError(error)) return needsCloud(res);
    console.error('✗ Registration Error:', error.message);
    fail(res, 500, 'INTERNAL_ERROR', 'Something went wrong. The account was not created.');
  }
});

// Loads the target account and applies the "who may manage whom" rules. -> user row or null (response sent)
const loadManageable = async (req, res) => {
  const v = createValidator();
  v.id(req.params.user_id, 'user_id');
  if (v.failed()) { v.send(res); return null; }
  const { rows } = await req.pgPool.query(`SELECT ${USER_COLUMNS} FROM users WHERE user_id = $1`, [req.params.user_id]);
  const target = rows[0];
  if (!target) { fail(res, 404, 'USER_NOT_FOUND', 'This account no longer exists. Please refresh the list.'); return null; }
  if (target.role === 'Owner' && req.user.role !== 'Owner') {
    fail(res, 403, 'FORBIDDEN', 'Only an Owner can change an Owner account.');
    return null;
  }
  return target;
};

// Business-rule failure inside an account transaction: rolled back, then sent as-is
class AccountRejected extends Error {
  constructor(status, body) { super(body.error); this.status = status; this.body = body; }
}
const reject = (status, error, message) => new AccountRejected(status, { error, message });

// ==========================================
// CHANGE ROLE / ACTIVATE / DEACTIVATE
// ==========================================
router.patch('/users/:user_id', requireRole(MANAGER_ROLES), async (req, res) => {
  const body = req.body || {};
  if (body.role === undefined && body.is_active === undefined) {
    return fail(res, 400, 'VALIDATION_FAILED', 'Nothing to change: send a new role or an active status.');
  }
  if (body.is_active !== undefined && typeof body.is_active !== 'boolean') {
    return fail(res, 400, 'VALIDATION_FAILED', 'Active status must be true or false.');
  }
  if (body.role !== undefined && !allowedRolesFor(req.user.role).includes(body.role)) {
    return fail(res, 400, 'VALIDATION_FAILED', `Please choose a role: ${allowedRolesFor(req.user.role).join(', ')}.`);
  }
  if (req.params.user_id === req.user.user_id) {
    return fail(res, 400, 'CANNOT_CHANGE_SELF', 'You cannot change your own role or deactivate your own account. Ask another Owner or Admin.');
  }

  const v = createValidator();
  v.id(req.params.user_id, 'user_id');
  if (v.failed()) return v.send(res);
  const targetId = req.params.user_id;

  try {
    // One transaction: lock, check, update. Two managers removing each other at the same time
    // are serialized by the row locks, so the second one sees the first change and is refused.
    const result = await withPgTransaction(req.pgPool, async (client) => {
      // Lock every active Owner/Admin AND the target, in a fixed order (no deadlocks).
      // The caller's own row is included: its count must reflect concurrent deactivations.
      const locked = await client.query(
        `SELECT ${USER_COLUMNS} FROM users
          WHERE user_id = $1 OR (is_active = TRUE AND role = ANY($2::text[]))
          ORDER BY user_id FOR UPDATE`,
        [targetId, MANAGER_ROLES]);
      const target = locked.rows.find((u) => u.user_id === targetId);
      if (!target) throw reject(404, 'USER_NOT_FOUND', 'This account no longer exists. Please refresh the list.');
      if (target.role === 'Owner' && req.user.role !== 'Owner') {
        throw reject(403, 'FORBIDDEN', 'Only an Owner can change an Owner account.');
      }
      const role = body.role ?? target.role;
      const is_active = body.is_active ?? isActiveValue(target.is_active);
      if (role === target.role && is_active === isActiveValue(target.is_active)) {
        return { unchanged: true, target };
      }

      // At least one active Owner/Admin must remain, counted on the LOCKED rows
      const wasManager = MANAGER_ROLES.includes(target.role) && isActiveValue(target.is_active);
      const staysManager = MANAGER_ROLES.includes(role) && is_active;
      const otherManagers = locked.rows.filter((u) => u.user_id !== targetId
        && isActiveValue(u.is_active) && MANAGER_ROLES.includes(u.role)).length;
      if (wasManager && !staysManager && otherManagers === 0) {
        throw reject(409, 'LAST_MANAGER', 'This is the last active Owner/Admin account. Create or activate another one first.');
      }

      const at = Date.now();
      // Guarded in SQL too: the update only applies if another active manager still exists
      // when it would remove one (defence in depth, never only in JS).
      const updated = await client.query(
        `UPDATE users SET role = $2, is_active = $3, tokens_valid_after = ${CUTOFF_SQL('$4')}
          WHERE user_id = $1
            AND ($3 = TRUE AND $2 = ANY($5::text[])
                 OR EXISTS (SELECT 1 FROM users m WHERE m.user_id <> $1 AND m.is_active = TRUE AND m.role = ANY($5::text[])))
          RETURNING ${USER_COLUMNS}`,
        [targetId, role, is_active, at, MANAGER_ROLES]);
      if (updated.rowCount !== 1) {
        throw reject(409, 'LAST_MANAGER', 'This is the last active Owner/Admin account. Create or activate another one first.');
      }
      return { target, row: updated.rows[0], role, is_active, at };
    });

    if (result.unchanged) return res.status(200).json({ message: 'Nothing changed.', user: publicUser(result.target) });

    // In-memory sign-out list and offline copy: only after the transaction committed
    const { target, row, role, is_active, at } = result;
    if (!is_active) revokeUser(target.user_id, { deactivated: true });
    else if (!isActiveValue(target.is_active)) reactivateUser(target.user_id, at);
    else revokeUser(target.user_id, { at });
    await cacheUserLocally(req.localDb, row);

    const what = !is_active ? 'deactivated' : !isActiveValue(target.is_active) ? 'reactivated' : `changed to ${role}`;
    console.log(`👤 ${req.user.role} ${req.user.user_id}: account ${target.username} ${what}`);
    res.status(200).json({
      message: `"${target.username}" was ${what}.${is_active ? ' They need to log in again.' : ' They have been signed out.'}`,
      user: publicUser(row)
    });
  } catch (err) {
    if (err instanceof AccountRejected) return res.status(err.status).json(err.body);
    if (err.commitUnknown) {
      return fail(res, 503, 'COMMIT_UNKNOWN', 'The connection dropped while saving. Refresh the list to see whether the change was applied.');
    }
    if (isConnectionError(err)) return needsCloud(res);
    console.error('✗ Update user error:', err.message);
    fail(res, 500, 'INTERNAL_ERROR', 'Something went wrong. The account was not changed.');
  }
});

// ==========================================
// RESET SOMEONE ELSE'S PASSWORD (for forgotten passwords)
// ==========================================
router.post('/users/:user_id/reset-password', requireRole(MANAGER_ROLES), async (req, res) => {
  const { new_password } = req.body || {};
  const problem = passwordProblem(new_password);
  if (problem) return fail(res, 400, 'VALIDATION_FAILED', problem);
  if (req.params.user_id === req.user.user_id) {
    return fail(res, 400, 'CANNOT_CHANGE_SELF', 'To change your own password, use "Change my password".');
  }
  try {
    const target = await loadManageable(req, res);
    if (!target) return;
    const hash = await bcrypt.hash(new_password, BCRYPT_ROUNDS);
    const at = Date.now();
    const { rows } = await req.pgPool.query(
      `UPDATE users SET password_hash = $2, tokens_valid_after = ${CUTOFF_SQL('$3')} WHERE user_id = $1 RETURNING ${USER_COLUMNS}`,
      [target.user_id, hash, at]);
    revokeUser(target.user_id, { deactivated: !isActiveValue(target.is_active), at });
    await cacheUserLocally(req.localDb, rows[0]);
    console.log(`🔑 ${req.user.role} ${req.user.user_id} reset the password of ${target.username}`);
    res.status(200).json({ message: `The password of "${target.username}" was reset. Give them the new password; they have been signed out.` });
  } catch (err) {
    if (isConnectionError(err)) return needsCloud(res);
    console.error('✗ Reset password error:', err.message);
    fail(res, 500, 'INTERNAL_ERROR', 'Something went wrong. The password was not reset.');
  }
});

router.passwordProblem = passwordProblem;
module.exports = router;
