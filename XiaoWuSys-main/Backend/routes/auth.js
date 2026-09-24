const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const router = express.Router();

// ==========================================
// REGISTER USER (For backend setup only)
// ==========================================
router.post('/register', async (req, res) => {
  const { username, password, role } = req.body;
  const user_id = crypto.randomUUID();

  try {
    const saltRounds = 10;
    const password_hash = await bcrypt.hash(password, saltRounds);

    const newUser = await req.pgPool.query(
      `INSERT INTO users (user_id, username, password_hash, role) 
       VALUES ($1, $2, $3, $4) RETURNING user_id, username, role`,
      [user_id, username, password_hash, role]
    );

    res.status(201).json({ message: 'User created successfully', user: newUser.rows[0] });
  } catch (error) {
    console.error('❌ Registration Error:', error.message);
    res.status(500).json({ error: 'Failed to register user' });
  }
});

// ==========================================
// LOGIN USER
// ==========================================
router.post('/login', async (req, res) => {
  const { username, password } = req.body;

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

    console.log(`✅ User ${username} (${user.role}) logged in successfully!`);
    res.status(200).json({ message: 'Login successful', token, role: user.role });

  } catch (error) {
    console.error('❌ Login Error:', error.message);
    res.status(500).json({ error: 'Server error during login' });
  }
});

module.exports = router;