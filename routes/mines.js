const express = require('express');
const router = express.Router();
const MinesGame = require('../models/mines');
const User = require('../models/user');

// Helper function to generate mines positions for 5x5 grid
const generateMines = (count) => {
  const positions = new Set();
  while (positions.size < count) {
    positions.add(Math.floor(Math.random() * 25)); // 0-24 for 5x5 grid
  }
  return Array.from(positions);
};

// Calculate multiplier based on revealed tiles and mines count
const calculateMultiplier = (revealedCount, minesCount) => {
  const totalTiles = 25;
  const safeTiles = totalTiles - minesCount;
  const remainingSafeTiles = safeTiles - revealedCount;
  
  // Base multiplier formula - adjust as needed for your game economy
  const multiplier = 1 + (minesCount / safeTiles) * (revealedCount / (remainingSafeTiles + 1));
  
  return parseFloat(multiplier.toFixed(2));
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
    user.balance = parseFloat((user.balance - amount).toFixed(2));
    await user.save();

    // Create new game
    const game = new MinesGame({
      userId: user._id,
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
    const game = await MinesGame.findById(gameId);
    const user = await User.findOne({ username });

    if (!game || !user) {
      return res.status(404).json({ error: 'Game or user not found' });
    }

    // Check game status
    if (game.status !== 'ongoing') {
      return res.status(400).json({ error: 'Game is not in progress' });
    }

    // Check if position is already revealed
    if (game.revealedPositions.includes(position)) {
      return res.status(400).json({ error: 'Position already revealed' });
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
    const game = await MinesGame.findById(gameId);
    const user = await User.findOne({ username });

    if (!game || !user) {
      return res.status(404).json({ error: 'Game or user not found' });
    }

    // Check game status
    if (game.status !== 'ongoing') {
      return res.status(400).json({ error: 'Game is not in progress' });
    }

    // Calculate winnings
    const winnings = parseFloat((game.betAmount * game.cashoutMultiplier).toFixed(2));
    user.balance = parseFloat((user.balance + winnings).toFixed(2));
    game.status = 'cashed_out';

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
