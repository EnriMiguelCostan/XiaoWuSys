const jwt = require('jsonwebtoken');
const { isTokenRevoked } = require('../services/sessions');

// Verifies the "Authorization: Bearer <token>" header and attaches { user_id, role } as req.user.
// Tokens issued before an account was deactivated / had its password reset are rejected.
const verifyToken = (req, res, next) => {
  const authHeader = req.header('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'NOT_LOGGED_IN', message: 'Please log in to continue.' });
  }

  const token = authHeader.slice(7);
  try {
    const verified = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
    if (isTokenRevoked(verified)) {
      return res.status(401).json({ error: 'SESSION_ENDED', message: 'Your session has ended. Please log in again.' });
    }
    req.user = verified;
    next();
  } catch (error) {
    const expired = error && error.name === 'TokenExpiredError';
    res.status(401).json({
      error: expired ? 'SESSION_EXPIRED' : 'INVALID_SESSION',
      message: expired ? 'Your session has expired. Please log in again.' : 'Your session is not valid. Please log in again.'
    });
  }
};

// Role guard: verifyToken must run first. The role always comes from the verified token.
const requireRole = (allowedRoles) => (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ error: 'NOT_LOGGED_IN', message: 'Please log in to continue.' });
  }
  if (!allowedRoles.includes(req.user.role)) {
    return res.status(403).json({
      error: 'FORBIDDEN',
      message: 'Your account does not have permission to do this. Please ask an Owner or Admin.',
      role: req.user.role
    });
  }
  next();
};

module.exports = { verifyToken, requireRole };
