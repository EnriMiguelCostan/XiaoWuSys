// Tests for the rules guard: every rule must catch its bad example (the mutation check for the
// guard itself) and leave the good one alone. Run: node --test scripts/
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkSource, checkTree, RULES } from './check-rules.mjs';

const rulesHit = (file, text) => checkSource(file, text).violations.map((v) => v.rule);

const CASES = [
  // [rule, file, bad source, good source]
  ['no-api-routes', 'Web/app/api/orders/route.ts', 'export const GET = () => null;', null],
  ['no-api-routes', 'Web/proxy.ts', 'export function proxy() {}', null],
  ['no-api-routes', 'Web/middleware.ts', 'export function middleware() {}', null],
  ['no-api-routes', 'Web/pages/api/x.ts', 'export default () => null;', null],
  ['no-server-actions', 'Web/app/orders/actions.ts', "'use server';\nexport async function pay() {}", "'use client';"],
  ['no-backend-imports', 'Web/lib/db.ts', "import { Pool } from 'pg';", "import { Button } from '@/components/ui/button';"],
  ['no-backend-imports', 'Web/lib/auth.ts', "import { jwtDecode } from 'jwt-decode';", "import { can } from '@xiaowu/client-core/permissions';"],
  ['no-backend-imports', 'Web/lib/x.ts', "const { NextResponse } = require('next/server');", "import Link from 'next/link';"],
  ['no-backend-env', 'Web/lib/x.ts', 'const url = process.env.DATABASE_URL;', 'const url = process.env.NEXT_PUBLIC_API_URL;'],
  ['no-token-decoding', 'Web/lib/x.ts', "const claims = JSON.parse(atob(token.split('.')[1]));", 'const user = session.user;'],
  ['no-role-checks', 'Web/app/x.tsx', "if (user.role === 'Owner') show();", "if (can(user, 'approve_order')) show();"],
  ['no-role-checks', 'Web/app/x.tsx', "const isBoss = 'Admin' == user?.role;", 'const label = roleLabel;'],
  ['no-role-checks', 'Web/app/x.tsx', "const ROLES = ['Owner', 'Admin'];", 'const roles = data.assignable_roles;'],
  ['no-rule-math', 'Web/app/x.tsx', 'const remaining = order.total_quote_amount - totals.total_paid;', 'const remaining = totals.remaining;'],
  ['no-rule-math', 'Web/app/x.tsx', 'const needed = quote / 2;', 'const needed = totals.downpayment.required;'],
  ['no-rule-math', 'Web/app/x.tsx', 'const free = item.quantity_available - item.quantity_reserved;', 'const free = item.free_to_use_label;'],
  ['no-rule-math', 'Web/app/x.tsx', 'const fullyPaid = paid >= quote;', "const fullyPaid = totals.payment_status === 'Fully Paid';"],
  ['no-rule-math', 'Web/app/x.tsx', 'const centavos = Math.round(amount * 100);', 'const shown = peso(amount);'],
  ['no-remote-assets', 'Web/app/layout.tsx', "import { Geist } from 'next/font/google';", "import './globals.css';"],
  ['no-remote-assets', 'Web/app/globals.css', "@import url('https://fonts.googleapis.com/css2?family=Inter');", '@import "tailwindcss";'],
  ['polling-only-in-fallback-hook', 'Web/app/x.tsx', 'setInterval(load, 30000);', 'useFallbackPolling(load, 30_000);'],
  ['one-socket', 'Web/app/x.tsx', "import { io } from 'socket.io-client';", "import { useSocketEvent } from '@/hooks/use-socket-event';"],
  ['token-storage-in-session-only', 'Web/app/x.tsx', "localStorage.getItem('xiaomei_token');", 'const { token } = useSession();'],
  ['client-core-stays-plain', 'shared/client-core/x.js', 'document.createElement("a");', 'export const x = 1;'],
  ['client-core-stays-plain', 'shared/client-core/x.js', "import { useState } from 'react';", "import { orderNumber } from './orders.js';"]
];

describe('every rule catches its bad example and passes its good one', () => {
  for (const [rule, file, bad, good] of CASES) {
    it(`${rule}: ${file}`, () => {
      assert.ok(rulesHit(file, bad).includes(rule), `expected ${rule} on: ${bad}`);
      if (good !== null) assert.ok(!rulesHit(file, good).includes(rule), `unexpected ${rule} on: ${good}`);
    });
  }

  it('covers every rule at least once', () => {
    const covered = new Set(CASES.map((c) => c[0]));
    for (const r of RULES) assert.ok(covered.has(r.id), `no test case for ${r.id}`);
  });
});

describe('scope and exceptions', () => {
  it('lets the allowed files do their one job', () => {
    assert.deepEqual(rulesHit('Web/hooks/use-fallback-polling.ts', 'const id = setInterval(fn, ms);'), []);
    assert.deepEqual(rulesHit('Web/components/providers/socket-provider.tsx', "import { io } from 'socket.io-client';"), []);
    assert.deepEqual(rulesHit('Web/lib/session.ts', "localStorage.getItem('xiaomei_token');"), []);
    assert.deepEqual(rulesHit('Web/next.config.ts', "const FORBIDDEN_ENV = ['DATABASE_URL'];"), []);
    assert.deepEqual(rulesHit('shared/client-core/config.js', 'const loc = window.location;'), []);
  });

  it('ignores comments', () => {
    assert.deepEqual(rulesHit('Web/app/x.tsx', "// never write: if (user.role === 'Owner')\nconst a = 1;"), []);
    assert.deepEqual(rulesHit('Web/app/x.tsx', "/* remaining = quote - paid */\nconst a = 1;"), []);
  });

  it('accepts a reviewed exception only with the rule id and a real reason', () => {
    const ok = checkSource('Web/app/x.tsx',
      '// rules-guard: allow no-rule-math page count for the table footer\nconst pages = Math.ceil(total / size);');
    assert.equal(ok.violations.length, 0);
    assert.equal(ok.allowances.length, 1);

    const noReason = checkSource('Web/app/x.tsx', 'const pages = Math.ceil(total / size); // rules-guard: allow no-rule-math');
    assert.equal(noReason.violations.length, 1);

    const wrongRule = checkSource('Web/app/x.tsx',
      "if (user.role === 'Owner') x(); // rules-guard: allow no-rule-math because I said so");
    assert.ok(wrongRule.violations.some((v) => v.rule === 'no-role-checks'));
  });

  it('does not apply code rules to CSS', () => {
    assert.deepEqual(rulesHit('Web/app/globals.css', '.half { width: calc(100% / 2); }'), []);
  });

  it('skips its own tests and shadcn primitives for the math heuristic', () => {
    assert.deepEqual(rulesHit('Web/scripts/check-rules.test.mjs', "user.role === 'Owner'"), []);
    assert.deepEqual(rulesHit('Web/components/ui/slider.tsx', 'const half = width / 2;'), []);
    assert.ok(rulesHit('Web/components/ui/button.tsx', "import { Pool } from 'pg';").includes('no-backend-imports'));
  });
});

describe('the real tree', () => {
  it('passes today', () => {
    const { violations } = checkTree();
    assert.deepEqual(violations, []);
  });
});
