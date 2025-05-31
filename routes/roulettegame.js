const express = require('express');
const router = express.Router();

// Example user data and balance (replace with your real user logic/db)
let users = {
  'user1': { username: 'user1', balance: 1000, recentGames: [] },
  // Add more users as needed
};

// Helper: simulate roulette spin
function spinRoulette() {
  const number = Math.floor(Math.random() * 37); // 0-36
  const color = number === 0 ? 'green' : (number % 2 === 0 ? 'black' : 'red');
  return { number, color };
}

// POST /roulette
router.post('/roulette', (req, res) => {
  let { username, betAmount, betType, betValue } = req.body;

  // Basic input validation
  if (!username || !betAmount || !betType || betValue === undefined) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  // Convert betAmount to number
  betAmount = Number(betAmount);
  if (isNaN(betAmount) || betAmount <= 0) {
    return res.status(400).json({ error: 'Invalid bet amount' });
  }

  // Normalize betType and betValue to string lowercase for consistent comparison
  betType = String(betType).toLowerCase();
  if (typeof betValue === 'number') {
    // keep as number for 'number' betType
  } else {
    betValue = String(betValue).toLowerCase();
  }

  const user = users[username];  // Use username as key
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

  // Update user balance
  user.balance -= betAmount;
  if (won) {
    user.balance += payout;
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
