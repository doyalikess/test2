// routes/upgrader.js
const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth'); // Adjust if in a different location
const User = require('../models/user'); // Adjust path if necessary

// POST /api/upgrader — Upgrader game endpoint with 8% house edge
router.post('/', authMiddleware, async (req, res) => {
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

    // Deduct the item value from balance
    user.balance -= itemValue;

    // Calculate base win chance (without house edge)
    const baseWinChance = 100 / multiplier;
    
    // Apply 8% house edge (reduce win chance by 8%)
    const winChanceWithHouseEdge = baseWinChance * (1 - 0.08); // 8% less chance to win
    
    const roll = Math.random() * 100;
    const win = roll < winChanceWithHouseEdge;

    if (win) {
      const winAmount = itemValue * multiplier;
      user.balance += winAmount;
    }

    await user.save();

    res.json({
      win,
      newBalance: user.balance,
      result: win ? 'You won!' : 'You lost!',
      chance: winChanceWithHouseEdge.toFixed(2),
      roll: roll.toFixed(2),
    });
  } catch (err) {
    console.error('Upgrader error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
