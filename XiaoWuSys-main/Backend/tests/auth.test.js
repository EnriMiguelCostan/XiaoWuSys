// Accounts, login security and sessions (offline mode: accounts already on this computer)
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { startTestServer, fixtures } = require('./helpers/testServer');
const { revokeUser, reactivateUser } = require('../services/sessions');

describe('Login', () => {
  let t;
  before(async () => { t = await startTestServer(); });
  after(async () => { await t.close(); });

  it('logs in an account that is saved on this computer, even with the cloud offline', async () => {
    const r = await t.request('POST', '/api/auth/login', { body: { username: 'owner', password: fixtures.PASSWORD } });
    assert.equal(r.status, 200);
    assert.equal(r.body.role, 'Owner');
    assert.equal(r.body.offline, true);
    assert.equal(r.body.user.username, 'owner');
    assert.equal(r.body.user.password_hash, undefined, 'the password hash is never sent to the browser');
    const payload = jwt.verify(r.body.token, process.env.JWT_SECRET);
    assert.deepEqual([payload.user_id, payload.role], ['u-owner', 'Owner']);
  });

  it('gives the same answer for a wrong password and an unknown username', async () => {
    const wrongPass = await t.request('POST', '/api/auth/login', { body: { username: 'admin', password: 'Nope12345' } });
    const unknown = await t.request('POST', '/api/auth/login', { body: { username: 'nobody', password: 'Nope12345' } });
    assert.equal(wrongPass.status, 401);
    assert.equal(unknown.status, 401);
    assert.equal(wrongPass.body.error, 'INVALID_CREDENTIALS');
    assert.equal(unknown.body.error, 'INVALID_CREDENTIALS');
    assert.match(wrongPass.body.message, /^Wrong username or password\./);
    assert.match(wrongPass.body.message, /offline/, 'explains that only accounts saved here work offline');
  });

  it('refuses a deactivated account', async () => {
    const r = await t.request('POST', '/api/auth/login', { body: { username: 'former.staff', password: fixtures.PASSWORD } });
    assert.equal(r.status, 403);
    assert.equal(r.body.error, 'ACCOUNT_DEACTIVATED');
  });

  it('asks for both fields', async () => {
    const r = await t.request('POST', '/api/auth/login', { body: { username: 'owner' } });
    assert.equal(r.status, 400);
    assert.equal(r.body.message, 'Please enter your username and password.');
  });

  it('locks a username for 15 minutes after 5 wrong passwords (brute-force protection)', async () => {
    for (let i = 1; i <= 5; i++) {
      const r = await t.request('POST', '/api/auth/login', { body: { username: 'production', password: `Wrong${i}abc` } });
      assert.equal(r.status, 401, `attempt ${i}`);
    }
    const blocked = await t.request('POST', '/api/auth/login', { body: { username: 'production', password: fixtures.PASSWORD } });
    assert.equal(blocked.status, 429, 'even the right password is refused while locked');
    assert.equal(blocked.body.error, 'TOO_MANY_ATTEMPTS');
    assert.ok(Number(blocked.headers.get('retry-after')) > 0);
    const other = await t.request('POST', '/api/auth/login', { body: { username: 'staff', password: fixtures.PASSWORD } });
    assert.equal(other.status, 200, 'other accounts are not affected');
  });
});

describe('Sessions', () => {
  let t;
  let staffToken;
  before(async () => {
    t = await startTestServer();
    await t.login('staff');
    // A session that started a minute ago (tokens from the same second as a sign-out are
    // indistinguishable by design: the token's issue time has 1-second precision)
    staffToken = jwt.sign({ user_id: 'u-staff', role: 'Staff', iat: Math.floor(Date.now() / 1000) - 60 }, process.env.JWT_SECRET, { expiresIn: '8h' });
  });
  after(async () => { await t.close(); });

  it('rejects requests without a token', async () => {
    const r = await t.request('GET', '/api/inventory');
    assert.equal(r.status, 401);
    assert.equal(r.body.error, 'NOT_LOGGED_IN');
  });

  it('rejects a forged token (wrong secret)', async () => {
    const forged = jwt.sign({ user_id: 'u-owner', role: 'Owner' }, 'not-the-server-secret');
    const r = await t.request('GET', '/api/inventory', { token: forged });
    assert.equal(r.status, 401);
    assert.equal(r.body.error, 'INVALID_SESSION');
  });

  it('rejects a token that claims a role with the "none" algorithm', async () => {
    const unsigned = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${Buffer.from('{"user_id":"x","role":"Owner"}').toString('base64url')}.`;
    const r = await t.request('GET', '/api/inventory', { token: unsigned });
    assert.equal(r.status, 401);
  });

  it('explains an expired session in plain language', async () => {
    const expired = jwt.sign({ user_id: 'u-staff', role: 'Staff', exp: Math.floor(Date.now() / 1000) - 60 }, process.env.JWT_SECRET);
    const r = await t.request('GET', '/api/inventory', { token: expired });
    assert.equal(r.status, 401);
    assert.equal(r.body.error, 'SESSION_EXPIRED');
    assert.equal(r.body.message, 'Your session has expired. Please log in again.');
  });

  it('signs an account out immediately when it is deactivated', async () => {
    assert.equal((await t.request('GET', '/api/inventory', { token: staffToken })).status, 200);
    revokeUser('u-staff', { deactivated: true });
    const r = await t.request('GET', '/api/inventory', { token: staffToken });
    assert.equal(r.status, 401);
    assert.equal(r.body.error, 'SESSION_ENDED');
    reactivateUser('u-staff');
    assert.equal((await t.request('GET', '/api/inventory', { token: staffToken })).status, 401,
      'tokens from before the deactivation stay invalid after reactivation');
    const fresh = await t.login('staff');
    assert.equal((await t.request('GET', '/api/inventory', { token: fresh })).status, 200, 'a new login works');
  });
});

describe('Account management', () => {
  let t;
  before(async () => {
    t = await startTestServer();
    await Promise.all(['owner', 'admin', 'staff'].map((u) => t.login(u)));
  });
  after(async () => { await t.close(); });

  it('lets an Owner or Admin see the accounts (without password hashes)', async () => {
    const r = await t.request('GET', '/api/auth/users', { token: t.tokens.admin });
    assert.equal(r.status, 200);
    assert.equal(r.body.users.length, fixtures.USERS.length);
    assert.ok(r.body.users.every((u) => u.password_hash === undefined));
    assert.equal(r.body.users.find((u) => u.username === 'former.staff').is_active, false);
    assert.ok(!r.body.assignable_roles.includes('Owner'), 'an Admin cannot hand out the Owner role');
    const owner = await t.request('GET', '/api/auth/users', { token: t.tokens.owner });
    assert.ok(owner.body.assignable_roles.includes('Owner'));
  });

  it('hides account management from Staff', async () => {
    const r = await t.request('GET', '/api/auth/users', { token: t.tokens.staff });
    assert.equal(r.status, 403);
    assert.equal(r.body.error, 'FORBIDDEN');
    const create = await t.request('POST', '/api/auth/register', { token: t.tokens.staff, body: { username: 'x', password: 'Abcdefg1', role: 'Staff' } });
    assert.equal(create.status, 403);
  });

  it('checks the password rule before anything is saved', async () => {
    for (const [password, msg] of [['short1', /at least 8/], ['allletters', /letter and one number/], ['12345678', /letter and one number/]]) {
      const r = await t.request('POST', '/api/auth/register', { token: t.tokens.admin, body: { username: 'new.staff', password, role: 'Staff' } });
      assert.equal(r.status, 400, password);
      assert.match(r.body.message, msg);
    }
  });

  it('does not let an Admin create an Owner', async () => {
    const r = await t.request('POST', '/api/auth/register', { token: t.tokens.admin, body: { username: 'boss2', password: 'Abcdefg12', role: 'Owner' } });
    assert.equal(r.status, 400);
  });

  it('explains that account changes need the internet', async () => {
    const r = await t.request('POST', '/api/auth/register', { token: t.tokens.admin, body: { username: 'new.staff', password: 'Abcdefg12', role: 'Staff' } });
    assert.equal(r.status, 503);
    assert.equal(r.body.error, 'ACCOUNTS_REQUIRE_CLOUD');
    const self = await t.request('PATCH', '/api/auth/users/u-admin', { token: t.tokens.admin, body: { is_active: false } });
    assert.equal(self.status, 400);
    assert.equal(self.body.error, 'CANNOT_CHANGE_SELF');
  });
});
