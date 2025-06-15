const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();
const User = require('../models/user');
const Wager = require('../models/wager');
const { processInstantReferralReward } = require('./referral');
const ReferralReward = require('../models/referralReward');

// Auth middleware - you'll need to import this from your main file or auth module
function authMiddleware(req, res, next) {
  if (!req.userId) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  next();
}

// Get user's wager history
router.get('/history', authMiddleware, async (req, res) => {
  try {
    // Pagination parameters
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;
    
    // Game type filter
    const gameType = req.query.gameType;
    const filter = { userId: req.userId };
    
    if (gameType && ['coinflip', 'jackpot', 'mines', 'limbo', 'upgrader'].includes(gameType)) {
      filter.gameType = gameType;
    }

    // Get wager history
    const wagers = await Wager.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    // Get total count for pagination
    const total = await Wager.countDocuments(filter);

    res.json({
      wagers,
      pagination: {
        total,
        page,
        limit,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (err) {
    console.error('Error getting wager history:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get user's wagering stats
router.get('/stats', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Get overall stats
    const overallStats = await Wager.aggregate([
      { $match: { userId: mongoose.Types.ObjectId(req.userId) } },
      { $group: {
          _id: null,
          totalWagered: { $sum: "$amount" },
          totalGames: { $sum: 1 },
          totalWins: { $sum: { $cond: [{ $eq: ["$outcome", "win"] }, 1, 0] } },
          totalLosses: { $sum: { $cond: [{ $eq: ["$outcome", "loss"] }, 1, 0] } },
          totalProfit: { $sum: "$profit" },
          biggestWin: { $max: { $cond: [{ $eq: ["$outcome", "win"] }, "$profit", 0] } },
          biggestLoss: { $min: { $cond: [{ $eq: ["$outcome", "loss"] }, "$profit", 0] } }
        }
      }
    ]);
    
    // Get stats by game type
    const gameStats = await Wager.aggregate([
      { $match: { userId: mongoose.Types.ObjectId(req.userId) } },
      { $group: {
          _id: "$gameType",
          totalWagered: { $sum: "$amount" },
          totalGames: { $sum: 1 },
          wins: { $sum: { $cond: [{ $eq: ["$outcome", "win"] }, 1, 0] } },
          losses: { $sum: { $cond: [{ $eq: ["$outcome", "loss"] }, 1, 0] } },
          profit: { $sum: "$profit" }
        }
      }
    ]);

    // Calculate win rate
    const stats = overallStats.length > 0 ? overallStats[0] : {
      totalWagered: 0,
      totalGames: 0,
      totalWins: 0,
      totalLosses: 0,
      totalProfit: 0,
      biggestWin: 0,
      biggestLoss: 0
    };
    
    const winRate = stats.totalGames > 0 ? (stats.totalWins / stats.totalGames) * 100 : 0;

    res.json({
      username: user.username,
      totalWagered: stats.totalWagered,
      winRate: winRate.toFixed(2),
      totalGames: stats.totalGames,
      totalWins: stats.totalWins,
      totalLosses: stats.totalLosses,
      totalProfit: stats.totalProfit.toFixed(2),
      biggestWin: stats.biggestWin.toFixed(2),
      biggestLoss: stats.biggestLoss.toFixed(2),
      gameBreakdown: gameStats.map(game => ({
        gameType: game._id,
        totalWagered: game.totalWagered,
        totalGames: game.totalGames,
        wins: game.wins,
        losses: game.losses,
        winRate: game.totalGames > 0 ? (game.wins / game.totalGames * 100).toFixed(2) : '0.00',
        profit: game.profit.toFixed(2)
      }))
    });
  } catch (err) {
    console.error('Error getting wager stats:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Recent bets for public leaderboard
router.get('/recent', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20;
    
    // Get recent bets with user info
    const recentBets = await Wager.aggregate([
      { $match: { outcome: { $ne: 'pending' } } },
      { $sort: { createdAt: -1 } },
      { $limit: limit },
      { $lookup: {
          from: 'users',
          localField: 'userId',
          foreignField: '_id',
          as: 'user'
        }
      },
      { $unwind: '$user' },
      { $project: {
          _id: 1,
          gameType: 1,
          amount: 1,
          outcome: 1,
          profit: 1,
          multiplier: 1,
          createdAt: 1,
          username: '$user.username'
        }
      }
    ]);
    
    res.json(recentBets);
  } catch (err) {
    console.error('Error getting recent bets:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Leaderboard endpoint
router.get('/leaderboard', async (req, res) => {
  try {
    const timeframe = req.query.timeframe || 'all'; // all, today, week, month
    const limit = parseInt(req.query.limit) || 10;
    
    // Set date filter based on timeframe
    let dateFilter = {};
    const now = new Date();
    
    if (timeframe === 'today') {
      const startOfDay = new Date(now.setHours(0, 0, 0, 0));
      dateFilter = { createdAt: { $gte: startOfDay } };
    } else if (timeframe === 'week') {
      const startOfWeek = new Date(now);
      startOfWeek.setDate(now.getDate() - now.getDay());
      startOfWeek.setHours(0, 0, 0, 0);
      dateFilter = { createdAt: { $gte: startOfWeek } };
    } else if (timeframe === 'month') {
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
      dateFilter = { createdAt: { $gte: startOfMonth } };
    }
    
    // Get wagering leaderboard
    const wageringLeaderboard = await Wager.aggregate([
      { $match: dateFilter },
      { $group: {
          _id: '$userId',
          totalWagered: { $sum: '$amount' },
          totalGames: { $sum: 1 },
          totalProfit: { $sum: '$profit' }
        }
      },
      { $sort: { totalWagered: -1 } },
      { $limit: limit },
      { $lookup: {
          from: 'users',
          localField: '_id',
          foreignField: '_id',
          as: 'user'
        }
      },
      { $unwind: '$user' },
      { $project: {
          userId: '$_id',
          username: '$user.username',
          totalWagered: 1,
          totalGames: 1,
          totalProfit: 1
        }
      }
    ]);
    
    // Get profit leaderboard
    const profitLeaderboard = await Wager.aggregate([
      { $match: dateFilter },
      { $group: {
          _id: '$userId',
          totalWagered: { $sum: '$amount' },
          totalGames: { $sum: 1 },
          totalProfit: { $sum: '$profit' }
        }
      },
      { $sort: { totalProfit: -1 } },
      { $limit: limit },
      { $lookup: {
          from: 'users',
          localField: '_id',
          foreignField: '_id',
          as: 'user'
        }
      },
      { $unwind: '$user' },
      { $project: {
          userId: '$_id',
          username: '$user.username',
          totalWagered: 1,
          totalGames: 1,
          totalProfit: 1
        }
      }
    ]);
    
    res.json({
      timeframe,
      wageringLeaderboard,
      profitLeaderboard
    });
  } catch (err) {
    console.error('Error getting leaderboard:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Internal function to record a wager (not exposed as an API)
const { processInstantReferralReward } = require('./referral');

// Then modify your recordWager function:
async function recordWager(userId, gameType, amount, gameData = {}) {
  if (!mongoose.Types.ObjectId.isValid(userId)) {
    throw new Error('Invalid user ID');
  }
  
  try {
    // Create wager record
    const wager = new Wager({
      userId,
      gameType,
      amount,
      gameData
    });
    
    await wager.save();
    
    // IMPORTANT NEW CODE: Process referral reward instantly
    await processInstantReferralReward(userId, amount, gameType);
    
    return wager;
  } catch (err) {
    console.error('Error recording wager:', err);
    throw err;
  }

// Update wager outcome
async function updateWagerOutcome(wagerId, outcome, profit, multiplier = 1) {
  if (!mongoose.Types.ObjectId.isValid(wagerId)) {
    throw new Error('Invalid wager ID');
  }
  
  try {
    return await Wager.findByIdAndUpdate(wagerId, {
      outcome,
      profit,
      multiplier,
      completedAt: new Date()
    }, { new: true });
  } catch (err) {
    console.error('Error updating wager outcome:', err);
    throw err;
  }
}

module.exports = {
  router,
  recordWager,
  updateWagerOutcome
};
