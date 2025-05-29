// routes/coinflip.js
const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const crypto = require('crypto');

// Auth middleware
const authenticate = async (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ message: 'No token provided' });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(403).json({ message: 'Invalid token' });
  }
};

// Fair outcome generator
function generateOutcome(seed) {
  const hash = crypto.createHash('sha256').update(seed).digest('hex');
  const result = parseInt(hash.slice(0, 8), 16);
  return result % 100 < 47.5 ? 'heads' : 'tails'; // 5% house edge
}

// POST /api/game/coinflip
router.post('/coinflip', authenticate, async (req, res) => {
  const { amount, choice } = req.body;
  const username = req.user.username;

  if (!amount || amount <= 0 || !['heads', 'tails'].includes(choice)) {
    return res.status(400).json({ message: 'Invalid bet' });
  }

  try {
    const user = await User.findOne({ username });
    if (!user) return res.status(404).json({ message: 'User not found' });
    if (user.balance < amount) return res.status(400).json({ message: 'Insufficient balance' });

    const serverSeed = crypto.randomBytes(16).toString('hex');
    const outcome = generateOutcome(serverSeed);
    const win = outcome === choice;

    const houseEdge = 0.05;
    const payoutMultiplier = (1 - houseEdge) * 2;

    if (win) {
      user.balance += amount * (payoutMultiplier - 1);
    } else {
      user.balance -= amount;
    }

    await user.save();

    res.json({
      outcome,
      win,
      newBalance: user.balance,
      serverSeed,
      hash: crypto.createHash('sha256').update(serverSeed).digest('hex')
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
