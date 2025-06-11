require('dotenv').config();
const User = require('./models/user');
const Wager = require('./models/wager'); // New import for wager model
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const axios = require('axios');
const http = require('http');
const { Server } = require('socket.io');

const upgraderRouter = require('./routes/upgrader');
const referralRouter = require('./routes/referral'); // New import for referral routes
const wagerRouter = require('./routes/wager').router; // New import for wager routes
const { recordWager, updateWagerOutcome } = require('./routes/wager'); // Import wager helper functions

// Set referral reward percentage
const REFERRAL_REWARD_PERCENT = 10; // 10% of referred user's wagers

// Constants
const JWT_SECRET = process.env.JWT_SECRET || 'secret_key';
const NOWPAYMENTS_API_KEY = process.env.NOWPAYMENTS_API_KEY || 'H5RMGFD-DDJMKFB-QEKXXBP-6VA0PX1';
const NOWPAYMENTS_IPN_SECRET = process.env.NOWPAYMENTS_IPN_SECRET || crypto.randomBytes(16).toString('hex');
const CALLBACK_URL = 'https://test2-e7gb.onrender.com/api/payment/webhook';
const FRONTEND_URL = 'http://localhost:3000/';

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

// Jackpot game state outside connection handler
const jackpotGame = {
  players: [],  // { id, username, bet, socketId, wagerId }
  isRunning: false,
  totalPot: 0,
};

// Mines game state
const minesGames = new Map(); // Stores active mines games by userId

// Limbo game state
const limboGames = new Map(); // Stores active limbo games by userId

// Transaction tracking
const transactions = new Map(); // Stores recent transactions for duplicate prevention

// Mines game helper functions
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

// Limbo game helper functions
function generateLimboResult() {
  // Using cryptographically secure random number
  const randomBuffer = crypto.randomBytes(4);
  const randomValue = randomBuffer.readUInt32LE(0) / 0xFFFFFFFF;
  
  // Limbo result between 1.00x and 1000000.00x with exponential distribution
  const result = 1 + (1000000 - 1) * Math.pow(randomValue, 2);
  return parseFloat(result.toFixed(2));
}

function calculateLimboWinChance(targetMultiplier) {
  // The chance to win is 1/targetMultiplier
  return (1 / targetMultiplier) * 100;
}

// Generate a transaction ID
function generateTransactionId() {
  return `tx_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

// Verify a transaction is not a duplicate
function verifyTransaction(transactionId, userId, amount, type) {
  const key = `${userId}_${type}_${amount}`;
  const lastTransaction = transactions.get(key);
  
  if (lastTransaction && Date.now() - lastTransaction.timestamp < 10000) {
    // Duplicate transaction within 10 seconds
    return false;
  }
  
  // Store this transaction
  transactions.set(key, {
    transactionId,
    timestamp: Date.now()
  });
  
  // Clean up old transactions (older than 1 hour)
  const oneHourAgo = Date.now() - 3600000;
  for (const [key, transaction] of transactions.entries()) {
    if (transaction.timestamp < oneHourAgo) {
      transactions.delete(key);
    }
  }
  
  return true;
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
      // No players, game canceled
      logger.warn('Jackpot game started with no players');
      jackpotGame.isRunning = false;
      return;
    }

    try {
      const user = await User.findById(winner.id);
      if (user) {
        // Calculate profit (total pot minus the winner's original bet)
        const profit = jackpotGame.totalPot - winner.bet;
        
        // Update winner's balance
        user.balance += jackpotGame.totalPot;
        
        // Record game outcome for winner
        await user.recordGameOutcome(true, profit);
        await user.save();
        
        // Update wager outcome for winner
        await updateWagerOutcome(winner.wagerId, 'win', profit);

        logger.info(`Jackpot winner: ${user.username} won ${jackpotGame.totalPot}`);
      }
      
      // Update losers' wagers
      for (const player of jackpotGame.players) {
        if (player.id !== winner.id) {
          const loser = await User.findById(player.id);
          if (loser) {
            // Record game outcome for loser
            await loser.recordGameOutcome(false, player.bet);
          }
          
          // Update wager outcome for loser
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

io.on('connection', (socket) => {
  logger.info('🔌 A user connected');

  // Join user to their own room for targeted events
  socket.on('authenticate', ({ userId }) => {
    if (userId) {
      socket.join(`user-${userId}`);
      logger.info(`User ${userId} authenticated and joined their room`);
    }
  });

  socket.on('chatMessage', (message) => {
    // Basic chat filter for offensive content
    const filteredMessage = filterOffensiveContent(message);
    io.emit('chatMessage', filteredMessage);
  });

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

      // Record the wager
      const wager = await recordWager(userId, 'jackpot', bet);
      
      // Track wager in user stats
      await user.trackWager(bet, 'jackpot');
      
      // Deduct balance
      user.balance -= bet;
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

      // Check if user already has an active game
      if (minesGames.has(userId)) {
        socket.emit('mines_error', 'You already have an active mines game');
        return;
      }

      // Record the wager
      const wager = await recordWager(userId, 'mines', betAmount);
      
      // Track wager in user stats
      await user.trackWager(betAmount, 'mines');
      
      // Deduct balance
      user.balance -= betAmount;
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
        
        // Get the user
        const user = await User.findById(userId);
        if (user) {
          // Record game outcome
          await user.recordGameOutcome(false, game.betAmount);
        }
        
        // Update wager outcome
        await updateWagerOutcome(game.wagerId, 'loss', -game.betAmount);
        
        minesGames.delete(userId);
        
        socket.emit('mines_busted', {
          minePositions: game.minesPositions,
          lostAmount: game.betAmount
        });
        return;
      }

      game.revealedPositions.push(position);
      
      game.cashoutMultiplier = calculateMultiplier(
        game.revealedPositions.length,
        game.minesCount
      );

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
      
      // Update user balance
      user.balance += winnings;
      
      // Record game outcome
      await user.recordGameOutcome(true, profit);
      await user.save();
      
      // Update wager outcome
      await updateWagerOutcome(game.wagerId, 'win', profit);

      // Track high win
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

      // Check if user already has an active game
      if (limboGames.has(userId)) {
        socket.emit('limbo_error', 'You already have an active limbo game');
        return;
      }

      // Record the wager
      const wager = await recordWager(userId, 'limbo', betAmount);
      
      // Track wager in user stats
      await user.trackWager(betAmount, 'limbo');
      
      // Deduct balance immediately
      user.balance -= betAmount;
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

      // Generate the game result
      const result = generateLimboResult();
      const win = result >= game.targetMultiplier;
      const payout = win ? game.betAmount * game.targetMultiplier : 0;
      const profit = win ? payout - game.betAmount : -game.betAmount;

      // Update wager outcome
      await updateWagerOutcome(game.wagerId, win ? 'win' : 'loss', profit);
      
      // Record game outcome
      await user.recordGameOutcome(win, Math.abs(profit));

      // Update user balance if they won
      if (win) {
        user.balance += payout;
        await user.save();

        // Track high win
        if (profit > 100) {
          io.emit('high_win', {
            username: user.username,
            game: 'limbo',
            profit,
            multiplier: game.targetMultiplier
          });
        }
      }

      // Update game status
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

      // Remove completed game
      limboGames.delete(userId);
    } catch (err) {
      logger.error('Limbo play error:', err);
      socket.emit('limbo_error', 'Server error');
    }
  });

  // New crash game socket handlers
  socket.on('crash_join', async ({ userId, betAmount }) => {
    // Implementation for crash game
    // This would include betting mechanics, generating a crash point, etc.
  });

  socket.on('crash_cashout', async ({ userId }) => {
    // Implementation for cashing out of crash game
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

        // Also remove the wager record
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

// Simple chat filter function
function filterOffensiveContent(message) {
  const offensive = ['badword1', 'badword2', 'badword3']; // Add actual offensive words
  let filteredMessage = message;
  
  if (typeof message === 'object' && message.text) {
    let text = message.text;
    
    offensive.forEach(word => {
      const regex = new RegExp(word, 'gi');
      text = text.replace(regex, '*'.repeat(word.length));
    });
    
    filteredMessage = { ...message, text };
  }
  
  return filteredMessage;
}

// Clean up inactive games periodically
setInterval(() => {
  const currentTime = Date.now();
  const timeoutThreshold = 10 * 60 * 1000; // 10 minutes
  
  // Clean up mines games
  for (const [userId, game] of minesGames.entries()) {
    if (currentTime - game.startTime > timeoutThreshold) {
      minesGames.delete(userId);
      logger.info(`Auto-cleaned inactive mines game for user ${userId}`);
    }
  }
  
  // Clean up limbo games
  for (const [userId, game] of limboGames.entries()) {
    if (currentTime - game.startTime > timeoutThreshold) {
      limboGames.delete(userId);
      logger.info(`Auto-cleaned inactive limbo game for user ${userId}`);
    }
  }
}, 5 * 60 * 1000); // Run every 5 minutes

// CORS middleware for REST API requests
app.use(
  cors({
    origin: ['http://localhost:3000', FRONTEND_URL],
    credentials: true,
  })
);

// Middleware to capture raw body (needed for webhook signature verification)
const rawBodySaver = (req, res, buf, encoding) => {
  if (buf && buf.length) {
    req.rawBody = buf.toString(encoding || 'utf8');
  }
};
app.use(express.json({ verify: rawBodySaver }));

// Connect to MongoDB
mongoose
  .connect(process.env.MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => logger.info('✅ MongoDB connected'))
  .catch((err) => {
    logger.error('MongoDB connection error:', err);
    process.exit(1);
  });

// Request logging middleware
app.use((req, res, next) => {
  logger.info(`${req.method} ${req.path}`);
  next();
});

// Auth middleware
function authMiddleware(req, res, next) {
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
function adminMiddleware(req, res, next) {
  if (!req.userId) return res.status(401).json({ error: 'Not authenticated' });
  
  User.findById(req.userId)
    .then(user => {
      if (!user || !user.isAdmin) {
        return res.status(403).json({ error: 'Not authorized' });
      }
      next();
    })
    .catch(err => {
      logger.error('Admin check error:', err);
      res.status(500).json({ error: 'Server error' });
    });
}

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    version: '1.2.0'
  });
});

// Transaction history endpoint
app.get('/api/user/transactions', authMiddleware, async (req, res) => {
  try {
    // Get user's wager history from Wager model
    const wagers = await Wager.find({ userId: req.userId })
      .sort({ createdAt: -1 })
      .limit(50);
      
    res.json(wagers);
  } catch (err) {
    logger.error('Error fetching transactions:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Signup
app.post('/api/auth/signup', async (req, res) => {
  const { username, password, referralCode } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

  // Validate username format
  if (!/^[a-zA-Z0-9_]{3,16}$/.test(username)) {
    return res.status(400).json({ error: 'Username must be 3-16 characters and contain only letters, numbers, and underscores' });
  }

  // Validate password strength
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters long' });
  }

  try {
    let user = await User.findOne({ username });
    if (user) return res.status(400).json({ error: 'Username already taken' });

    user = new User({ username });
    await user.setPassword(password);
    
    // Apply referral code if provided
    if (referralCode) {
      // Find referrer by code
      const referrer = await User.findOne({ referralCode });
      if (referrer) {
        // Set referrer
        user.referredBy = referrer._id;
        
        // Increment referrer's count
        referrer.referralCount += 1;
        await referrer.save();
        
        logger.info(`New user ${username} referred by ${referrer.username}`);
      }
    }
    
    // Generate unique referral code for new user
    user.referralCode = crypto.randomBytes(3).toString('hex').toUpperCase();
    
    // Welcome bonus
    user.balance = 10; // $10 welcome bonus
    
    await user.save();

    logger.info(`New user registered: ${username}`);
    res.json({ message: 'User created with $10 welcome bonus' });
  } catch (err) {
    logger.error('Error creating user:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Login
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

  try {
    const user = await User.findOne({ username });
    if (!user) return res.status(400).json({ error: 'Invalid credentials' });

    const valid = await user.validatePassword(password);
    if (!valid) return res.status(400).json({ error: 'Invalid credentials' });
    
    // Update last login time
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

// Get current user info
app.get('/api/auth/me', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId).select('-passwordHash -__v');
    if (!user) return res.status(404).json({ error: 'User not found' });

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
      isAdmin: user.isAdmin || false
    });
  } catch (err) {
    logger.error('Get user info error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update user profile
app.patch('/api/user/profile', authMiddleware, async (req, res) => {
  const { avatar, displayName } = req.body;
  
  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    
    // Only update fields that were provided
    if (avatar) user.avatar = avatar;
    if (displayName) user.displayName = displayName;
    
    await user.save();
    
    res.json({ 
      message: 'Profile updated successfully',
      avatar: user.avatar,
      displayName: user.displayName
    });
  } catch (err) {
    logger.error('Update profile error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Change password
app.post('/api/auth/change-password', authMiddleware, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Current and new password required' });
  }
  
  if (newPassword.length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters long' });
  }
  
  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    
    const valid = await user.validatePassword(currentPassword);
    if (!valid) return res.status(400).json({ error: 'Current password is incorrect' });
    
    await user.setPassword(newPassword);
    await user.save();
    
    logger.info(`Password changed for user: ${user.username}`);
    res.json({ message: 'Password changed successfully' });
  } catch (err) {
    logger.error('Change password error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Create a deposit invoice - REAL
app.post('/api/payment/deposit', authMiddleware, async (req, res) => {
  const { amount, currency } = req.body;
  if (!amount || !currency) return res.status(400).json({ error: 'Amount and currency required' });

  // Validate amount and currency
  if (amount < 10) {
    return res.status(400).json({ error: 'Minimum deposit amount is $10' });
  }

  const allowedCurrencies = ['BTC', 'ETH', 'LTC', 'USDT'];
  if (!allowedCurrencies.includes(currency.toUpperCase())) {
    return res.status(400).json({ error: 'Unsupported cryptocurrency' });
  }

  try {
    // Generate transaction ID
    const transactionId = generateTransactionId();
    
    // Verify not a duplicate transaction
    if (!verifyTransaction(transactionId, req.userId, amount, 'deposit')) {
      return res.status(429).json({ error: 'Duplicate deposit request. Please wait before trying again.' });
    }
    
    // Create order ID
    const order_id = `deposit_${req.userId}_${Date.now()}`;
    
    // Log the deposit attempt
    logger.info(`Deposit attempt: ${req.username} - $${amount} in ${currency}`);
    
    // Request to NOWPayments API
    const response = await axios.post(
      'https://api.nowpayments.io/v1/invoice',
      {
        price_amount: amount,
        price_currency: 'usd',
        pay_currency: currency.toLowerCase(),
        order_id: order_id,
        ipn_callback_url: CALLBACK_URL,
        success_url: `${FRONTEND_URL}/deposit-success`,
        cancel_url: `${FRONTEND_URL}/deposit-cancel`
      },
      { 
        headers: { 
          'x-api-key': NOWPAYMENTS_API_KEY,
          'Content-Type': 'application/json'
        }
      }
    );

    // Save deposit request to user's records
    await User.findByIdAndUpdate(req.userId, {
      $push: {
        depositRequests: {
          depositId: response.data.id,
          amount,
          currency,
          status: 'pending',
          createdAt: new Date()
        }
      }
    });

    res.json({
      deposit_url: response.data.invoice_url,
      deposit_id: response.data.id,
    });
  } catch (error) {
    logger.error('NowPayments error:', error.response?.data || error.message);
    
    // More detailed error response
    let errorMessage = 'Failed to create deposit';
    
    if (error.response) {
      // NOWPayments API error
      if (error.response.data && error.response.data.message) {
        errorMessage = `NOWPayments API error: ${error.response.data.message}`;
      }
    } else if (error.request) {
      // No response received
      errorMessage = 'No response received from payment provider';
    }
    
    res.status(500).json({ error: errorMessage });
  }
});

// Create a MOCK deposit (for testing without real payments)
app.post('/api/payment/deposit-test', authMiddleware, async (req, res) => {
  const { amount, currency } = req.body;
  if (!amount || !currency) return res.status(400).json({ error: 'Amount and currency required' });

  try {
    // Generate a mock deposit URL that can be used for testing
    const mockUrl = `${FRONTEND_URL}/mock-payment?amount=${amount}&currency=${currency}&userId=${req.userId}`;
    
    res.json({
      deposit_url: mockUrl,
      deposit_id: `mock_${Date.now()}`,
      test: true
    });
  } catch (error) {
    logger.error('Mock deposit error:', error);
    res.status(500).json({ error: 'Failed to create mock deposit' });
  }
});

// Webhook handler (NowPayments calls this when payment is confirmed)
app.post('/api/payment/webhook', async (req, res) => {
  try {
    // Log the raw webhook
    logger.info('Payment webhook received:', req.body);
    
    // Verify signature if provided
    const signature = req.headers['x-nowpayments-sig'];
    if (signature) {
      let expectedSig;
      
      try {
        // Calculate expected signature using raw body
        expectedSig = crypto
          .createHmac('sha256', NOWPAYMENTS_IPN_SECRET)
          .update(req.rawBody)
          .digest('hex');
      } catch (err) {
        logger.error('Error calculating webhook signature:', err);
        return res.status(500).json({ error: 'Internal server error' });
      }

      if (signature !== expectedSig) {
        logger.warn('⚠️ Invalid webhook signature');
        return res.status(403).json({ error: 'Invalid signature' });
      }
    } else {
      logger.warn('No webhook signature provided');
    }

    const { payment_status, order_id, price_amount } = req.body;
    
    if (!order_id || !order_id.startsWith('deposit_')) {
      logger.warn('Invalid order ID format:', order_id);
      return res.status(400).json({ error: 'Invalid order ID format' });
    }
    
    // Extract user ID from order_id (format: deposit_userId_timestamp)
    const userId = order_id.split('_')[1];
    
    // Check if this payment was already processed (idempotency)
    const paymentId = req.body.payment_id || req.body.invoice_id;
    const existingPayment = await Wager.findOne({ 
      'meta.paymentId': paymentId,
      'meta.processed': true 
    });
    
    if (existingPayment) {
      logger.warn(`Payment ${paymentId} already processed`);
      return res.status(200).json({ message: 'Payment already processed' });
    }
    
    if (payment_status === 'finished' || payment_status === 'confirmed') {
      if (!userId) {
        logger.error('Invalid order ID format:', order_id);
        return res.status(400).json({ error: 'Invalid order ID format' });
      }
      
      const user = await User.findById(userId);
      
      if (!user) {
        logger.error('User not found for deposit:', userId);
        return res.status(404).json({ error: 'User not found' });
      }

      // Credit balance
      const amount = parseFloat(price_amount);
      user.balance += amount;
      
      // Update deposit status
      if (req.body.invoice_id) {
        await User.findOneAndUpdate(
          { _id: userId, "depositRequests.depositId": req.body.invoice_id },
          { $set: { "depositRequests.$.status": "completed" } }
        );
      }
      
      await user.save();

      // Create a transaction record
      const transaction = new Wager({
        userId,
        amount,
        gameType: 'deposit',
        outcome: 'none',
        profit: amount,
        meta: {
          paymentId,
          processed: true,
          paymentDetails: req.body
        }
      });
      
      await transaction.save();

      // Notify frontend in real-time
      io.to(`user-${userId}`).emit('balance_update', {
        newBalance: user.balance,
        amount: amount,
        transaction: {
          id: transaction._id,
          type: 'deposit',
          amount,
          timestamp: new Date()
        }
      });

      logger.info(`💰 Deposit success: User ${userId} +$${amount}`);
      return res.status(200).json({ success: true });
    }

    // For other payment statuses, just log and acknowledge
    logger.info(`Payment status update: ${payment_status} for ${order_id}`);
    res.status(200).json({ received: true });
  } catch (err) {
    logger.error('Webhook processing error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// Mock payment webhook for testing
app.post('/api/payment/webhook-test', authMiddleware, async (req, res) => {
  const { amount, userId } = req.body;
  
  if (!amount || !userId) {
    return res.status(400).json({ error: 'Amount and userId required' });
  }
  
  try {
    const user = await User.findById(userId || req.userId);
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    // Credit balance
    user.balance += parseFloat(amount);
    await user.save();
    
    // Notify frontend in real-time
    io.to(`user-${userId}`).emit('balance_update', {
      newBalance: user.balance,
      amount,
      test: true
    });
    
    logger.info(`Test deposit: User ${userId} +$${amount}`);
    res.json({ success: true });
  } catch (err) {
    logger.error('Test webhook error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Add balance manually
app.post('/api/user/add-balance', authMiddleware, async (req, res) => {
  const { amount } = req.body;

  if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });

  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Generate transaction ID
    const transactionId = generateTransactionId();
    
    // Verify not a duplicate transaction
    if (!verifyTransaction(transactionId, req.userId, amount, 'add_balance')) {
      return res.status(429).json({ error: 'Duplicate balance update. Please wait before trying again.' });
    }

    user.balance += amount;
    await user.save();

    // Create a transaction record
    const transaction = new Wager({
      userId: req.userId,
      amount,
      gameType: 'admin_credit',
      outcome: 'none',
      profit: amount
    });
    
    await transaction.save();

    logger.info(`Manual balance update: User ${req.userId} +$${amount}`);
    res.json({ 
      message: 'Balance updated successfully', 
      balance: user.balance,
      transaction: {
        id: transaction._id,
        amount,
        timestamp: new Date()
      }
    });
  } catch (err) {
    logger.error('Add balance error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Withdraw endpoint (enhanced)
app.post('/api/payment/withdraw', authMiddleware, async (req, res) => {
  const { amount, currency, address } = req.body;
  
  if (!amount || !currency || !address) {
    return res.status(400).json({ error: 'Amount, currency and address are required' });
  }

  // Validate amount
  if (amount < 50) {
    return res.status(400).json({ error: 'Minimum withdrawal amount is $50' });
  }

  // Validate currency
  const allowedCurrencies = ['BTC', 'ETH', 'USDT', 'LTC'];
  if (!allowedCurrencies.includes(currency)) {
    return res.status(400).json({ error: 'Unsupported currency' });
  }

  // Validate address (basic validation, would need to be improved for production)
  if (address.length < 15) {
    return res.status(400).json({ error: 'Invalid cryptocurrency address' });
  }

  try {
    const user = await User.findById(req.userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Check for KYC verification if required
    if (amount > 1000 && !user.kycVerified) {
      return res.status(403).json({ error: 'KYC verification required for withdrawals over $1000' });
    }

    // Check for minimum wagering requirement to prevent abuse
    if (user.totalWagered < amount * 1.5) {
      return res.status(403).json({ 
        error: 'Wagering requirement not met',
        details: {
          totalWagered: user.totalWagered,
          required: amount * 1.5,
          remaining: amount * 1.5 - user.totalWagered
        }
      });
    }

    if (user.balance < amount) {
      return res.status(400).json({ error: 'Insufficient balance' });
    }

    // Generate transaction ID
    const transactionId = generateTransactionId();
    
    // Verify not a duplicate transaction
    if (!verifyTransaction(transactionId, req.userId, amount, 'withdraw')) {
      return res.status(429).json({ error: 'Duplicate withdrawal request. Please wait before trying again.' });
    }

    // Deduct user balance
    user.balance -= amount;
    
    // Add to withdrawal history
    user.withdrawals = user.withdrawals || [];
    user.withdrawals.push({
      amount,
      currency,
      address,
      status: 'pending',
      timestamp: new Date(),
      transactionId
    });
    
    await user.save();

    // Create a transaction record
    const transaction = new Wager({
      userId: req.userId,
      amount,
      gameType: 'withdrawal',
      outcome: 'none',
      profit: -amount,
      meta: {
        currency,
        address,
        status: 'pending',
        transactionId
      }
    });
    
    await transaction.save();

    // Send notification to Discord
    const discordWebhookUrl = process.env.DISCORD_WEBHOOK_URL;
    if (discordWebhookUrl) {
      const embed = {
        title: 'New Withdrawal Request',
        color: 0xff0000,
        fields: [
          { name: 'User', value: user.username, inline: true },
          { name: 'Amount', value: `$${amount}`, inline: true },
          { name: 'Currency', value: currency, inline: true },
          { name: 'Address', value: address },
          { name: 'Transaction ID', value: transactionId },
          { name: 'Timestamp', value: new Date().toISOString() }
        ],
      };

      try {
        await axios.post(discordWebhookUrl, { embeds: [embed] });
      } catch (error) {
        logger.error('Discord webhook error:', error);
        // Continue even if Discord notification fails
      }
    }

    logger.info(`Withdrawal request: User ${user.username} $${amount} ${currency} to ${address}`);
    res.json({ 
      message: 'Withdrawal request submitted successfully',
      transactionId,
      estimatedTime: '24-48 hours'
    });
  } catch (err) {
    logger.error('Withdrawal error:', err);
    res.status(500).json({ error: 'Failed to process withdrawal' });
  }
});

// Tip endpoint (enhanced)
app.post('/api/user/tip', authMiddleware, async (req, res) => {
  const { recipientUsername, amount } = req.body;

  if (!recipientUsername || !amount || amount <= 0) {
    return res.status(400).json({ error: 'Recipient and positive amount are required' });
  }

  // Maximum tip amount
  if (amount > 1000) {
    return res.status(400).json({ error: 'Maximum tip amount is $1000' });
  }

  try {
    const sender = await User.findById(req.userId);
    if (!sender) return res.status(404).json({ error: 'Sender not found' });

    if (sender.balance < amount) {
      return res.status(400).json({ error: 'Insufficient balance' });
    }

    const recipient = await User.findOne({ username: recipientUsername });
    if (!recipient) return res.status(404).json({ error: 'Recipient not found' });

    // Prevent self-tipping
    if (sender._id.toString() === recipient._id.toString()) {
      return res.status(400).json({ error: 'You cannot tip yourself' });
    }

    // Generate transaction ID
    const transactionId = generateTransactionId();
    
    // Verify not a duplicate transaction
    if (!verifyTransaction(transactionId, req.userId, amount, 'tip')) {
      return res.status(429).json({ error: 'Duplicate tip request. Please wait before trying again.' });
    }

    sender.balance -= amount;
    recipient.balance += amount;

    // Track tip in sender and recipient history
    sender.tipsSent = sender.tipsSent || [];
    sender.tipsSent.push({
      amount,
      recipient: recipient.username,
      timestamp: new Date(),
      transactionId
    });

    recipient.tipsReceived = recipient.tipsReceived || [];
    recipient.tipsReceived.push({
      amount,
      sender: sender.username,
      timestamp: new Date(),
      transactionId
    });

    await sender.save();
    await recipient.save();

    // Notify recipient in real-time
    io.to(`user-${recipient._id}`).emit('new_tip', {
      amount,
      sender: sender.username,
      timestamp: new Date(),
      newBalance: recipient.balance
    });

    logger.info(`Tip: ${sender.username} -> ${recipient.username}: $${amount}`);
    res.json({ 
      message: `Successfully tipped $${amount} to ${recipientUsername}`,
      newBalance: sender.balance
    });
  } catch (err) {
    logger.error('Tip error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Coinflip game endpoint
app.post('/api/game/coinflip', authMiddleware, async (req, res) => {
  const { amount, choice } = req.body;
  if (!amount || amount <= 0 || !['heads', 'tails'].includes(choice)) {
    return res.status(400).json({ error: 'Invalid bet' });
  }

  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.balance < amount) return res.status(400).json({ error: 'Insufficient balance' });

    // Generate transaction ID
    const transactionId = generateTransactionId();
    
    // Verify not a duplicate transaction
    if (!verifyTransaction(transactionId, req.userId, amount, 'coinflip')) {
      return res.status(429).json({ error: 'Duplicate bet. Please wait before trying again.' });
    }

    // Record the wager
    const wager = await recordWager(req.userId, 'coinflip', amount);
    
    // Track wager in user stats
    await user.trackWager(amount, 'coinflip');

    // Generate provably fair result
    const serverSeed = crypto.randomBytes(16).toString('hex');
    const hash = crypto.createHash('sha256').update(serverSeed).digest('hex');
    
    const outcome = parseInt(hash.slice(0, 8), 16) % 100 < 46 ? 'heads' : 'tails';
    const win = outcome === choice;
    
    let profit = 0;
    if (win) {
      profit = amount;
      user.balance += amount;
    } else {
      profit = -amount;
      user.balance -= amount;
    }

    // Record game outcome
    await user.recordGameOutcome(win, Math.abs(profit));
    await user.save();
    
    // Update wager outcome
    await updateWagerOutcome(wager._id, win ? 'win' : 'loss', profit);

    // Track high win
    if (win && amount >= 100) {
      io.emit('high_win', {
        username: user.username,
        game: 'coinflip',
        profit: amount,
        choice,
        outcome
      });
    }

    logger.info(`Coinflip: ${user.username} bet $${amount} on ${choice}, outcome: ${outcome}, ${win ? 'win' : 'loss'}`);
    res.json({
      outcome,
      win,
      newBalance: user.balance,
      serverSeed,
      hash,
    });
  } catch (err) {
    logger.error('Coinflip error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// User stats endpoint
app.get('/api/user/stats', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    
    // Get user's wagering stats
    const wagerStats = await Wager.aggregate([
      { $match: { userId: mongoose.Types.ObjectId(req.userId) } },
      { $group: {
          _id: "$gameType",
          totalWagered: { $sum: "$amount" },
          totalGames: { $sum: 1 },
          wins: { $sum: { $cond: [{ $eq: ["$outcome", "win"] }, 1, 0] } },
          losses: { $sum: { $cond: [{ $eq: ["$outcome", "loss"] }, 1, 0] } }
        }
      }
    ]);
    
    // Get referral stats
    const referralStats = await user.getReferralStats();
    
    // Calculate win rate
    const winRate = user.gamesPlayed > 0 ? (user.gamesWon / user.gamesPlayed) * 100 : 0;
    
    res.json({
      username: user.username,
      displayName: user.displayName || user.username,
      avatar: user.avatar,
      balance: user.balance,
      referralCode: user.referralCode,
      referralLink: user.getReferralLink(),
      totalWagered: user.totalWagered,
      referralEarnings: user.referralEarnings,
      referralCount: user.referralCount,
      gamesPlayed: user.gamesPlayed,
      gamesWon: user.gamesWon,
      gamesLost: user.gamesLost,
      winRate: winRate.toFixed(2),
      totalProfit: user.totalProfit,
      highestWin: user.highestWin,
      createdAt: user.createdAt,
      lastLogin: user.lastLoginTime,
      referralStats,
      gameStats: wagerStats.reduce((acc, game) => {
        acc[game._id] = {
          totalWagered: game.totalWagered,
          totalGames: game.totalGames,
          wins: game.wins,
          losses: game.losses,
          winRate: game.totalGames > 0 ? (game.wins / game.totalGames * 100).toFixed(2) : '0.00'
        };
        return acc;
      }, {})
    });
  } catch (err) {
    logger.error('Error getting user stats:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get leaderboard
app.get('/api/leaderboard', async (req, res) => {
  try {
    const { type = 'wagered', timeframe = 'all' } = req.query;
    
    let filter = {};
    if (timeframe === 'day') {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      filter = { createdAt: { $gte: yesterday } };
    } else if (timeframe === 'week') {
      const lastWeek = new Date();
      lastWeek.setDate(lastWeek.getDate() - 7);
      filter = { createdAt: { $gte: lastWeek } };
    } else if (timeframe === 'month') {
      const lastMonth = new Date();
      lastMonth.setMonth(lastMonth.getMonth() - 1);
      filter = { createdAt: { $gte: lastMonth } };
    }
    
    let sort = {};
    if (type === 'wagered') {
      sort = { totalWagered: -1 };
    } else if (type === 'profit') {
      sort = { totalProfit: -1 };
    } else if (type === 'wins') {
      sort = { gamesWon: -1 };
    }
    
    const users = await User.find(filter)
      .select('username displayName avatar totalWagered totalProfit gamesWon gamesPlayed highestWin')
      .sort(sort)
      .limit(50);
    
    res.json(users.map(user => ({
      username: user.username,
      displayName: user.displayName || user.username,
      avatar: user.avatar,
      totalWagered: user.totalWagered,
      totalProfit: user.totalProfit,
      gamesWon: user.gamesWon,
      gamesPlayed: user.gamesPlayed,
      highestWin: user.highestWin,
      winRate: user.gamesPlayed > 0 ? ((user.gamesWon / user.gamesPlayed) * 100).toFixed(2) : '0.00'
    })));
  } catch (err) {
    logger.error('Leaderboard error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Admin endpoints
app.get('/api/admin/users', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { page = 1, limit = 20, search } = req.query;
    
    let query = {};
    if (search) {
      query = { username: { $regex: search, $options: 'i' } };
    }
    
    const users = await User.find(query)
      .select('-passwordHash')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit));
    
    const total = await User.countDocuments(query);
    
    res.json({
      users,
      totalPages: Math.ceil(total / limit),
      currentPage: page
    });
  } catch (err) {
    logger.error('Admin users error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/admin/user/:userId/update', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { userId } = req.params;
    const { balance, isAdmin } = req.body;
    
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    
    if (balance !== undefined) user.balance = balance;
    if (isAdmin !== undefined) user.isAdmin = isAdmin;
    
    await user.save();
    
    logger.info(`Admin update: User ${userId} updated by ${req.username}`);
    res.json({ message: 'User updated successfully' });
  } catch (err) {
    logger.error('Admin update user error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Referral routes
app.use('/api/referral', referralRouter);

// Wager routes
app.use('/api/wager', wagerRouter);

// Mount upgrader router
app.use('/api/upgrader', upgraderRouter);

// Error handling middleware
app.use((err, req, res, next) => {
  logger.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Start the server
const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  logger.info(`🚀 Server running on port ${PORT}`);
});
