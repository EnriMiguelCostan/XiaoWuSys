// XiaoWuSys Web/ (Next.js) configuration. Batch M0.
//
// This app is UI only (N2): it serves pages, scripts and styles to browsers on the shop
// computer and on tablets over the shop Wi-Fi. It never talks to Neon or SQLite, never holds
// secrets, and never makes business decisions. The browser calls Express directly (N3).
import path from 'node:path';
import type { NextConfig } from 'next';

// N2: refuse to build or start with backend secrets in the environment. The Next.js process
// must never see them; if it does, something is wired wrong (e.g. Backend/.env loaded globally).
const FORBIDDEN_ENV = ['DATABASE_URL', 'PG_LISTEN_URL', 'JWT_SECRET', 'TEST_DATABASE_URL'];
const leaked = FORBIDDEN_ENV.filter((name) => process.env[name]);
if (leaked.length > 0) {
  throw new Error(
    `Web/ must not receive backend secrets (${leaked.join(', ')}). ` +
    'They belong to Backend/.env only. Unset them in this shell and try again.'
  );
}

// XiaoWuSys-main/: lets Turbopack and file tracing follow the link to ../shared/client-core.
const appRoot = path.join(__dirname, '..');

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,

  // Plain-JS package linked with "file:../shared/client-core"
  transpilePackages: ['@xiaowu/client-core'],
  turbopack: {
    root: appRoot,
    // Tailwind v4 runs as a Turbopack loader. Without this rule globals.css reaches the browser
    // unprocessed (no utilities, "Unknown at rule: @apply" at build time).
    rules: {
      '*.css': {
        loaders: [{ loader: '@tailwindcss/turbopack', options: { base: __dirname } }],
        as: '*.css',
      },
    },
  },
  outputFileTracingRoot: appRoot,

  // Runs offline on the shop computer: no remote image optimisation service.
  images: { unoptimized: true },

  // Same baseline headers Express sends. A Content-Security-Policy is added at cutover (M5),
  // once the connect-src for LAN addresses has been tested on real tablets.
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
        ],
      },
    ];
  },
};

export default nextConfig;
