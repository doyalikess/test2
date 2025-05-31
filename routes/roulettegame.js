const express = require('express');
const router = express.Router();

// Example user data and balance (replace with your real user logic/db)
let users = {
  'user1': { id: 'user1', balance: 1000, recentGames: [] }
};

// Helper: simulate roulette spin
function spinRoulette() {
  // Roulette numbers 0-36 (European style)
  const number = Math.floor(Math.random() * 37);
  const color = number === 0 ? 'green' : (number % 2 === 0 ? 'black' : 'red');
  return { number, color };
}

// POST /roulette
router.post('/roulette', (req, res) => {
  const { userId, betAmount, betType, betValue } = req.body;

  // Validate inputs
  if (!userId || !betAmount || !betType || betValue === undefined) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const user = users[userId];
  if (!user) return res.status(404).json({ error: 'User not found' });

  if (betAmount <= 0) return res.status(400).json({ error: 'Invalid bet amount' });
  if (betAmount > user.balance) return res.status(400).json({ error: 'Insufficient balance' });

  const spin = spinRoulette();

  // Calculate payout
  // For simplicity:
  // - "color" bet pays 2x (betType === 'color', betValue: 'red'/'black')
  // - "number" bet pays 35x (betType === 'number', betValue: 0-36)
  // - "oddEven" bet pays 2x (betType === 'oddEven', betValue: 'odd'/'even')

  let won = false;
  let payout = 0;

  if (betType === 'color') {
    if (betValue === spin.color) {
      won = true;
      payout = betAmount * 2;
    }
  } else if (betType === 'number') {
    if (betValue === spin.number) {
      won = true;
      payout = betAmount * 35;
    }
  } else if (betType === 'oddEven') {
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

  // Update user balance
  if (won) {
    user.balance += payout - betAmount; // win payout minus original bet (bet was deducted)
  } else {
    user.balance -= betAmount;
  }

  // Save recent games (max 5)
  user.recentGames.unshift({
    betType,
    betValue,
    betAmount,
    spinResult: spin,
    won,
    payout: won ? payout : 0,
  });
  if (user.recentGames.length > 5) user.recentGames.pop();

  res.json({
    spinResult: spin,
    won,
    payout: won ? payout : 0,
    newBalance: user.balance,
    recentGames: user.recentGames,
  });
});

module.exports = router;
