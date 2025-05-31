const express = require('express');
const router = express.Router();
const User = require('../models/User'); // Capital U, make sure path matches
const jwt = require('jsonwebtoken');

// Auth middleware to validate JWT token and set req.userId
function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Authorization header missing' });

  const token = authHeader.split(' ')[1]; // Bearer <token>
  if (!token) return res.status(401).json({ error: 'Token missing' });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.userId = decoded.userId;  // assumes token payload has userId field
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// Simulate roulette spin
function spinRoulette() {
  const number = Math.floor(Math.random() * 37); // 0-36
  const color = number === 0 ? 'green' : (number % 2 === 0 ? 'black' : 'red');
  return { number, color };
}

// POST /api/game/roulette
router.post('/game/roulette', authMiddleware, async (req, res) => {
  try {
    let { betAmount, betType, betValue } = req.body;

    if (!betAmount || !betType || betValue === undefined) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    betAmount = Number(betAmount);
    if (isNaN(betAmount) || betAmount <= 0) {
      return res.status(400).json({ error: 'Invalid bet amount' });
    }

    betType = String(betType).toLowerCase();
    if (typeof betValue !== 'number') {
      betValue = String(betValue).toLowerCase();
    }

    // Find user by ID from JWT
    const user = await User.findById(req.userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (betAmount > user.balance) {
      return res.status(400).json({ error: 'Insufficient balance' });
    }

    const spin = spinRoulette();

    let won = false;
    let payout = 0;

    if (betType === 'color') {
      if (betValue === spin.color) {
        won = true;
        payout = betAmount * 2;
      }
    } else if (betType === 'number') {
      const betNum = Number(betValue);
      if (!isNaN(betNum) && betNum === spin.number) {
        won = true;
        payout = betAmount * 35;
      }
    } else if (betType === 'oddeven') {
      if (spin.number !== 0) {
        if ((betValue === 'odd' && spin.number % 2 === 1) ||
            (betValue === 'even' && spin.number % 2 === 0)) {
          won = true;
          payout = betAmount * 2;
        }
      }
    } else {
      return res.status(400).json({ error: 'Invalid bet type' });
    }

    user.balance -= betAmount;
    if (won) user.balance += payout;

    // Keep recent games array max 5 entries
    user.recentGames = user.recentGames || [];
    user.recentGames.unshift({
      betType,
      betValue,
      betAmount,
      spinResult: spin,
      won,
      payout: won ? payout : 0,
      createdAt: new Date(),
    });
    if (user.recentGames.length > 5) user.recentGames.pop();

    await user.save();

    res.json({
      spinResult: spin,
      won,
      payout: won ? payout : 0,
      newBalance: user.balance,
      recentGames: user.recentGames,
    });
  } catch (error) {
    console.error('Roulette error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
