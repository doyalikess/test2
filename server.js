// Complete Casino Admin Dashboard - Backend Server
require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');
const axios = require('axios');
const cron = require('node-cron');

// Import models
const User = require('./models/user');
const Wager = require('./models/wager');
const AdminCode = require('./models/adminCode');
const AdminLog = require('./models/adminLog');
const ReferralReward = require('./models/referralReward');
const Withdrawal = require('./models/withdrawal');
const Promocode = require('./models/promocode');
const Tip = require('./models/tip');
const CoinflipGame = require('./models/coinflipGame');

// Import routes
const upgraderRouter = require('./routes/upgrader');
const referralRouter = require('./routes/referral');
const wagerRouter = require('./routes/wager').router;
const coinflipRouter = require('./routes/coinflip');
const tipsRouter = require('./routes/tips');
const { recordWager, updateWagerOutcome } = require('./routes/wager');

// Set referral reward percentage
const REFERRAL_REWARD_PERCENT = 1; // 1% of referred user's wagers

// Constants
const JWT_SECRET = process.env.JWT_SECRET || 'secret_key';
const NOWPAYMENTS_API_KEY = process.env.NOWPAYMENTS_API_KEY || 'H5RMGFD-DDJMKFB-QEKXXBP-6VA0PX1';
const NOWPAYMENTS_IPN_SECRET = process.env.NOWPAYMENTS_IPN_SECRET || crypto.randomBytes(16).toString('hex');
const CALLBACK_URL = 'https://test2-e7gb.onrender.com/api/payment/webhook';
const FRONTEND_URL = 'http://localhost:3000';
const DEFAULT_ADMIN_WEBHOOK = process.env.ADMIN_WEBHOOK_URL || 'https://discord.com/api/webhooks/YOUR_WEBHOOK_URL';
const PORT = process.env.PORT || 3000;

// Initialize Express app
const app = express();
const server = http.createServer(app);

// Socket.IO setup with CORS for frontend origins
const io = new Server(server, {
  cors: {
    origin: ['http://localhost:3000', FRONTEND_URL],
    methods: ['GET', 'POST'],
    credentials: true,
  },
});

// Game states
const jackpotGame = {
  players: [],  // { id, username, bet, socketId, wagerId }
  isRunning: false,
  totalPot: 0,
};

const minesGames = new Map(); // Stores active mines games by userId
const limboGames = new Map(); // Stores active limbo games by userId
const transactions = new Map(); // Stores recent transactions for duplicate prevention

// System settings
let WAGER_REQUIREMENT_MULTIPLIER = 1.0; // Users must wager 1x their deposit amount

// Create custom logger
const logger = {
  info: (message, ...args) => {
    console.log(`[INFO] ${message}`, ...args);
  },
  warn: (message, ...args) => {
    console.warn(`[WARN] ${message}`, ...args);
  },
  error: (message, ...args) => {
    console.error(`[ERROR] ${message}`, ...args);
  }
};

// Auth middleware
function authenticateToken(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Authorization header missing' });

  const token = authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Token missing' });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.userId;
    req.username = decoded.username;
    next();
  } catch (error) {
    logger.warn(`Auth failed: ${error.message}`);
    res.status(401).json({ error: 'Invalid token' });
  }
}

// Admin middleware
function authenticateAdmin(req, res, next) {
  if (!req.userId) return res.status(401).json({ error: 'Not authenticated' });
  
  User.findById(req.userId)
    .then(user => {
      if (!user || !user.isAdmin) {
        return res.status(403).json({ error: 'Not authorized' });
      }
      req.isAdmin = true;
      next();
    })
    .catch(err => {
      logger.error('Admin check error:', err);
      res.status(500).json({ error: 'Server error' });
    });
}

// Helper function to create initial admin user
async function createInitialAdmin() {
  try {
    const adminCount = await User.countDocuments({ isAdmin: true });
    if (adminCount === 0) {
      const adminUser = new User({
        username: 'admin',
        isAdmin: true,
        balance: 10000
      });
      await adminUser.setPassword('admin123');
      await adminUser.save();
      
      // Create initial admin code
      const adminCode = new AdminCode({
        code: 'ADMIN2024',
        description: 'Initial admin access code'
      });
      await adminCode.save();
      
      logger.info('✅ Initial admin user created (username: admin, password: admin123)');
      logger.info('✅ Initial admin code created: ADMIN2024');
    }
  } catch (err) {
    logger.error('Error creating initial admin:', err);
  }
}

// Game helper functions
function generateMinesPositions(gridSize, minesCount) {
  const positions = new Set();
  while (positions.size < minesCount) {
    positions.add(Math.floor(Math.random() * gridSize * gridSize));
  }
  return Array.from(positions);
}

function calculateMultiplier(revealedCount, minesCount) {
  const riskFactor = minesCount / 25; // For 5x5 grid
  return (1 + (1 - riskFactor) * revealedCount * 0.1).toFixed(2);
}

function generateLimboResult() {
  const randomBuffer = crypto.randomBytes(4);
  const randomValue = randomBuffer.readUInt32LE(0) / 0xFFFFFFFF;
  const result = 1 + (1000000 - 1) * Math.pow(randomValue, 2);
  return parseFloat(result.toFixed(2));
}

function calculateLimboWinChance(targetMultiplier) {
  return (1 / targetMultiplier) * 100;
}

async function startJackpotGame(io) {
  jackpotGame.isRunning = true;
  io.emit('jackpot_start');

  setTimeout(async () => {
    const totalBet = jackpotGame.players.reduce((sum, p) => sum + p.bet, 0);
    let random = Math.random() * totalBet;
    let winner = null;

    for (const player of jackpotGame.players) {
      if (random < player.bet) {
        winner = player;
        break;
      }
      random -= player.bet;
    }

    if (!winner && jackpotGame.players.length > 0) {
      winner = jackpotGame.players[0];
    } else if (!winner) {
      logger.warn('Jackpot game started with no players');
      jackpotGame.isRunning = false;
      return;
    }

    try {
      const user = await User.findById(winner.id);
      if (user) {
        const profit = jackpotGame.totalPot - winner.bet;
        user.balance += jackpotGame.totalPot;
        await user.recordGameOutcome(true, profit);
        await user.save();
        await updateWagerOutcome(winner.wagerId, 'win', profit);
        logger.info(`Jackpot winner: ${user.username} won ${jackpotGame.totalPot}`);
      }
      
      // Update losers' wagers
      for (const player of jackpotGame.players) {
        if (player.id !== winner.id) {
          const loser = await User.findById(player.id);
          if (loser) {
            await loser.recordGameOutcome(false, player.bet);
          }
          await updateWagerOutcome(player.wagerId, 'loss', -player.bet);
        }
      }
    } catch (err) {
      logger.error('Error updating jackpot winner balance:', err);
    }

    io.emit('jackpot_winner', {
      winner: { id: winner.id, username: winner.username },
      totalPot: jackpotGame.totalPot,
    });

    jackpotGame.players = [];
    jackpotGame.totalPot = 0;
    jackpotGame.isRunning = false;
  }, 7000);
}

// CORS middleware
app.use(cors({
  origin: ['http://localhost:3000', FRONTEND_URL],
  credentials: true,
}));

app.use(express.json());

// Mount routes
app.use('/api/upgrader', upgraderRouter);

// Mount tip routes
const tipsRouter = require('./routes/tips');
app.use('/api/tips', tipsRouter);
app.use('/api/referral', referralRouter);
app.use('/api/wager', wagerRouter);
app.use('/api/coinflip', coinflipRouter);

// Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => logger.info('✅ MongoDB connected'))
  .catch((err) => {
    logger.error('MongoDB connection error:', err);
    process.exit(1);
  });

// Socket.IO connection handler
io.on('connection', (socket) => {
  logger.info('🔌 A user connected');

  socket.on('authenticate', ({ userId }) => {
    if (userId) {
      socket.join(`user-${userId}`);
      logger.info(`User ${userId} authenticated and joined their room`);
    }
  });

  // Jackpot game handlers
  socket.on('join_jackpot', async ({ userId, username, bet }) => {
    if (jackpotGame.isRunning) {
      socket.emit('jackpot_error', 'A jackpot game is currently running. Please wait.');
      return;
    }

    if (!bet || bet <= 0) {
      socket.emit('jackpot_error', 'Invalid bet amount.');
      return;
    }

    if (jackpotGame.players.find(p => p.id === userId)) {
      socket.emit('jackpot_error', 'You have already joined the jackpot.');
      return;
    }

    try {
      const user = await User.findById(userId);
      if (!user) {
        socket.emit('jackpot_error', 'User not found.');
        return;
      }
      if (user.balance < bet) {
        socket.emit('jackpot_error', 'Insufficient balance.');
        return;
      }

      const wager = await recordWager(userId, 'jackpot', bet);
      user.balance -= bet;
      user.totalWagered = (user.totalWagered || 0) + bet;
      await user.save();

      jackpotGame.players.push({ 
        id: userId, 
        username, 
        bet, 
        socketId: socket.id,
        wagerId: wager._id
      });
      
      jackpotGame.totalPot += bet;

      io.emit('jackpot_update', {
        players: jackpotGame.players.map(p => ({ id: p.id, username: p.username, bet: p.bet })),
        totalPot: jackpotGame.totalPot,
      });

      if (jackpotGame.players.length >= 2) {
        startJackpotGame(io);
      }
    } catch (err) {
      logger.error('Join jackpot error:', err);
      socket.emit('jackpot_error', 'Server error while joining jackpot.');
    }
  });

  // Mines game handlers
  socket.on('mines_start', async ({ userId, betAmount, minesCount }) => {
    try {
      if (!betAmount || betAmount <= 0 || !minesCount || minesCount < 1 || minesCount > 24) {
        socket.emit('mines_error', 'Invalid parameters');
        return;
      }

      const user = await User.findById(userId);
      if (!user) {
        socket.emit('mines_error', 'User not found');
        return;
      }

      if (user.balance < betAmount) {
        socket.emit('mines_error', 'Insufficient balance');
        return;
      }

      if (minesGames.has(userId)) {
        socket.emit('mines_error', 'You already have an active mines game');
        return;
      }

      const wager = await recordWager(userId, 'mines', betAmount);
      user.balance -= betAmount;
      user.totalWagered = (user.totalWagered || 0) + betAmount;
      await user.save();

      const gridSize = 5;
      const minesPositions = generateMinesPositions(gridSize, minesCount);
      
      const game = {
        userId,
        betAmount,
        minesCount,
        gridSize,
        minesPositions,
        revealedPositions: [],
        status: 'ongoing',
        cashoutMultiplier: 1,
        wagerId: wager._id,
        startTime: Date.now()
      };

      minesGames.set(userId, game);

      socket.emit('mines_started', {
        gridSize,
        minesCount,
        initialBalance: user.balance
      });
    } catch (err) {
      logger.error('Mines start error:', err);
      socket.emit('mines_error', 'Server error');
    }
  });

  socket.on('mines_reveal', async ({ userId, position }) => {
    try {
      const game = minesGames.get(userId);
      if (!game || game.status !== 'ongoing') {
        socket.emit('mines_error', 'No active game');
        return;
      }

      if (game.revealedPositions.includes(position)) {
        socket.emit('mines_error', 'Position already revealed');
        return;
      }

      if (game.minesPositions.includes(position)) {
        game.status = 'busted';
        
        const user = await User.findById(userId);
        if (user) {
          await user.recordGameOutcome(false, game.betAmount);
        }
        
        await updateWagerOutcome(game.wagerId, 'loss', -game.betAmount);
        minesGames.delete(userId);
        
        socket.emit('mines_busted', {
          minePositions: game.minesPositions,
          lostAmount: game.betAmount
        });
        return;
      }

      game.revealedPositions.push(position);
      game.cashoutMultiplier = calculateMultiplier(game.revealedPositions.length, game.minesCount);

      socket.emit('mines_revealed', {
        position,
        isMine: false,
        cashoutMultiplier: game.cashoutMultiplier,
        revealedPositions: game.revealedPositions
      });
    } catch (err) {
      logger.error('Mines reveal error:', err);
      socket.emit('mines_error', 'Server error');
    }
  });

  socket.on('mines_cashout', async ({ userId }) => {
    try {
      const game = minesGames.get(userId);
      if (!game || game.status !== 'ongoing') {
        socket.emit('mines_error', 'No active game to cashout');
        return;
      }

      const user = await User.findById(userId);
      if (!user) {
        socket.emit('mines_error', 'User not found');
        return;
      }

      const winnings = game.betAmount * game.cashoutMultiplier;
      const profit = winnings - game.betAmount;
      
      user.balance += winnings;
      await user.recordGameOutcome(true, profit);
      await user.save();
      await updateWagerOutcome(game.wagerId, 'win', profit);

      if (profit > 100) {
        io.emit('high_win', {
          username: user.username,
          game: 'mines',
          profit,
          multiplier: game.cashoutMultiplier
        });
      }

      minesGames.delete(userId);

      socket.emit('mines_cashed_out', {
        winnings,
        newBalance: user.balance,
        cashoutMultiplier: game.cashoutMultiplier,
        revealedPositions: game.revealedPositions,
        minePositions: game.minesPositions
      });
    } catch (err) {
      logger.error('Mines cashout error:', err);
      socket.emit('mines_error', 'Server error');
    }
  });

  // Limbo game handlers
  socket.on('limbo_start', async ({ userId, betAmount, targetMultiplier }) => {
    try {
      if (!betAmount || betAmount <= 0 || !targetMultiplier || targetMultiplier < 1.01) {
        socket.emit('limbo_error', 'Invalid parameters');
        return;
      }

      const user = await User.findById(userId);
      if (!user) {
        socket.emit('limbo_error', 'User not found');
        return;
      }

      if (user.balance < betAmount) {
        socket.emit('limbo_error', 'Insufficient balance');
        return;
      }

      if (limboGames.has(userId)) {
        socket.emit('limbo_error', 'You already have an active limbo game');
        return;
      }

      const wager = await recordWager(userId, 'limbo', betAmount);
      user.balance -= betAmount;
      user.totalWagered = (user.totalWagered || 0) + betAmount;
      await user.save();

      const game = {
        userId,
        betAmount,
        targetMultiplier,
        status: 'pending',
        winChance: calculateLimboWinChance(targetMultiplier),
        serverSeed: crypto.randomBytes(16).toString('hex'),
        clientSeed: crypto.randomBytes(16).toString('hex'),
        nonce: 0,
        wagerId: wager._id,
        startTime: Date.now()
      };

      limboGames.set(userId, game);

      socket.emit('limbo_started', {
        betAmount,
        targetMultiplier,
        winChance: game.winChance,
        currentBalance: user.balance
      });
    } catch (err) {
      logger.error('Limbo start error:', err);
      socket.emit('limbo_error', 'Server error');
    }
  });

  socket.on('limbo_play', async ({ userId }) => {
    try {
      const game = limboGames.get(userId);
      if (!game || game.status !== 'pending') {
        socket.emit('limbo_error', 'No active game');
        return;
      }

      const user = await User.findById(userId);
      if (!user) {
        socket.emit('limbo_error', 'User not found');
        return;
      }

      const result = generateLimboResult();
      const win = result >= game.targetMultiplier;
      const payout = win ? game.betAmount * game.targetMultiplier : 0;
      const profit = win ? payout - game.betAmount : -game.betAmount;

      await updateWagerOutcome(game.wagerId, win ? 'win' : 'loss', profit);
      await user.recordGameOutcome(win, Math.abs(profit));

      if (win) {
        user.balance += payout;
        await user.save();

        if (profit > 100) {
          io.emit('high_win', {
            username: user.username,
            game: 'limbo',
            profit,
            multiplier: game.targetMultiplier
          });
        }
      }

      game.status = 'completed';
      game.result = result;
      game.win = win;
      game.payout = payout;

      socket.emit('limbo_result', {
        result,
        win,
        payout,
        targetMultiplier: game.targetMultiplier,
        newBalance: user.balance,
        serverSeed: game.serverSeed,
        clientSeed: game.clientSeed,
        nonce: game.nonce
      });

      limboGames.delete(userId);
    } catch (err) {
      logger.error('Limbo play error:', err);
      socket.emit('limbo_error', 'Server error');
    }
  });

  socket.on('disconnect', () => {
    logger.info('❌ A user disconnected');

    if (!jackpotGame.isRunning) {
      const idx = jackpotGame.players.findIndex(p => p.socketId === socket.id);
      if (idx !== -1) {
        const removed = jackpotGame.players.splice(idx, 1)[0];
        jackpotGame.totalPot -= removed.bet;

        User.findById(removed.id).then(user => {
          if (user) {
            user.balance += removed.bet;
            return user.save();
          }
        }).catch(err => logger.error('Error refunding jackpot bet:', err));

        const wagerId = removed.wagerId;
        if (wagerId) {
          Wager.findByIdAndDelete(wagerId).catch(err => logger.error('Error deleting wager:', err));
        }

        io.emit('jackpot_update', {
          players: jackpotGame.players.map(p => ({ id: p.id, username: p.username, bet: p.bet })),
          totalPot: jackpotGame.totalPot,
        });
      }
    }
  });
});

// Auth endpoints
app.post('/api/auth/signup', async (req, res) => {
  const { username, password, referralCode } = req.body;
  
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

  if (!/^[a-zA-Z0-9_]{3,16}$/.test(username)) {
    return res.status(400).json({ error: 'Username must be 3-16 characters and contain only letters, numbers, and underscores' });
  }

  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters long' });
  }

  try {
    let user = await User.findOne({ username });
    if (user) return res.status(400).json({ error: 'Username already taken' });

    user = new User({ username });
    await user.setPassword(password);
    
    if (referralCode) {
      const referrer = await User.findOne({ referralCode });
      if (referrer) {
        user.referredBy = referrer._id;
        referrer.referralCount += 1;
        await referrer.save();
        logger.info(`New user ${username} referred by ${referrer.username}`);
      }
    }
    
    user.referralCode = crypto.randomBytes(3).toString('hex').toUpperCase();
    user.balance = 0.05; // Welcome bonus
    
    await user.save();

    logger.info(`New user registered: ${username}`);
    res.json({ message: 'User created with $0.05 welcome bonus' });
  } catch (err) {
    logger.error('Error creating user:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

  try {
    const user = await User.findOne({ username });
    
    if (!user) {
      return res.status(400).json({ error: 'Invalid credentials' });
    }

    const valid = await user.validatePassword(password);
    if (!valid) {
      return res.status(400).json({ error: 'Invalid credentials' });
    }
    
    user.lastLoginTime = new Date();
    await user.save();

    const token = jwt.sign({ userId: user._id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
    
    logger.info(`User logged in: ${username}`);
    res.json({ 
      token, 
      balance: user.balance, 
      username: user.username,
      referralCode: user.referralCode,
      totalWagered: user.totalWagered
    });
  } catch (err) {
    logger.error('Login error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/auth/me', authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.userId).select('-password -__v');
    if (!user) return res.status(404).json({ error: 'User not found' });

    const wagerStatus = user.getWagerRequirementStatus();
    
    res.json({
      username: user.username,
      balance: user.balance,
      referralCode: user.referralCode,
      totalWagered: user.totalWagered,
      referralEarnings: user.referralEarnings,
      referralCount: user.referralCount,
      gamesPlayed: user.gamesPlayed,
      gamesWon: user.gamesWon,
      gamesLost: user.gamesLost,
      totalProfit: user.totalProfit,
      highestWin: user.highestWin,
      createdAt: user.createdAt,
      isAdmin: user.isAdmin || false,
      isStreamer: user.isStreamer || false,
      wagerRequirement: wagerStatus
    });
  } catch (err) {
    logger.error('Get user info error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Admin webhook verification for admin login
app.post('/api/auth/admin-verify-code', authenticateToken, async (req, res) => {
  try {
    const { code } = req.body;
    
    if (!code) {
      return res.status(400).json({ error: 'Code required' });
    }
    
    // Check if the code exists and is valid
    const adminCode = await AdminCode.findOne({ code, isUsed: false });
    
    if (!adminCode) {
      return res.status(400).json({ error: 'Invalid or expired code' });
    }
    
    // Check if code has expired
    if (adminCode.expiresAt && adminCode.expiresAt < new Date()) {
      return res.status(400).json({ error: 'Code has expired' });
    }
    
    // Get the user
    const user = await User.findById(req.userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    // Mark user as admin and mark code as used
    user.isAdmin = true;
    user.role = 'admin';
    await user.save();
    
    adminCode.isUsed = true;
    adminCode.usedBy = user._id;
    adminCode.usedAt = new Date();
    await adminCode.save();
    
    // Log the admin verification
    const log = new AdminLog({
      action: 'admin_verified',
      admin: user.username,
      details: `User verified as admin using code: ${code}`
    });
    await log.save();
    
    logger.info(`User ${user.username} verified as admin using code ${code}`);
    
    res.json({ 
      success: true, 
      message: 'Admin privileges granted',
      isAdmin: true
    });
  } catch (err) {
    logger.error('Admin verification error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Admin endpoints
app.get('/api/admin/stats', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    const totalUsers = await User.countDocuments();
    const totalWageredResult = await User.aggregate([
      { $group: { _id: null, total: { $sum: '$totalWagered' } } }
    ]);
    const pendingWithdrawals = await Withdrawal.countDocuments({ status: 'pending' });
    const activeGames = minesGames.size + limboGames.size + (jackpotGame.players.length > 0 ? 1 : 0);
    
    res.json({
      totalUsers,
      activeGames,
      totalWagered: totalWageredResult.length > 0 ? totalWageredResult[0].total : 0,
      pendingWithdrawals
    });
  } catch (err) {
    logger.error('Error fetching admin stats:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/admin/users', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    const { search, page = 1, limit = 20 } = req.query;
    const query = search ? { username: { $regex: search, $options: 'i' } } : {};
    
    const users = await User.find(query)
      .select('username balance totalWagered isAdmin isStreamer createdAt')
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);
    
    const total = await User.countDocuments(query);
    
    res.json({
      users,
      totalPages: Math.ceil(total / limit),
      currentPage: page
    });
  } catch (err) {
    logger.error('Error fetching users:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/admin/assign-role', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    const { username, role } = req.body;
    
    if (!username || !role) {
      return res.status(400).json({ error: 'Username and role required' });
    }
    
    if (!['admin', 'streamer'].includes(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }
    
    const user = await User.findOne({ username });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    if (role === 'admin') {
      user.isAdmin = true;
      user.role = 'admin';
    } else if (role === 'streamer') {
      user.isStreamer = true;
      user.role = 'streamer';
      user.tipLimit = 500; // Default tip limit
    }
    
    await user.save();
    
    // Log the action
    const log = new AdminLog({
      action: 'role_assigned',
      admin: req.username,
      target: username,
      details: `Assigned ${role} role to ${username}`
    });
    await log.save();
    
    res.json({ success: true, message: `${role} role assigned to ${username}` });
  } catch (err) {
    logger.error('Error assigning role:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/admin/add-balance', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    const { username, amount } = req.body;
    
    if (!username || !amount || amount <= 0) {
      return res.status(400).json({ error: 'Valid username and amount required' });
    }
    
    const user = await User.findOne({ username });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    const depositAmount = parseFloat(amount);
    user.balance += depositAmount;
    user.totalDeposited = (user.totalDeposited || 0) + depositAmount;
    
    // Add wager requirement for deposit (1:1 ratio)
    user.addWagerRequirement(depositAmount, 'deposit');
    
    await user.save();
    
    // Log the action
    const log = new AdminLog({
      action: 'balance_added',
      admin: req.username,
      target: username,
      details: `Added $${amount} to ${username}'s balance`
    });
    await log.save();
    
    // Notify user in real-time
    io.to(`user-${user._id}`).emit('balance_update', {
      newBalance: user.balance,
      amount: parseFloat(amount),
      reason: 'admin_bonus'
    });
    
    res.json({ 
      success: true, 
      message: `Added $${amount} to ${username}'s balance`,
      newBalance: user.balance
    });
  } catch (err) {
    logger.error('Error adding balance:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Withdrawal endpoints
app.post('/api/withdraw', authenticateToken, async (req, res) => {
  try {
    const { amount, method, address } = req.body;
    
    if (!amount || !method || !address) {
      return res.status(400).json({ error: 'Amount, method, and address required' });
    }
    
    if (amount < 5) {
      return res.status(400).json({ error: 'Minimum withdrawal amount is $5' });
    }
    
    const user = await User.findById(req.userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    if (user.balance < amount) {
      return res.status(400).json({ error: 'Insufficient balance' });
    }
    
    // Check wagering requirements
    const wagerStatus = user.getWagerRequirementStatus();
    if (!wagerStatus.canWithdraw) {
      return res.status(400).json({ 
        error: 'You must complete wagering requirements before withdrawing',
        wagerRequirement: wagerStatus
      });
    }
    
    // Legacy check for unwageredAmount
    if (user.unwageredAmount > 0) {
      return res.status(400).json({ 
        error: 'You must complete wagering requirements before withdrawing',
        unwageredAmount: user.unwageredAmount
      });
    }
    
    // Create withdrawal request
    const withdrawal = new Withdrawal({
      userId: user._id,
      username: user.username,
      amount,
      method,
      address
    });
    
    await withdrawal.save();
    
    // Deduct balance immediately (will be refunded if rejected)
    user.balance -= amount;
    await user.save();
    
    res.json({
      success: true,
      withdrawalId: withdrawal._id,
      message: 'Withdrawal request submitted',
      newBalance: user.balance
    });
  } catch (err) {
    logger.error('Error creating withdrawal:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/admin/withdrawals', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    const withdrawals = await Withdrawal.find()
      .sort({ createdAt: -1 })
      .limit(50);
    
    res.json(withdrawals);
  } catch (err) {
    logger.error('Error fetching withdrawals:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/admin/approve-withdrawal', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    const { withdrawalId, transactionHash } = req.body;
    
    const withdrawal = await Withdrawal.findById(withdrawalId);
    if (!withdrawal) {
      return res.status(404).json({ error: 'Withdrawal not found' });
    }
    
    if (withdrawal.status !== 'pending') {
      return res.status(400).json({ error: 'Withdrawal already processed' });
    }
    
    withdrawal.status = 'approved';
    withdrawal.transactionHash = transactionHash || '';
    withdrawal.processedBy = req.userId;
    withdrawal.processedAt = new Date();
    await withdrawal.save();
    
    // Log the action
    const log = new AdminLog({
      action: 'withdrawal_approved',
      admin: req.username,
      target: withdrawal.username,
      details: `Approved withdrawal of $${withdrawal.amount} for ${withdrawal.username}`
    });
    await log.save();
    
    res.json({ success: true, message: 'Withdrawal approved' });
  } catch (err) {
    logger.error('Error approving withdrawal:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/admin/reject-withdrawal', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    const { withdrawalId, reason } = req.body;
    
    const withdrawal = await Withdrawal.findById(withdrawalId);
    if (!withdrawal) {
      return res.status(404).json({ error: 'Withdrawal not found' });
    }
    
    if (withdrawal.status !== 'pending') {
      return res.status(400).json({ error: 'Withdrawal already processed' });
    }
    
    // Refund the user
    const user = await User.findById(withdrawal.userId);
    if (user) {
      user.balance += withdrawal.amount;
      await user.save();
      
      // Notify user
      io.to(`user-${user._id}`).emit('balance_update', {
        newBalance: user.balance,
        amount: withdrawal.amount,
        reason: 'withdrawal_rejected'
      });
    }
    
    withdrawal.status = 'rejected';
    withdrawal.adminNotes = reason || '';
    withdrawal.processedBy = req.userId;
    withdrawal.processedAt = new Date();
    await withdrawal.save();
    
    // Log the action
    const log = new AdminLog({
      action: 'withdrawal_rejected',
      admin: req.username,
      target: withdrawal.username,
      details: `Rejected withdrawal of $${withdrawal.amount} for ${withdrawal.username}. Reason: ${reason}`
    });
    await log.save();
    
    res.json({ success: true, message: 'Withdrawal rejected and balance refunded' });
  } catch (err) {
    logger.error('Error rejecting withdrawal:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get wager requirement status
app.get('/api/user/wager-requirement', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    const wagerStatus = user.getWagerRequirementStatus ? user.getWagerRequirementStatus() : {
      totalRequired: 0,
      totalWagered: 0,
      remaining: 0,
      percentage: 100,
      canWithdraw: true,
      fromDeposits: 0,
      fromTips: 0
    };
    
    res.json(wagerStatus);
  } catch (err) {
    logger.error('Get wager requirement error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get user's upgrader stats
app.get('/api/user/upgrader-stats', authMiddleware, async (req, res) => {
  try {
    const wagers = await Wager.find({ 
      userId: req.userId, 
      gameType: 'upgrader' 
    });
    
    const totalWagered = wagers.reduce((sum, wager) => sum + wager.amount, 0);
    
    res.json({
      totalWagered: totalWagered,
      gamesPlayed: wagers.length,
      wins: wagers.filter(w => w.outcome === 'win').length,
      losses: wagers.filter(w => w.outcome === 'loss').length
    });
  } catch (err) {
    logger.error('Get upgrader stats error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get user's recent upgrader games
app.get('/api/user/recent-upgrader-games', authMiddleware, async (req, res) => {
  try {
    const wagers = await Wager.find({ 
      userId: req.userId, 
      gameType: 'upgrader' 
    })
    .sort({ createdAt: -1 })
    .limit(10);
    
    const games = wagers.map(wager => ({
      amount: wager.amount,
      multiplier: wager.meta?.targetMultiplier || 2.0,
      won: wager.outcome === 'win',
      createdAt: wager.createdAt
    }));
    
    res.json({ games });
  } catch (err) {
    logger.error('Get recent upgrader games error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get online players count
app.get('/api/stats/online-players', authMiddleware, async (req, res) => {
  try {
    // For demonstration, return a random count between 500-1500
    // In a real app, you'd track connected sockets or active sessions
    const count = Math.floor(Math.random() * 1000) + 500;
    
    res.json({ count });
  } catch (err) {
    logger.error('Get online players error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get wager requirement status endpoint
app.get('/api/user/wager-requirement', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    const wagerStatus = user.getWagerRequirementStatus ? user.getWagerRequirementStatus() : {
      totalRequired: 0,
      totalWagered: 0,
      remaining: 0,
      percentage: 100,
      canWithdraw: true,
      fromDeposits: 0,
      fromTips: 0
    };
    
    res.json(wagerStatus);
  } catch (err) {
    logger.error('Get wager requirement error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get user's upgrader stats
app.get('/api/user/upgrader-stats', authMiddleware, async (req, res) => {
  try {
    const wagers = await Wager.find({ 
      userId: req.userId, 
      gameType: 'upgrader' 
    });
    
    const totalWagered = wagers.reduce((sum, wager) => sum + wager.amount, 0);
    
    res.json({
      totalWagered: totalWagered,
      gamesPlayed: wagers.length,
      wins: wagers.filter(w => w.outcome === 'win').length,
      losses: wagers.filter(w => w.outcome === 'loss').length
    });
  } catch (err) {
    logger.error('Get upgrader stats error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get user's recent upgrader games
app.get('/api/user/recent-upgrader-games', authMiddleware, async (req, res) => {
  try {
    const wagers = await Wager.find({ 
      userId: req.userId, 
      gameType: 'upgrader' 
    })
    .sort({ createdAt: -1 })
    .limit(10);
    
    const games = wagers.map(wager => ({
      amount: wager.amount,
      multiplier: wager.meta?.targetMultiplier || 2.0,
      won: wager.outcome === 'win',
      createdAt: wager.createdAt
    }));
    
    res.json({ games });
  } catch (err) {
    logger.error('Get recent upgrader games error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get online players count
app.get('/api/stats/online-players', authMiddleware, async (req, res) => {
  try {
    // For demonstration, return a random count between 500-1500
    // In a real app, you'd track connected sockets or active sessions
    const count = Math.floor(Math.random() * 1000) + 500;
    
    res.json({ count });
  } catch (err) {
    logger.error('Get online players error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Start server
server.listen(PORT, async () => {
  logger.info(`🚀 Server running on port ${PORT}`);
  await createInitialAdmin();
  
  // Send startup notification to webhook
  try {
    await axios.post(DEFAULT_ADMIN_WEBHOOK, {
      content: `🚀 **Server Started**\nTime: ${new Date().toISOString()}\nEnvironment: ${process.env.NODE_ENV || 'development'}\nPort: ${PORT}`
    });
  } catch (webhookErr) {
    logger.error('Could not send startup webhook:', webhookErr);
  }
});
