const express = require('express');
const jwt = require('jsonwebtoken');
const User = require('./models/user'); // Adjust path as needed
const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET || 'supersecret';

// Middleware to verify admin
async function adminAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Missing token' });

  const token = authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Invalid token format' });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;

    const user = await User.findById(decoded.userId);
    if (!user || !user.roles.includes('admin')) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// Example protected admin route
router.get('/dashboard', adminAuth, (req, res) => {
  res.json({ message: `Welcome admin ${req.user.username}` });
});

module.exports = router;
