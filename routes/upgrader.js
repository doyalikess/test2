// routes/upgrader.js

const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth'); // adjust if located elsewhere
const User = require('../models/user'); // adjust path if necessary

// Example upgrader game route
router.post('/play', authMiddleware, async (req, res) => {
  const { itemValue, multiplier } = req.body;

  if (!itemValue || !multiplier || itemValue <= 0 || multiplier <= 1) {
    return res.status(400).json({ error: 'Invalid input' });
  }

  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (user.balance < itemValue) {
      return res.status(400).json({ error: 'Insufficient balance' });
    }

    // Deduct balance
    user.balance -= itemValue;

    // Win logic (50% chance adjusted by multiplier)
    const winChance = 100 / multiplier;
    const roll = Math.random() * 100;
    const win = roll < winChance;

    if (win) {
      const winAmount = itemValue * multiplier;
      user.balance += winAmount;
    }

    await user.save();

    res.json({
      win,
      newBalance: user.balance,
      result: win ? 'You won!' : 'You lost!',
      chance: winChance.toFixed(2),
      roll: roll.toFixed(2),
    });
  } catch (err) {
    console.error('Upgrader error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
