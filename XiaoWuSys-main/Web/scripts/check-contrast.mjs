// WCAG 2.1 AA contrast check for the colour tokens in app/state-tokens.css and app/globals.css
// (HCI pass: docs/hci-design-audit.md). Converts oklch to sRGB, blends translucent badge
// backgrounds the way browsers do, and checks, in light and dark mode:
//   - 4.5:1 for text (SC 1.4.3): state colours on page, card, muted and their own badge tint,
//     muted text, body text, button text;
//   - 3:1 for control boundaries and the focus ring (SC 1.4.11).
// Run after changing a colour token:  node scripts/check-contrast.mjs   (exit code 1 on a failure)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const W = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'app') + path.sep;
const css = fs.readFileSync(W + 'state-tokens.css', 'utf8') + fs.readFileSync(W + 'globals.css', 'utf8');

const block = (sel) => {
  const out = {};
  const re = new RegExp(`${sel.replace('.', '\\.')}\\s*\\{([^}]*)\\}`, 'g');
  let m;
  while ((m = re.exec(css))) {
    for (const line of m[1].split(';')) {
      const k = /--([\w-]+):\s*oklch\(([^)]*)\)/.exec(line);
      if (k) out[k[1]] = k[2];
    }
  }
  return out;
};
const parse = (v) => {
  const [lch, a] = v.split('/');
  const [L, C, H] = lch.trim().split(/\s+/).map(Number);
  return { L, C, H: H || 0, alpha: a ? parseFloat(a) / (a.includes('%') ? 100 : 1) : 1 };
};
const toLinear = ({ L, C, H }) => {
  const a = C * Math.cos((H * Math.PI) / 180);
  const b = C * Math.sin((H * Math.PI) / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s
  ].map((x) => Math.min(1, Math.max(0, x)));
};
// Blending is done in gamma-encoded sRGB, as browsers do
const enc = (x) => (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055);
const dec = (x) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4);
const over = (fg, alpha, bg) => fg.map((c, i) => dec(enc(c) * alpha + enc(bg[i]) * (1 - alpha)));
const lum = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const ratio = (x, y) => { const [a, b] = [lum(x), lum(y)].sort((p, q) => q - p); return (a + 0.05) / (b + 0.05); };

let fails = 0;
for (const [mode, sel] of [['light', ':root'], ['dark', '.dark']]) {
  const t = block(sel);
  const col = (k) => toLinear(parse(t[k]));
  const surfaces = { background: col('background'), card: col('card'), muted: col('muted') };
  const rows = [];
  const check = (name, fg, bg, min) => {
    const r = ratio(fg, bg);
    if (r < min) fails++;
    rows.push(`${r < min ? 'FAIL' : 'ok  '} ${r.toFixed(2).padStart(5)}:1 (min ${min}) ${name}`);
  };
  for (const tone of ['success', 'warning', 'danger', 'info']) {
    for (const [s, bg] of Object.entries(surfaces)) check(`text-${tone} on ${s}`, col(tone), bg, 4.5);
    check(`text-${tone} on badge bg-${tone}/10 over card`, col(tone), over(col(tone), 0.1, surfaces.card), 4.5);
  }
  for (const [s, bg] of Object.entries(surfaces)) check(`muted-foreground on ${s}`, col('muted-foreground'), bg, 4.5);
  check('foreground on background', col('foreground'), surfaces.background, 4.5);
  check('primary-foreground on primary (buttons)', col('primary-foreground'), col('primary'), 4.5);
  check('text-destructive on destructive/10 over card (destructive buttons, badges)', col('destructive'), over(col('destructive'), mode === 'light' ? 0.1 : 0.2, surfaces.card), 4.5);
  const input = parse(t.input);
  for (const [s, bg] of Object.entries({ background: surfaces.background, card: surfaces.card })) {
    check(`input border on ${s} (1.4.11)`, over(toLinear(input), input.alpha, bg), bg, 3);
  }
  check('focus ring on background (1.4.11)', col('ring'), surfaces.background, 3);
  console.log(`--- ${mode}\n${rows.join('\n')}`);
}
console.log(fails ? `\n${fails} pair(s) below the minimum` : '\nall pairs pass');
process.exitCode = fails ? 1 : 0;
