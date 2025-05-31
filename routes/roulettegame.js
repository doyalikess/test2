const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');

// Define User schema and model
const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  balance: { type: Number, default: 1000 },
  recentGames: [
    {
      betType: String,
      betValue: mongoose.Schema.Types.Mixed,  // number or string
      betAmount: Number,
      spinResult: {
        number: Number,
        color: String,
      },
      won: Boolean,
      payout: Number,
      createdAt: { type: Date, default: Date.now },
    },
  ],
});

const User = mongoose.model('User', userSchema);

// Helper: simulate roulette spin
function spinRoulette() {
  const number = Math.floor(Math.random() * 37); // 0-36
  const color = number === 0 ? 'green' : (number % 2 === 0 ? 'black' : 'red');
  return { number, color };
}

// POST /game/roulette
router.post('/game/roulette', async (req, res) => {
  try {
    let { username, betAmount, betType, betValue } = req.body;

    if (!username || !betAmount || !betType || betValue === undefined) {
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

    // Find user by username in MongoDB
    const user = await User.findOne({ username });
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

    // Update user balance and recentGames in MongoDB
    user.balance -= betAmount;
    if (won) user.balance += payout;

    user.recentGames.unshift({
      betType,
      betValue,
      betAmount,
      spinResult: spin,
      won,
      payout: won ? payout : 0,
      createdAt: new Date(),
    });

    // Keep only last 5 games
    if (user.recentGames.length > 5) {
      user.recentGames = user.recentGames.slice(0, 5);
    }

    await user.save();

    res.json({
      spinResult: spin,
      won,
      payout: won ? payout : 0,
      newBalance: user.balance,
      recentGames: user.recentGames,
    });

  } catch (err) {
    console.error('Error in /game/roulette:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
