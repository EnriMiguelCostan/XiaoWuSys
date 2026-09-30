const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const router = express.Router();
const { verifyToken, requireRole } = require('../middleware/authMiddleware');
const { isConnectionError } = require('../utils/dbErrors');

// Audit fix C1: roles are an allow-list enforced on the server, never trusted from the client
const ALLOWED_ROLES = ['Admin', 'Production', 'Staff'];
const MAX_USERNAME_LENGTH = 100; // matches users.username VARCHAR(100)
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_BYTES = 72;   // bcrypt silently ignores anything beyond 72 bytes

// ==========================================
// REGISTER USER (Admin only - Audit fix C1)
// Public self-registration is disabled: only a logged-in Admin can create accounts.
// Bootstrap the first Admin with:  npm run create-admin
// ==========================================
router.post('/register', verifyToken, requireRole(['Admin']), async (req, res) => {
  const { username, password, role } = req.body || {};

  if (typeof username !== 'string' || username.trim() === '') {
    return res.status(400).json({ error: 'Username is required.' });
  }
  if (username.trim().length > MAX_USERNAME_LENGTH) {
    return res.status(400).json({ error: `Username must be at most ${MAX_USERNAME_LENGTH} characters.` });
  }
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` });
  }
  if (Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES) {
    return res.status(400).json({ error: `Password must be at most ${MAX_PASSWORD_BYTES} bytes.` });
  }
  if (!ALLOWED_ROLES.includes(role)) {
    return res.status(400).json({ error: `Role must be one of: ${ALLOWED_ROLES.join(', ')}.` });
  }

  const user_id = crypto.randomUUID();

  try {
    const saltRounds = 10;
    const password_hash = await bcrypt.hash(password, saltRounds);

    const newUser = await req.pgPool.query(
      `INSERT INTO users (user_id, username, password_hash, role) 
       VALUES ($1, $2, $3, $4) RETURNING user_id, username, role`,
      [user_id, username.trim(), password_hash, role]
    );

    console.log(`👤 Admin ${req.user.user_id} created user ${newUser.rows[0].username} (${role})`);
    res.status(201).json({ message: 'User created successfully', user: newUser.rows[0] });
  } catch (error) {
    console.error('✗ Registration Error:', error.message);
    if (error.code === '23505') {
      return res.status(409).json({ error: 'Username already exists.' });
    }
    if (isConnectionError(error)) {
      return res.status(503).json({ error: 'Cloud database unreachable. Users can only be created while online.' });
    }
    res.status(500).json({ error: 'Failed to register user' });
  }
});

// ==========================================
// LOGIN USER
// ==========================================
router.post('/login', async (req, res) => {
  const { username, password } = req.body || {};

  if (typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'Username and password are required.' });
  }

  try {
    const userResult = await req.pgPool.query('SELECT * FROM users WHERE username = $1', [username]);
    
    if (userResult.rowCount === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = userResult.rows[0];
    const validPassword = await bcrypt.compare(password, user.password_hash);
    
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Generate the Digital ID Card (Token)
    const token = jwt.sign(
      { user_id: user.user_id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '8h' }
    );

    console.log(`✓ User ${username} (${user.role}) logged in successfully!`);
    res.status(200).json({ message: 'Login successful', token, role: user.role });

  } catch (error) {
    console.error('✗ Login Error:', error.message);
    res.status(500).json({ error: 'Server error during login' });
  }
});

module.exports = router;
