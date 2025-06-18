const express = require('express');
const jwt = require('jsonwebtoken');
const User = require('../models/user'); // Adjust path as needed
const Wager = require('../models/wager'); // For stats
const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET || 'supersecret';

// --- MIDDLEWARE ---
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

// --- ROUTES ---

// 1. Admin Dashboard (GET)
router.get('/dashboard', adminAuth, (req, res) => {
  res.json({ 
    message: `Welcome admin ${req.user.username}`,
    endpoints: [
      'GET    /users',
      'PUT    /users/:id',
      'GET    /stats',
      'POST   /announcement'
    ]
  });
});

// 2. Get All Users (GET)
router.get('/users', adminAuth, async (req, res) => {
  try {
    const users = await User.find({}).select('-password');
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// 3. Update User (PUT)
router.put('/users/:id', adminAuth, async (req, res) => {
  try {
    const { balance, roles, isBanned } = req.body;
    
    const update = {};
    if (balance !== undefined) update.balance = balance;
    if (roles) update.roles = roles;
    if (isBanned !== undefined) update.isBanned = isBanned;

    const user = await User.findByIdAndUpdate(
      req.params.id,
      { $set: update },
      { new: true }
    ).select('-password');

    if (!user) return res.status(404).json({ error: 'User not found' });
    
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// 4. Get Stats (GET)
router.get('/stats', adminAuth, async (req, res) => {
  try {
    const [totalUsers, activeUsers, totalWagered] = await Promise.all([
      User.countDocuments(),
      User.countDocuments({ lastActive: { $gt: new Date(Date.now() - 24*60*60*1000) } }),
      Wager.aggregate([{ $group: { _id: null, total: { $sum: "$amount" } } }])
    ]);

    res.json({
      totalUsers,
      activeUsers,
      totalWagered: totalWagered[0]?.total || 0
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// 5. Post Announcement (POST)
router.post('/announcement', adminAuth, async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: 'Message required' });

    // In a real app, you'd save this to DB and broadcast via Socket.IO
    res.json({ success: true, message: 'Announcement would be sent to all users' });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
