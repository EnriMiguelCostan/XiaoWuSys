// PB 1: "Log out" ends the session on the server, for this device only
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { startTestServer } = require('./helpers/testServer');
const { loadRevocations, onSessionRevoked } = require('../services/sessions');
const { createCloudDisabledPool } = require('../services/cloudDisabledPool');

describe('Logging out one device', () => {
  let t;
  let laptop;
  let tablet;
  const ended = [];
  let stopListening;

  before(async () => {
    t = await startTestServer();
    laptop = await t.login('owner');          // back-office laptop
    tablet = await t.login('owner');          // shop-floor tablet, same account
    stopListening = onSessionRevoked((sid) => ended.push(sid));
  });
  after(async () => { stopListening(); await t.close(); });

  it('gives every login its own session', () => {
    const a = jwt.decode(laptop);
    const b = jwt.decode(tablet);
    assert.ok(a.sid && b.sid);
    assert.notEqual(a.sid, b.sid);
  });

  it('ends the laptop session on the server and keeps the tablet logged in', async () => {
    assert.equal((await t.request('GET', '/api/inventory', { token: laptop })).status, 200);
    const out = await t.request('POST', '/api/auth/logout', { token: laptop });
    assert.equal(out.status, 200, out.text);
    assert.deepEqual([out.body.revoked, out.body.source], [true, 'local']);
    assert.equal(out.body.message, 'You have been logged out on this device.');

    const again = await t.request('GET', '/api/inventory', { token: laptop });
    assert.equal(again.status, 401, 'the old token is refused even though it has not expired');
    assert.equal(again.body.error, 'SESSION_ENDED');
    assert.equal((await t.request('GET', '/api/inventory', { token: tablet })).status, 200, 'the tablet is not affected');
  });

  it('closes the live connection of that device only', () => {
    assert.deepEqual(ended, [jwt.decode(laptop).sid]);
  });

  it('saves the logout on this computer so the cloud learns about it when the internet is back', async () => {
    const { sid, exp } = jwt.decode(laptop);
    const row = await t.get('SELECT user_id, expires_at, sync_status FROM revoked_sessions WHERE session_id = ?', [sid]);
    assert.equal(row.user_id, 'u-owner');
    assert.equal(row.sync_status, 'pending_insert');
    assert.equal(row.expires_at, new Date(exp * 1000).toISOString().slice(0, 19).replace('T', ' '), 'kept until the token would have expired');
  });

  it('remembers the logout after a server restart', async () => {
    const sid = 'restart-check-session';
    const token = jwt.sign({ user_id: 'u-admin', role: 'Admin', ims: Date.now(), sid }, process.env.JWT_SECRET, { expiresIn: '8h' });
    assert.equal((await t.request('GET', '/api/inventory', { token })).status, 200);
    const expires = new Date(Date.now() + 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
    await t.run("INSERT INTO revoked_sessions (session_id, user_id, expires_at, sync_status) VALUES (?, 'u-admin', ?, 'synced')", [sid, expires]);
    await loadRevocations({ pgPool: createCloudDisabledPool(), localDb: t.localDb }); // what start-up does
    assert.equal((await t.request('GET', '/api/inventory', { token })).status, 401);
  });

  it('accepts a logout from a session that started before this update, and lets it expire', async () => {
    const legacy = jwt.sign({ user_id: 'u-staff', role: 'Staff', ims: Date.now() }, process.env.JWT_SECRET, { expiresIn: '8h' });
    const r = await t.request('POST', '/api/auth/logout', { token: legacy });
    assert.equal(r.status, 200);
    assert.equal(r.body.revoked, false);
  });

  it('needs a login to log out', async () => {
    assert.equal((await t.request('POST', '/api/auth/logout')).status, 401);
  });
});
