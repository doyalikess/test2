const express = require('express');
const router = express.Router();
const User = require('../models/User');
const { authMiddleware } = require('./auth');

router.post('/coinflip', authMiddleware, async (req, res) => {
  const { betAmount, choice } = req.body; // choice = "heads" or "tails"

  if (!betAmount || isNaN(betAmount) || betAmount <= 0) {
    return res.status(400).json({ error: 'Valid betAmount required' });
  }
  if (choice !== 'heads' && choice !== 'tails') {
    return res.status(400).json({ error: 'Choice must be heads or tails' });
  }

  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (user.balance < betAmount) {
      return res.status(400).json({ error: 'Insufficient balance' });
    }

    // Deduct bet amount first
    user.balance -= betAmount;

    // Flip coin
    const flip = Math.random() < 0.5 ? 'heads' : 'tails';

    let result;
    if (flip === choice) {
      // User wins double the bet (bet returned + winnings)
      user.balance += betAmount * 2;
      result = 'win';
    } else {
      result = 'lose';
    }

    await user.save();

    res.json({
      result,
      flip,
      newBalance: user.balance,
      betAmount,
      choice,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
