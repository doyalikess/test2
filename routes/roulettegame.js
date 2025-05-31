const express = require('express');
const router = express.Router();

// Example roulette game logic route
// You can expand this to your full roulette implementation

// POST /api/roulette/play
router.post('/play', (req, res) => {
  // Get bet info from req.body (e.g., bet amount, bet type)
  const { betAmount, betType } = req.body;

  if (!betAmount || betAmount <= 0) {
    return res.status(400).json({ error: 'Invalid bet amount' });
  }

  // Example: simple roulette spin logic
  const spinResult = Math.floor(Math.random() * 37); // 0-36

  // Example payout: if betType === spinResult number, win 35x
  let payout = 0;
  if (betType === spinResult) {
    payout = betAmount * 35;
  }

  res.json({
    spinResult,
    payout,
    message: payout > 0 ? 'You won!' : 'You lost!',
  });
});

module.exports = router;
