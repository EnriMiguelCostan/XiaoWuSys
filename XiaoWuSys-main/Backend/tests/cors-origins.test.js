// Batch M0: the Next.js screens (Web/, port 3000) and tablets on the shop Wi-Fi may call the API;
// nothing else may.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer } = require('./helpers/testServer');
const { parseOrigins, DEFAULT_ORIGINS } = require('../app');

const originHeader = async (t, origin) =>
  (await t.request('GET', '/api/status', { headers: { Origin: origin } })).headers.get('access-control-allow-origin');

describe('CORS defaults include the Next.js screens', () => {
  it('allows Web/ on this computer when CORS_ORIGINS is empty', () => {
    assert.ok(DEFAULT_ORIGINS.includes('http://localhost:3000'));
    assert.ok(DEFAULT_ORIGINS.includes('http://127.0.0.1:3000'));
    assert.deepEqual(parseOrigins(''), DEFAULT_ORIGINS);
  });

  it('still allows the frozen Vite screens', () => {
    assert.ok(DEFAULT_ORIGINS.includes('http://localhost:5173'));
  });
});

describe('CORS for tablets on the shop Wi-Fi (Q4)', () => {
  let t;
  before(async () => {
    t = await startTestServer({ corsOrigins: parseOrigins('http://localhost:3000, http://192.168.1.20:3000/') });
  });
  after(async () => { await t.close(); });

  it('allows a LAN address listed in CORS_ORIGINS (trailing slash ignored)', async () => {
    assert.equal(await originHeader(t, 'http://192.168.1.20:3000'), 'http://192.168.1.20:3000');
    assert.equal(await originHeader(t, 'http://localhost:3000'), 'http://localhost:3000');
  });

  it('refuses other devices, ports and sites', async () => {
    assert.equal(await originHeader(t, 'http://192.168.1.21:3000'), null);
    assert.equal(await originHeader(t, 'http://192.168.1.20:8080'), null);
    assert.equal(await originHeader(t, 'https://evil.example'), null);
  });
});
