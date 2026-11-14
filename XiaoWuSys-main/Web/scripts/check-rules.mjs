#!/usr/bin/env node
// XiaoWuSys rules guard for Web/ and shared/client-core (Batch M0, steering §6).
//
// A tripwire, not a proof: it catches the common ways a UI starts "helping" with business rules,
// reaches for the database or the backend's secrets, or sneaks server code into Next.js.
// Reviewers and the per-screen audits (steering §3.4) remain the real check.
//
//   node scripts/check-rules.mjs            scan Web/ and ../shared/client-core
//   node scripts/check-rules.mjs --list     print the rules
//
// Escape hatch, for a line a reviewer has agreed is presentation only (e.g. a page count):
//   // rules-guard: allow <rule-id> <reason of at least three words>
// on the same line or the line above. Every use is listed in the output so the PR shows it.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CORE_ROOT = path.resolve(WEB_ROOT, '..', 'shared', 'client-core');

const CODE_EXT = /\.(?:[cm]?[jt]sx?)$/;
const TEXT_EXT = /\.(?:[cm]?[jt]sx?|css)$/;
const SKIP_DIRS = new Set(['node_modules', '.next', 'out', 'build', 'coverage', '.turbo', '.git']);

// ---------------------------------------------------------------------------------------------
// Rules. scope: which files a rule looks at. Paths are "Web/..." or "shared/client-core/...".
// ---------------------------------------------------------------------------------------------
const isWeb = (p) => p.startsWith('Web/');
const isCore = (p) => p.startsWith('shared/client-core/');
const isShadcnPrimitive = (p) => p.startsWith('Web/components/ui/');
const isGuardOrTest = (p) =>
  p.startsWith('Web/scripts/') || /(^|\/)(test|tests|__tests__)\//.test(p) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(p);

const MONEY_STOCK_FIELDS =
  '(?:total_quote_amount|total_paid|paid_to_date|remaining(?:_after)?|balance|overpaid_by|downpayment|max_payment|' +
  'quantity_available|quantity_reserved|quantity_needed|available|reserved|free_stock|stock_value|financial_cost|' +
  'unit_cost|amount|quote|paid)';

export const RULES = [
  {
    id: 'no-api-routes',
    why: 'Express is the only API (N2). Next.js must not have Route Handlers, pages/api, middleware or proxy.',
    pathCheck: (p) =>
      /^Web\/(?:src\/)?app\/(?:.*\/)?route\.[cm]?[jt]sx?$/.test(p) ||
      /^Web\/(?:src\/)?pages\//.test(p) ||
      /^Web\/(?:src\/)?(?:middleware|proxy)\.[cm]?[jt]sx?$/.test(p)
  },
  {
    id: 'no-server-actions',
    why: "Server Actions would run business code in Next.js (N2). Call Express with useApi() instead.",
    scope: (p) => isWeb(p),
    pattern: /^\s*['"]use server['"]/
  },
  {
    id: 'no-backend-imports',
    why: 'Web/ and client-core never touch Neon, SQLite, JWT signing/decoding or password hashing (N2/N4).',
    scope: (p) => isWeb(p) || isCore(p),
    pattern: new RegExp(
      String.raw`(?:from\s+|import\s*\(\s*|require\s*\(\s*|import\s+)['"]` +
      String.raw`(?:pg|pg-[\w-]+|postgres|sqlite3|better-sqlite3|node:sqlite|@neondatabase\/[\w-]+|` +
      String.raw`jsonwebtoken|jose|jwt-decode|bcrypt|bcryptjs|express|next\/server)['"]`
    )
  },
  {
    id: 'no-backend-env',
    why: 'Backend secrets belong to Backend/.env only. next.config.ts is the one place allowed to name them (to refuse them).',
    scope: (p) => (isWeb(p) || isCore(p)) && p !== 'Web/next.config.ts',
    pattern: /\b(?:DATABASE_URL|PG_LISTEN_URL|JWT_SECRET|TEST_DATABASE_URL)\b/
  },
  {
    id: 'no-token-decoding',
    why: "Never read the role or claims out of the JWT in the browser. Use capabilities from login / GET /api/auth/me.",
    scope: (p) => isWeb(p) || isCore(p),
    pattern: /\batob\s*\(|\bBuffer\.from\s*\([^)]*['"]base64/
  },
  {
    id: 'no-role-checks',
    why: "Show or hide with can(user, cap) or allowed_actions, never with the role name. The server checks every action.",
    scope: (p) => isWeb(p) || isCore(p),
    pattern: new RegExp(
      String.raw`\brole\s*[!=]==?|[!=]==?\s*[\w.?]*\brole\b|` +
      String.raw`(['"\x60])(?:Owner|Admin|Production|Staff)\1`
    )
  },
  {
    id: 'no-rule-math',
    why: 'Money, stock and status are decided by the server (totals, remaining, max_payment, stock_status, downpayment). Render them; do not compute them.',
    scope: (p) => (isWeb(p) || isCore(p)) && !isShadcnPrimitive(p),
    pattern: new RegExp(
      [
        String.raw`\b${MONEY_STOCK_FIELDS}\b\s*(?:[-+*/%]|[<>]=?)\s*[\w(.]`,      // remaining - x, paid >= quote
        String.raw`[\w)\]]\s*(?:[-+*/%]|[<>]=?)\s*(?:[\w.?]+\.)?${MONEY_STOCK_FIELDS}\b`, // x - quantity_reserved
        String.raw`\/\s*2(?![\d.])`,                                               // halves (downpayment)
        String.raw`\*\s*0?\.5(?!\d)`,
        String.raw`[*/]\s*100(?![\d.])`,                                           // centavos
        String.raw`\bMath\.(?:ceil|floor|round|trunc)\s*\(`
      ].join('|')
    )
  },
  {
    id: 'no-remote-assets',
    why: 'The shop must work with the internet down (N1): no Google Fonts or CDN files, at build or run time. Self-host them in public/.',
    ext: TEXT_EXT,
    scope: (p) => isWeb(p),
    pattern: /['"]next\/font\/google['"]|fonts\.(?:googleapis|gstatic)\.com|cdn\.jsdelivr\.net|unpkg\.com|cdnjs\.cloudflare\.com/
  },
  {
    id: 'polling-only-in-fallback-hook',
    why: 'Polling runs only while the socket is disconnected (master context §3). Use useFallbackPolling().',
    scope: (p) => isWeb(p) && !/^Web\/hooks\/use-?fallback-?polling\.tsx?$/i.test(p),
    pattern: /\bsetInterval\s*\(/
  },
  {
    id: 'one-socket',
    why: 'One Socket.io connection per tab, owned by SocketProvider. Subscribe with useSocketEvent().',
    scope: (p) => isWeb(p) && !/^Web\/components\/providers\/socket-provider\.tsx$/.test(p),
    pattern: /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"]socket\.io-client['"]/
  },
  {
    id: 'token-storage-in-session-only',
    why: 'The login token is read and written in one place (lib/session.ts), so logout and 401 handling stay correct.',
    scope: (p) => isWeb(p) && p !== 'Web/lib/session.ts',
    pattern: /\b(?:localStorage|sessionStorage)\b/
  },
  {
    id: 'client-core-stays-plain',
    why: 'client-core is shared with React Native: no React and no DOM (window.location in config.js is the only exception).',
    scope: (p) => isCore(p),
    pattern: /(?:from\s+|require\s*\(\s*)['"](?:react|react-dom|next(?:\/[\w-]+)?)['"]|\bdocument\.|\bnavigator\.|\bwindow\.(?!location\b)/
  }
];

// ---------------------------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------------------------

// Windows checkouts (core.autocrlf=true) end lines with \r\n. In a regex "." never matches
// "\r", so a "// comment" on a CRLF line was not stripped and its text was scanned as code.
// Every check works on \n-only text; line numbers are unchanged.
const toLf = (text) => String(text).replace(/\r\n?/g, '\n');

// Blank out comments but keep line numbers, so commented examples don't trip the rules.
// Deliberately simple: a "//" inside a string cuts the rest of that line, which only ever hides
// text, never invents a violation.
export const stripComments = (text) =>
  toLf(text)
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .split('\n')
    .map((line) => line.replace(/(^|[^:'"`\\])\/\/.*$/, '$1'))
    .join('\n');

const ALLOW = /rules-guard:\s*allow\s+([\w-]+)\s+(\S+(?:\s+\S+){2,})/;

const allowanceFor = (rawLines, index, ruleId) => {
  for (const i of [index, index - 1]) {
    const m = i >= 0 ? ALLOW.exec(rawLines[i] || '') : null;
    if (m && m[1] === ruleId) return m[2].trim();
  }
  return null;
};

// -> { violations: [{ file, line, rule, why, text }], allowances: [{ file, line, rule, reason }] }
export const checkSource = (relPath, text) => {
  const violations = [];
  const allowances = [];
  const file = relPath.split(path.sep).join('/');
  if (isGuardOrTest(file)) return { violations, allowances };

  for (const rule of RULES) {
    if (rule.pathCheck && rule.pathCheck(file)) {
      violations.push({ file, line: 1, rule: rule.id, why: rule.why, text: '(this file must not exist)' });
    }
  }
  if (!TEXT_EXT.test(file)) return { violations, allowances };

  const rawLines = toLf(text).split('\n');
  const codeLines = stripComments(text).split('\n');
  for (const rule of RULES) {
    if (!rule.pattern || (rule.scope && !rule.scope(file))) continue;
    if (!(rule.ext || CODE_EXT).test(file)) continue;
    codeLines.forEach((line, i) => {
      if (!rule.pattern.test(line)) return;
      const reason = allowanceFor(rawLines, i, rule.id);
      if (reason) allowances.push({ file, line: i + 1, rule: rule.id, reason });
      else violations.push({ file, line: i + 1, rule: rule.id, why: rule.why, text: rawLines[i].trim() });
    });
  }
  return { violations, allowances };
};

const walk = (dir, prefix, out) => {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name), `${prefix}${entry.name}/`, out);
    } else if (entry.isFile()) {
      out.push({ abs: path.join(dir, entry.name), rel: `${prefix}${entry.name}` });
    }
  }
  return out;
};

export const checkTree = ({ webRoot = WEB_ROOT, coreRoot = CORE_ROOT } = {}) => {
  const files = [...walk(webRoot, 'Web/', []), ...walk(coreRoot, 'shared/client-core/', [])];
  const result = { violations: [], allowances: [], scanned: files.length };
  for (const f of files) {
    const text = TEXT_EXT.test(f.rel) ? fs.readFileSync(f.abs, 'utf8') : '';
    const r = checkSource(f.rel, text);
    result.violations.push(...r.violations);
    result.allowances.push(...r.allowances);
  }
  return result;
};

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------
const main = () => {
  if (process.argv.includes('--list')) {
    for (const r of RULES) console.log(`${r.id}\n  ${r.why}\n`);
    return;
  }
  if (!fs.existsSync(CORE_ROOT)) {
    console.error(`rules-guard: ${CORE_ROOT} not found. Run from XiaoWuSys-main/Web.`);
    process.exit(2);
  }
  const { violations, allowances, scanned } = checkTree();
  for (const a of allowances) console.log(`allowed  ${a.file}:${a.line}  [${a.rule}] ${a.reason}`);
  if (violations.length === 0) {
    console.log(`rules-guard: OK (${scanned} files, ${allowances.length} reviewed exception(s))`);
    return;
  }
  for (const v of violations) {
    console.error(`\n✗ ${v.file}:${v.line}  [${v.rule}]\n    ${v.text}\n    ${v.why}`);
  }
  console.error(`\nrules-guard: ${violations.length} problem(s). Fix them, or if a line is presentation only, ` +
    'add "// rules-guard: allow <rule-id> <reason>" and get a reviewer to agree.');
  process.exit(1);
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
