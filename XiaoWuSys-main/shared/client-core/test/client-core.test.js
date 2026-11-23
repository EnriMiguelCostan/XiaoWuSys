// node --test (run from shared/client-core). Plain Node, no packages needed.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../index.js';
import { resolveApiBase, socketUrlFor } from '../config.js';
import { createApi, errorText, FRIENDLY_ERRORS } from '../api.js';
import { can, orderActions, NO_ORDER_ACTIONS, roleHelp } from '../permissions.js';
import { receiptHtml } from '../receipt.js';

describe('package surface', () => {
  it('exports everything the Vite MVP imported from src/api.js and src/lib/*', () => {
    for (const name of [
      'createApi', 'errorText', 'parseCsv', 'todayInManila', 'MOBILE_PATTERN', 'peso', 'formatDateTime', 'formatMobile',
      'can', 'orderActions', 'NO_ORDER_ACTIONS', 'orderNumber', 'hasOrderNumber', 'normalizeOrderNumber',
      'shortfallLines', 'NUMBER_AFTER_SYNC', 'deriveConnectionState', 'connectionText', 'pendingText',
      'syncDisabledReason', 'syncResultMessage', 'escapeHtml', 'receiptHtml', 'receiptText', 'receiptLines',
      'resolveApiBase', 'socketUrlFor', 'ROLE_HELP', 'roleHelp'
    ]) assert.ok(name in core, `missing export ${name}`);
  });

  it('has no DOM helpers (those stay in each app)', () => {
    assert.equal('downloadFile' in core, false);
    assert.equal('copyText' in core, false);
  });
});

describe('formatMobile (display only, Miller chunking)', () => {
  it('groups an 11-digit mobile number as 4-3-4 and leaves everything else as stored', () => {
    assert.equal(core.formatMobile('09171234567'), '0917 123 4567');
    assert.equal(core.formatMobile(' 0917-123-4567 '), '0917 123 4567', 'spaces and dashes typed by staff');
    assert.equal(core.formatMobile('0917123456'), '0917123456', 'too short: shown as stored, never guessed');
    assert.equal(core.formatMobile('+639171234567'), '+639171234567');
    assert.equal(core.formatMobile(null), '');
    assert.equal(core.formatMobile(undefined), '');
  });
});

describe('resolveApiBase (runtime, Q4 LAN tablets)', () => {
  it('follows the address the page was opened on', () => {
    assert.equal(resolveApiBase({ location: { protocol: 'http:', hostname: '192.168.1.20' } }), 'http://192.168.1.20:5000/api');
    assert.equal(resolveApiBase({ location: { protocol: 'http:', hostname: 'localhost' } }), 'http://localhost:5000/api');
  });

  it('lets an explicit address win and trims the trailing slash', () => {
    assert.equal(resolveApiBase({ configured: 'http://10.0.0.5:5000/api/', location: { protocol: 'http:', hostname: 'x' } }), 'http://10.0.0.5:5000/api');
    assert.equal(resolveApiBase({ configured: '   ', location: { protocol: 'http:', hostname: 'pc' } }), 'http://pc:5000/api');
  });

  it('falls back to localhost when there is no page (server side, tests)', () => {
    assert.equal(resolveApiBase(), 'http://localhost:5000/api');
  });

  it('derives the socket address', () => {
    assert.equal(socketUrlFor('http://192.168.1.20:5000/api'), 'http://192.168.1.20:5000');
  });
});

describe('createApi keeps its contract', () => {
  it('never throws and reports status 0 when the server cannot be reached', async () => {
    const original = globalThis.fetch;
    const originalError = console.error;
    globalThis.fetch = async () => { throw new TypeError('fetch failed'); };
    console.error = () => {};
    try {
      const r = await createApi({ apiBase: 'http://x/api', token: 't' })('GET', '/status');
      assert.equal(r.ok, false);
      assert.equal(r.status, 0);
    } finally {
      globalThis.fetch = original;
      console.error = originalError;
    }
  });

  it('calls onUnauthorized on 401', async () => {
    const original = globalThis.fetch;
    let signedOut = false;
    globalThis.fetch = async () => ({ ok: false, status: 401, json: async () => ({ error: 'SESSION_EXPIRED' }) });
    try {
      const r = await createApi({ apiBase: 'http://x/api', token: 't', onUnauthorized: () => { signedOut = true; } })('GET', '/me');
      assert.equal(r.status, 401);
      assert.equal(signedOut, true);
      assert.equal(errorText(r.data, 'x'), 'Your session has expired. Please log in again.');
    } finally {
      globalThis.fetch = original;
    }
  });

  it('keeps login refusals word for word (an offline wrong password is not "session expired")', () => {
    const offlineWrong = 'Wrong username or password. (The system is offline right now: only accounts that have logged in on this computer before can log in.)';
    assert.equal(errorText({ error: 'INVALID_CREDENTIALS', message: offlineWrong, offline: true }, 'x'), offlineWrong);
    const locked = 'Too many wrong passwords. For your security, please wait 15 minute(s) and try again.';
    assert.equal(errorText({ error: 'TOO_MANY_ATTEMPTS', message: locked }, 'x'), locked);
    const off = 'This account has been deactivated. Please ask an Owner or Admin.';
    assert.equal(errorText({ error: 'ACCOUNT_DEACTIVATED', message: off }, 'x'), off);
    assert.equal(errorText({ error: 'INVALID_CREDENTIALS' }, 'Login failed.'), 'Login failed.', 'no message: the fallback');
  });

  it('still maps real session errors to their friendly session messages', () => {
    for (const code of ['NOT_LOGGED_IN', 'SESSION_ENDED', 'SESSION_EXPIRED', 'INVALID_SESSION']) {
      assert.equal(errorText({ error: code, message: 'server text' }, 'x'), FRIENDLY_ERRORS[code]);
    }
    // A code-less token complaint (older servers) is still read as an expired session
    assert.equal(errorText({ message: 'invalid token' }, 'x'), 'Your session has expired. Please log in again.');
  });
});

describe('permissions only read what the server decided', () => {
  it('can() reads capabilities, never the role name', () => {
    assert.equal(can({ role: 'Owner', capabilities: [] }, 'approve_order'), false);
    assert.equal(can({ role: 'Staff', capabilities: ['approve_order'] }, 'approve_order'), true);
  });

  it('orderActions() defaults to nothing allowed', () => {
    assert.deepEqual(orderActions(null), { ...NO_ORDER_ACTIONS });
    // PB 11 / PB 12: quote and discount buttons stay hidden unless the server says otherwise
    assert.deepEqual([NO_ORDER_ACTIONS.generate_quote, NO_ORDER_ACTIONS.apply_discount, NO_ORDER_ACTIONS.print_quote], [false, false, false]);
    assert.equal(orderActions({ allowed_actions: { generate_quote: true } }).apply_discount, false);
    assert.equal(orderActions({ allowed_actions: { record_payment: true, max_payment: 250 } }).max_payment, 250);
    // PB 23 / PB 18: void and misprint buttons stay hidden unless the server says otherwise
    assert.deepEqual([NO_ORDER_ACTIONS.void_payment, NO_ORDER_ACTIONS.log_loss], [false, false]);
    assert.equal(orderActions({ allowed_actions: { record_payment: true } }).void_payment, false);
    assert.equal(orderActions({ allowed_actions: { void_payment: true } }).void_payment, true);
    // PB 23 / D2: archive buttons too
    assert.deepEqual([NO_ORDER_ACTIONS.archive_order, NO_ORDER_ACTIONS.restore_order], [false, false]);
    assert.equal(orderActions({ allowed_actions: { restore_order: true } }).archive_order, false);
  });

  it('roleHelp() is display text for server role names, empty for unknown ones', () => {
    assert.match(roleHelp('Production'), /View the inventory/); // Staff and Production swapped (migration 015)
    assert.match(roleHelp('Staff'), /Orders, payments/);
    assert.equal(roleHelp('Cashier'), '');
    assert.equal(roleHelp(''), '');
    assert.equal(roleHelp('toString'), '');
  });
});

describe('receipt', () => {
  it('escapes values and keeps the acknowledgement wording', () => {
    const html = receiptHtml({
      payment: { amount: 100, payment_type: '<b>Cash</b>', payment_date: '2026-11-12 08:00:00' },
      order: { tracking_no: 'XM-2026-0001', total_quote_amount: 200 },
      customer: { full_name: 'Ana' }
    });
    assert.match(html, /&lt;b&gt;Cash&lt;\/b&gt;/);
    assert.match(html, /not an Official Receipt/);
    assert.match(html, /Receipt number given when the system is back online/);
    assert.doesNotMatch(html, /BIR/);
  });
});
