const jwt = require('jsonwebtoken');

const verifyToken = (req, res, next) => {
  // 1. Look for the token in the headers
  const authHeader = req.header('Authorization');
  
  // 2. Check if the header exists and is formatted correctly ("Bearer <token>")
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Access denied. No token provided.' });
  }

  // 3. Extract just the token string
  const token = authHeader.split(' ')[1];

  try {
    // 4. Verify the token using your secret key from the .env file
    const verified = jwt.verify(token, process.env.JWT_SECRET);
    
    // 5. Attach the decoded user data (user_id, role) to the request object
    req.user = verified;
    
    // 6. Grant access to the route
    next();
  } catch (error) {
    console.error('❌ Token Verification Error:', error.message);
    res.status(401).json({ error: 'Invalid or expired token.' });
  }
};

// ==========================================
// THE ROLE GUARD
// ==========================================
const requireRole = (allowedRoles) => {
  return (req, res, next) => {
    // 1. Check if a user exists (verifyToken must run first!)
    if (!req.user) {
      return res.status(401).json({ error: 'Access denied. Please log in.' });
    }

    // 2. Check if the user's role is inside the allowed list
    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ 
        error: `Forbidden. Your role (${req.user.role}) does not have permission for this action.` 
      });
    }

    // 3. Role is approved, grant access!
    next();
  };
};

// Export BOTH functions in an object
module.exports = { verifyToken, requireRole };