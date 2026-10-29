// Starts the server in DEMO mode: offline-only, on demo_cache.db (see scripts/seedDemo.js).
// Order approval, status changes and permanent delete need the cloud, so the demo shows the
// "needs the internet" message for those; everything else works.
const { spawn } = require('child_process');
const path = require('path');

const env = {
  ...process.env,
  CLOUD_DISABLED: 'true',
  LOCAL_DB_PATH: 'demo_cache.db',
  JWT_SECRET: process.env.JWT_SECRET || 'demo-only-secret-change-me-0123456789abcdef'
};
const child = spawn(process.execPath, [path.resolve(__dirname, '..', 'server.js')], { env, stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 0));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
