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

// Improved multiplier calculation with safeguard against division by zero
const calculateMultiplier = (revealedCount, minesCount) => {
  const totalTiles = 25;
  const safeTiles = totalTiles - minesCount;
  const remainingSafeTiles = safeTiles - revealedCount;
  
  // Safeguard against division by zero
  if (remainingSafeTiles <= 0 || safeTiles <= 0) {
    return 1.0;
  }
  
  // Improved multiplier formula
  const riskFactor = minesCount / safeTiles;
  const progressFactor = revealedCount / remainingSafeTiles;
  const multiplier = 1 + (riskFactor * progressFactor * 0.9); // Adjusted for better game economy
  
  return parseFloat(multiplier.toFixed(2));
};

// Enhanced game start endpoint
router.post('/', async (req, res) => {
  try {
    const { username, amount, minesCount } = req.body;

    // Enhanced validation
    if (!username || typeof username !== 'string') {
      return res.status(400).json({ error: 'Valid username is required' });
    }
    
    const betAmount = parseFloat(amount);
    const numMines = parseInt(minesCount);
    
    if (isNaN(betAmount) || betAmount <= 0 || betAmount > 10000) {
      return res.status(400).json({ error: 'Bet amount must be between 0.01 and 10000' });
    }
    
    if (isNaN(numMines) || numMines < 1 || numMines > 24) {
      return res.status(400).json({ error: 'Mines count must be between 1 and 24' });
    }

    // Find user with enhanced error handling
    const user = await User.findOne({ username }).select('balance _id').lean();
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (user.balance < betAmount) {
      return res.status(400).json({ 
        error: 'Insufficient balance',
        currentBalance: user.balance,
        requiredAmount: betAmount
      });
    }

    // Transaction-style update
    const [updatedUser, game] = await Promise.all([
      User.findOneAndUpdate(
        { _id: user._id },
        { $inc: { balance: -betAmount } },
        { new: true }
      ),
      MinesGame.create({
        userId: user._id,
        betAmount,
        minesCount: numMines,
        minesPositions: generateMines(numMines),
        status: 'ongoing',
        cashoutMultiplier: 1.00
      })
    ]);

    res.json({
      success: true,
      gameId: game._id,
      minesCount: numMines,
      betAmount,
      newBalance: updatedUser.balance,
      status: 'ongoing',
      cashoutMultiplier: 1.00
    });

  } catch (error) {
    console.error('Error starting mines game:', error);
    res.status(500).json({ 
      error: 'Failed to start game',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Enhanced reveal endpoint
router.post('/reveal', async (req, res) => {
  try {
    const { gameId, username, position } = req.body;

    // Comprehensive validation
    if (!gameId || !mongoose.Types.ObjectId.isValid(gameId)) {
      return res.status(400).json({ error: 'Valid game ID is required' });
    }
    
    if (!username || typeof username !== 'string') {
      return res.status(400).json({ error: 'Valid username is required' });
    }
    
    const tilePosition = parseInt(position);
    if (isNaN(tilePosition) || tilePosition < 0 || tilePosition > 24) {
      return res.status(400).json({ error: 'Position must be between 0 and 24' });
    }

    // Find game and user with projection
    const [game, user] = await Promise.all([
      MinesGame.findById(gameId),
      User.findOne({ username }).select('_id').lean()
    ]);

    if (!game) {
      return res.status(404).json({ error: 'Game not found' });
    }
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Game state validation
    if (game.status !== 'ongoing') {
      return res.status(400).json({ 
        error: 'Game is not in progress',
        status: game.status
      });
    }

    if (game.revealedPositions.includes(tilePosition)) {
      return res.status(400).json({ error: 'Position already revealed' });
    }

    // Check for mine hit
    if (game.minesPositions.includes(tilePosition)) {
      await game.updateOne({ status: 'busted' });
      return res.json({
        success: false,
        hitMine: true,
        minePositions: game.minesPositions,
        gameOver: true,
        revealedCount: game.revealedPositions.length,
        finalMultiplier: game.cashoutMultiplier
      });
    }

    // Update game state
    const revealedPositions = [...game.revealedPositions, tilePosition];
    const multiplier = calculateMultiplier(revealedPositions.length, game.minesCount);
    
    await game.updateOne({
      $set: {
        revealedPositions,
        cashoutMultiplier: multiplier
      }
    });

    res.json({
      success: true,
      hitMine: false,
      multiplier,
      revealedPositions,
      remainingSafeTiles: 25 - game.minesCount - revealedPositions.length
    });

  } catch (error) {
    console.error('Error revealing tile:', error);
    res.status(500).json({ 
      error: 'Failed to reveal tile',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Enhanced cashout endpoint
router.post('/cashout', async (req, res) => {
  try {
    const { gameId, username } = req.body;

    // Validation
    if (!gameId || !mongoose.Types.ObjectId.isValid(gameId)) {
      return res.status(400).json({ error: 'Valid game ID is required' });
    }
    
    if (!username || typeof username !== 'string') {
      return res.status(400).json({ error: 'Valid username is required' });
    }

    // Transaction for cashout
    const session = await mongoose.startSession();
    session.startTransaction();
    
    try {
      const [game, user] = await Promise.all([
        MinesGame.findById(gameId).session(session),
        User.findOne({ username }).session(session)
      ]);

      if (!game || !user) {
        throw new Error('Game or user not found');
      }

      if (game.status !== 'ongoing') {
        throw new Error('Game is not in progress');
      }

      // Calculate winnings
      const winnings = parseFloat((game.betAmount * game.cashoutMultiplier).toFixed(2));
      
      // Update records
      await Promise.all([
        User.updateOne(
          { _id: user._id },
          { $inc: { balance: winnings } }
        ).session(session),
        MinesGame.updateOne(
          { _id: game._id },
          { status: 'cashed_out' }
        ).session(session)
      ]);

      await session.commitTransaction();
      
      // Get updated balance
      const updatedUser = await User.findById(user._id).select('balance').lean();
      
      res.json({
        success: true,
        amount: winnings,
        multiplier: game.cashoutMultiplier,
        newBalance: updatedUser.balance
      });

    } catch (error) {
      await session.abortTransaction();
      throw error;
    } finally {
      session.endSession();
    }

  } catch (error) {
    console.error('Error cashing out:', error);
    res.status(500).json({ 
      error: 'Failed to cash out',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// New endpoint: Get game status
router.get('/:gameId', async (req, res) => {
  try {
    const game = await MinesGame.findById(req.params.gameId)
      .select('status betAmount minesCount revealedPositions cashoutMultiplier')
      .lean();
      
    if (!game) {
      return res.status(404).json({ error: 'Game not found' });
    }
    
    res.json({
      status: game.status,
      betAmount: game.betAmount,
      minesCount: game.minesCount,
      revealedCount: game.revealedPositions.length,
      currentMultiplier: game.cashoutMultiplier,
      isActive: game.status === 'ongoing'
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get game status' });
  }
});

module.exports = router;
