const express = require('express');
const router = express.Router();
const User = require('../models/user');
const jwt = require('jsonwebtoken');
const authMiddleware = require('../middleware/auth');

// Get crash game history
router.get('/history', authMiddleware, async (req, res) => {
  try {
    // In a real app, you'd fetch this from a database
    res.json({
      history: [
        { multiplier: 2.5, crashedAt: 1.8 },
        { multiplier: 3.2, crashedAt: 2.1 },
        // ... more history items
      ]
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Place a bet
router.post('/bet', authMiddleware, async (req, res) => {
  const { amount, targetMultiplier } = req.body;

  if (!amount || amount <= 0 || !targetMultiplier || targetMultiplier < 1.01) {
    return res.status(400).json({ error: 'Invalid bet parameters' });
  }

  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (user.balance < amount) {
      return res.status(400).json({ error: 'Insufficient balance' });
    }

    // Deduct balance immediately
    user.balance -= amount;
    await user.save();

    // In a real implementation, you'd create a game instance
    // and handle the game logic through Socket.IO

    res.json({
      message: 'Bet placed successfully',
      newBalance: user.balance,
      betId: `bet_${Date.now()}`,
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Cash out (handled via Socket.IO in reality)
router.post('/cashout', authMiddleware, async (req, res) => {
  // This would be handled via WebSockets in reality
  res.status(400).json({ error: 'Cashout must be handled via WebSocket connection' });
});

module.exports = router;
