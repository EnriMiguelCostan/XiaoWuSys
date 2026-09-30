// ==========================================
// BOOTSTRAP ADMIN ACCOUNT (Audit fix C1)
// /api/auth/register now requires an existing Admin, so the FIRST Admin is created here,
// directly against the cloud database. Run from the Backend folder:
//
//   ADMIN_USERNAME=owner@xiaomei.ph ADMIN_PASSWORD='a-strong-password' npm run create-admin
//
// Credentials are read from environment variables (not CLI arguments) so they
// don't show up in the process list.
// ==========================================
require('dotenv').config();
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { Pool } = require('pg');

const username = (process.env.ADMIN_USERNAME || '').trim();
const password = process.env.ADMIN_PASSWORD || '';

const fail = (message) => {
  console.error(`✗ ${message}`);
  process.exit(1);
};

if (!process.env.DATABASE_URL) fail('DATABASE_URL is not set (check your .env).');
if (!username) fail('ADMIN_USERNAME is required.');
if (username.length > 100) fail('ADMIN_USERNAME must be at most 100 characters.');
if (password.length < 8) fail('ADMIN_PASSWORD must be at least 8 characters.');
if (Buffer.byteLength(password, 'utf8') > 72) fail('ADMIN_PASSWORD must be at most 72 bytes.');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false } // same settings as server.js (Neon)
});

(async () => {
  try {
    const password_hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      `INSERT INTO users (user_id, username, password_hash, role)
       VALUES ($1, $2, $3, 'Admin')
       RETURNING user_id, username, role`,
      [crypto.randomUUID(), username, password_hash]
    );
    console.log(`✓ Admin created: ${result.rows[0].username} (${result.rows[0].user_id})`);
  } catch (error) {
    if (error.code === '23505') fail(`User "${username}" already exists. No changes made.`);
    fail(`Could not create admin: ${error.message}`);
  } finally {
    await pool.end();
  }
})();
