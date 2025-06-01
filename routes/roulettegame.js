const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');

// ✅ Fix: Prevent OverwriteModelError
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');

const UserSchema = new mongoose.Schema({
  username: { type: String, unique: true, required: true },
  passwordHash: { type: String, required: true },
  balance: { type: Number, default: 0 },
  recentGames: {
    type: [Object],
    default: [],
  },
});

// Set password
UserSchema.methods.setPassword = async function (password) {
  this.passwordHash = await bcrypt.hash(password, 10);
};

// Validate password
UserSchema.methods.validatePassword = async function (password) {
  return await bcrypt.compare(password, this.passwordHash);
};

// ✅ Reuse model if already registered
const User = mongoose.models.User || mongoose.model('User', UserSchema);

// 🔐 JWT Auth middleware
function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Authorization header missing' });

  const token = authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Token missing' });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.userId = decoded.userId;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// 🎰 Simulate roulette spin
function spinRoulette() {
  const number = Math.floor(Math.random() * 37); // 0-36
  const color = number === 0 ? 'green' : (number % 2 === 0 ? 'black' : 'red');
  return { number, color };
}

// 🎯 POST /api/game/roulette
router.post('/roulette', authMiddleware, async (req, res) => {
  try {
    let { betAmount, bets } = req.body;

    // Validate input
    if (!betAmount || !bets || !Array.isArray(bets) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    betAmount = Number(betAmount);
    if (isNaN(betAmount) || betAmount <= 0) {
      return res.status(400).json({ error: 'Invalid bet amount' });
    }

    // Validate each bet in the bets array
    for (const bet of bets) {
      if (!bet.type || bet.value === undefined) {
        return res.status(400).json({ error: 'Each bet must have type and value' });
      }
      
      bet.type = String(bet.type).toLowerCase();
      if (typeof bet.value !== 'number') {
        bet.value = String(bet.value).toLowerCase();
      }
    }

    const user = await User.findById(req.userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Calculate total bet amount (betAmount per bet)
    const totalBetAmount = betAmount * bets.length;
    if (totalBetAmount > user.balance) {
      return res.status(400).json({ error: 'Insufficient balance' });
    }

    const spin = spinRoulette();
    let totalPayout = 0;
    const betResults = [];

    // Process each bet
    for (const bet of bets) {
      let won = false;
      let payout = 0;

      if (bet.type === 'color') {
        if (bet.value === spin.color) {
          won = true;
          payout = betAmount * (bet.value === 'green' ? 35 : 2);
        }
      } else if (bet.type === 'number') {
        const betNum = Number(bet.value);
        if (!isNaN(betNum) && betNum === spin.number) {
          won = true;
          payout = betAmount * 35;
        }
      } else if (bet.type === 'oddeven') {
        if (spin.number !== 0) {
          if ((bet.value === 'odd' && spin.number % 2 === 1) ||
              (bet.value === 'even' && spin.number % 2 === 0)) {
            won = true;
            payout = betAmount * 2;
          }
        }
      } else {
        return res.status(400).json({ error: `Invalid bet type: ${bet.type}` });
      }

      if (won) {
        totalPayout += payout;
      }

      betResults.push({
        betType: bet.type,
        betValue: bet.value,
        betAmount,
        won,
        payout: won ? payout : 0
      });
    }

    // Update user balance
    user.balance -= totalBetAmount;
    if (totalPayout > 0) {
      user.balance += totalPayout;
    }

    // Record game history
    user.recentGames = user.recentGames || [];
    user.recentGames.unshift({
      bets: betResults,
      totalBetAmount,
      spinResult: spin,
      totalPayout,
      createdAt: new Date(),
    });
    if (user.recentGames.length > 5) user.recentGames.pop();

    await user.save();

    res.json({
      spinResult: spin,
      bets: betResults,
      totalBetAmount,
      totalPayout,
      newBalance: user.balance,
      recentGames: user.recentGames,
    });
  } catch (error) {
    console.error('Roulette error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
