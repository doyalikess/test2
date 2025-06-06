const express = require('express');
const router = express.Router();
const Game = require('../models/Game');
const User = require('../models/User');

// Helper function to generate mines positions
const generateMines = (count) => {
  const positions = new Set();
  while (positions.size < count) {
    positions.add(Math.floor(Math.random() * 25));
  }
  return Array.from(positions);
};

// Calculate multiplier based on revealed tiles and mines count
const calculateMultiplier = (revealedCount, minesCount) => {
  const riskFactor = minesCount / 25;
  const tilesLeft = 25 - minesCount - revealedCount;
  return (1 + (1 - riskFactor) * revealedCount / (tilesLeft + 1)).toFixed(2);
};

// Start a new mines game
router.post('/', async (req, res) => {
  try {
    const { username, amount, minesCount } = req.body;

    // Validate input
    if (!username || isNaN(amount) || amount <= 0 || isNaN(minesCount) || minesCount < 1 || minesCount > 24) {
      return res.status(400).json({ error: 'Invalid input parameters' });
    }

    // Find user and check balance
    const user = await User.findOne({ username });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (user.balance < amount) {
      return res.status(400).json({ error: 'Insufficient balance' });
    }

    // Deduct bet amount from user balance
    user.balance -= amount;
    await user.save();

    // Create new game
    const game = new Game({
      userId: user._id,
      username,
      gameType: 'mines',
      betAmount: amount,
      minesCount,
      minesPositions: generateMines(minesCount),
      status: 'ongoing',
      cashoutMultiplier: 1.00
    });

    await game.save();

    res.json({
      _id: game._id,
      minesCount,
      betAmount: amount,
      status: 'ongoing',
      cashoutMultiplier: 1.00
    });

  } catch (error) {
    console.error('Error starting mines game:', error);
    res.status(500).json({ error: 'Failed to start game' });
  }
});

// Reveal a tile in the mines game
router.post('/reveal', async (req, res) => {
  try {
    const { gameId, username, position } = req.body;

    // Validate input
    if (!gameId || !username || isNaN(position) || position < 0 || position > 24) {
      return res.status(400).json({ error: 'Invalid input parameters' });
    }

    // Find game and user
    const game = await Game.findById(gameId);
    const user = await User.findOne({ username });

    if (!game || !user) {
      return res.status(404).json({ error: 'Game or user not found' });
    }

    // Check game status
    if (game.status !== 'ongoing') {
      return res.status(400).json({ error: 'Game is not in progress' });
    }

    // Check if position is already revealed
    if (game.revealedPositions && game.revealedPositions.includes(position)) {
      return res.status(400).json({ error: 'Position already revealed' });
    }

    // Initialize revealedPositions if not exists
    if (!game.revealedPositions) {
      game.revealedPositions = [];
    }

    // Check if position is a mine
    if (game.minesPositions.includes(position)) {
      game.status = 'busted';
      await game.save();
      return res.json({
        hitMine: true,
        minePositions: game.minesPositions,
        gameOver: true
      });
    }

    // Add position to revealed positions
    game.revealedPositions.push(position);

    // Calculate new multiplier
    const revealedCount = game.revealedPositions.length;
    const multiplier = calculateMultiplier(revealedCount, game.minesCount);
    game.cashoutMultiplier = multiplier;

    await game.save();

    res.json({
      hitMine: false,
      multiplier,
      revealedPositions: game.revealedPositions
    });

  } catch (error) {
    console.error('Error revealing tile:', error);
    res.status(500).json({ error: 'Failed to reveal tile' });
  }
});

// Cash out from mines game
router.post('/cashout', async (req, res) => {
  try {
    const { gameId, username } = req.body;

    // Validate input
    if (!gameId || !username) {
      return res.status(400).json({ error: 'Invalid input parameters' });
    }

    // Find game and user
    const game = await Game.findById(gameId);
    const user = await User.findOne({ username });

    if (!game || !user) {
      return res.status(404).json({ error: 'Game or user not found' });
    }

    // Check game status
    if (game.status !== 'ongoing') {
      return res.status(400).json({ error: 'Game is not in progress' });
    }

    // Calculate winnings
    const winnings = game.betAmount * game.cashoutMultiplier;
    user.balance += winnings;
    game.status = 'cashed_out';
    game.winAmount = winnings;

    await Promise.all([user.save(), game.save()]);

    res.json({
      success: true,
      amount: winnings,
      multiplier: game.cashoutMultiplier
    });

  } catch (error) {
    console.error('Error cashing out:', error);
    res.status(500).json({ error: 'Failed to cash out' });
  }
});

module.exports = router;
