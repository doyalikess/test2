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
const REFERRAL_REWARD_PERCENT = 1; // 1% of referred user's wagers

// Constants
const JWT_SECRET = process.env.JWT_SECRET || 'secret_key';
const NOWPAYMENTS_API_KEY = process.env.NOWPAYMENTS_API_KEY || 'H5RMGFD-DDJMKFB-QEKXXBP-6VA0PX1';
const NOWPAYMENTS_IPN_SECRET = process.env.NOWPAYMENTS_IPN_SECRET || crypto.randomBytes(16).toString('hex');
const CALLBACK_URL = 'https://test2-e7gb.onrender.com/api/payment/webhook';
const FRONTEND_URL = 'http://localhost:3000';

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

// Custom rate limiter implementation
class RateLimiter {
  constructor(windowMs, maxRequests, message) {
    this.windowMs = windowMs;
    this.maxRequests = maxRequests;
    this.message = message || { error: 'Too many requests, please try again later' };
    this.requests = new Map();
    
    // Clean up old requests every 5 minutes
    setInterval(() => this.cleanup(), 5 * 60 * 1000);
  }
  
  cleanup() {
    const now = Date.now();
    for (const [key, timestamps] of this.requests.entries()) {
      // Filter out timestamps that are older than the window
      const validTimestamps = timestamps.filter(ts => now - ts < this.windowMs);
      
      if (validTimestamps.length === 0) {
        this.requests.delete(key);
      } else {
        this.requests.set(key, validTimestamps);
      }
    }
  }
  
  middleware() {
    return (req, res, next) => {
      const key = req.ip || req.connection.remoteAddress;
      
      const now = Date.now();
      const requestTimestamps = this.requests.get(key) || [];
      
      // Filter out timestamps older than the window
      const validTimestamps = requestTimestamps.filter(ts => now - ts < this.windowMs);
      
      if (validTimestamps.length < this.maxRequests) {
        // Add current timestamp and store
        validTimestamps.push(now);
        this.requests.set(key, validTimestamps);
        
        next();
      } else {
        // Rate limit exceeded
        res.status(429).json(this.message);
      }
    };
  }
}

// Create rate limiters
const authLimiter = new RateLimiter(
  15 * 60 * 1000, // 15 minutes
  20, // limit each IP to 20 requests per window
  { error: 'Too many login attempts, please try again later' }
);

const apiLimiter = new RateLimiter(
  60 * 1000, // 1 minute
  60, // limit each IP to 60 requests per minute
  { error: 'Too many requests, please try again later' }
);

// Cache for crypto prices
const cryptoPriceCache = {
  prices: {},
  lastFetch: 0,
  cacheDuration: 5 * 60 * 1000, // 5 minutes
};

// Advanced security tracking
const securityEvents = {
  loginAttempts: new Map(), // IP -> [timestamps]
  suspiciousActivities: [], // Array of suspicious events
  blockedIPs: new Set(), // Set of blocked IPs
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

// Unwagered deposit tracking for wagering requirements
let WAGER_REQUIREMENT_MULTIPLIER = 1.0; // Users must wager 1x their deposit amount (default)

// User level system configuration - 100 levels, with level 50 at $1,000 wagered
const USER_LEVELS = [];

// Colors to cycle through for different level ranges
const levelColors = [
  "#a9b1d6", // Levels 1-10
  "#7aa2f7", // Levels 11-20
  "#9ece6a", // Levels 21-30
  "#e0af68", // Levels 31-40
  "#f7768e", // Levels 41-50
  "#bb9af7", // Levels 51-60
  "#2ac3de", // Levels 61-70
  "#ff9e64", // Levels 71-80
  "#c0caf5", // Levels 81-90
  "#73daca"  // Levels 91-100
];

// Generate 100 levels with appropriate scaling
for (let i = 1; i <= 100; i++) {
  let requiredWagering;
  
  // Levels 1-50: Linear progression to $1,000
  if (i <= 50) {
    requiredWagering = Math.floor((i - 1) * (1000 / 50));
  } 
  // Levels 51-75: Progress to $5,000
  else if (i <= 75) {
    requiredWagering = 1000 + Math.floor((i - 50) * (4000 / 25));
  }
  // Levels 76-90: Progress to $10,000
  else if (i <= 90) {
    requiredWagering = 5000 + Math.floor((i - 75) * (5000 / 15));
  }
  // Levels 91-100: Progress to $25,000
  else {
    requiredWagering = 10000 + Math.floor((i - 90) * (15000 / 10));
  }
  
  // Calculate max bet based on level (increases with level)
  const maxBet = Math.min(100 * i, 10000);
  
  // Select color based on level range
  const colorIndex = Math.floor((i - 1) / 10);
  const color = levelColors[colorIndex % levelColors.length];
  
  // Special name for milestone levels, otherwise just the level number
  let name;
  if (i === 1) name = "Rookie";
  else if (i === 25) name = "Adept";
  else if (i === 50) name = "Master";
  else if (i === 75) name = "Expert";
  else if (i === 100) name = "Legend";
  else name = `Level ${i}`;
  
  USER_LEVELS.push({
    level: i,
    name,
    requiredWagering,
    color,
    rewards: { maxBet }
  });
}

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

// Default/fallback prices for when API is unavailable
const defaultCryptoPrices = {
  BTC: {
    price: 65000,
    change24h: 1.2
  },
  ETH: {
    price: 3500,
    change24h: 0.8
  },
  LTC: {
    price: 80,
    change24h: -0.5
  },
  USDT: {
    price: 1,
    change24h: 0
  }
};

// Fetch current cryptocurrency prices
async function fetchCryptoPrices() {
  const now = Date.now();
  
  // Return cached prices if they're still fresh
  if (now - cryptoPriceCache.lastFetch < cryptoPriceCache.cacheDuration && 
      Object.keys(cryptoPriceCache.prices).length > 0) {
    return cryptoPriceCache.prices;
  }
  
  try {
    // Fetch from CoinGecko API (free and doesn't require API key)
    const response = await axios.get(
      'https://api.coingecko.com/api/v3/simple/price',
      {
        params: {
          ids: 'bitcoin,ethereum,litecoin,tether',
          vs_currencies: 'usd',
          include_24hr_change: true
        },
        timeout: 5000 // 5 second timeout
      }
    );
    
    // Map to simpler format
    const prices = {
      BTC: {
        price: response.data.bitcoin.usd,
        change24h: response.data.bitcoin.usd_24h_change
      },
      ETH: {
        price: response.data.ethereum.usd,
        change24h: response.data.ethereum.usd_24h_change
      },
      LTC: {
        price: response.data.litecoin.usd,
        change24h: response.data.litecoin.usd_24h_change
      },
      USDT: {
        price: response.data.tether.usd,
        change24h: response.data.tether.usd_24h_change
      }
    };
    
    // Update cache
    cryptoPriceCache.prices = prices;
    cryptoPriceCache.lastFetch = now;
    
    // Extend cache duration if we hit rate limits
    if (response.headers && response.headers['x-ratelimit-remaining'] === '0') {
      const resetTime = parseInt(response.headers['x-ratelimit-reset'] || '0') * 1000;
      if (resetTime > 0) {
        const timeToReset = resetTime - Date.now();
        if (timeToReset > 0) {
          cryptoPriceCache.cacheDuration = Math.max(cryptoPriceCache.cacheDuration, timeToReset + 10000);
          logger.warn(`CoinGecko rate limit hit, extending cache duration to ${cryptoPriceCache.cacheDuration / 1000} seconds`);
        }
      }
    }
    
    return prices;
  } catch (error) {
    logger.error('Error fetching crypto prices:', error);
    
    // If we hit rate limits, extend cache duration
    if (error.response && error.response.status === 429) {
      const retryAfter = parseInt(error.response.headers['retry-after'] || '60');
      cryptoPriceCache.cacheDuration = Math.max(cryptoPriceCache.cacheDuration, (retryAfter + 5) * 1000);
      logger.warn(`CoinGecko rate limit hit (429), extending cache duration to ${cryptoPriceCache.cacheDuration / 1000} seconds`);
    }
    
    // Return cached prices if available, fallback data if not
    return cryptoPriceCache.prices || defaultCryptoPrices;
  }
}

// Calculate USD to crypto conversion
function calculateCryptoAmount(usdAmount, cryptoPrice) {
  if (!cryptoPrice || cryptoPrice <= 0) {
    return 0;
  }
  
  return parseFloat((usdAmount / cryptoPrice).toFixed(8));
}

// Track suspicious activity
function trackSuspiciousActivity(type, details) {
  securityEvents.suspiciousActivities.push({
    type,
    details,
    timestamp: new Date()
  });
  
  // Keep only last 1000 events
  if (securityEvents.suspiciousActivities.length > 1000) {
    securityEvents.suspiciousActivities.shift();
  }
  
  // Log suspicious activity
  logger.warn(`Suspicious activity detected: ${type}`, details);
}

// Helper function to update user level based on total wagering
function updateUserLevel(user) {
  if (!user) return;
  
  // Initialize level data if not present
  if (!user.level) {
    user.level = {
      current: 1,
      progress: 0,
      totalWagered: user.totalWagered || 0
    };
  }
  
  // Update total wagered in level data
  user.level.totalWagered = user.totalWagered || 0;
  
  // Find current level based on total wagering
  let currentLevel = USER_LEVELS[0]; // Default to level 1
  let nextLevel = USER_LEVELS[1]; // Default to level 2
  
  for (let i = USER_LEVELS.length - 1; i >= 0; i--) {
    if (user.totalWagered >= USER_LEVELS[i].requiredWagering) {
      currentLevel = USER_LEVELS[i];
      nextLevel = USER_LEVELS[i + 1] || currentLevel;
      break;
    }
  }
  
  // Calculate progress to next level (0-100%)
  let progress = 0;
  if (nextLevel && nextLevel !== currentLevel) {
    const currentWagering = user.totalWagered - currentLevel.requiredWagering;
    const requiredForNextLevel = nextLevel.requiredWagering - currentLevel.requiredWagering;
    
    // Ensure we don't divide by zero if levels are too close together
    if (requiredForNextLevel > 0) {
      progress = Math.min(Math.floor((currentWagering / requiredForNextLevel) * 100), 99);
    } else {
      progress = 99; // Almost at next level if difference is too small
    }
  } else {
    // Max level reached
    progress = 100;
  }
  
  // Only emit level up event if level has increased
  if (currentLevel.level > (user.level.current || 1)) {
    // If user gained multiple levels at once, we still emit just one event for the highest level
    // but we log each level gain for tracking purposes
    for (let lvl = (user.level.current || 1) + 1; lvl <= currentLevel.level; lvl++) {
      logger.info(`User ${user._id} leveled up to ${lvl}`);
    }
    
    // Emit level up event to the user's room
    io.to(`user-${user._id}`).emit('level_up', {
      oldLevel: user.level.current,
      newLevel: currentLevel.level,
      levelName: currentLevel.name,
      rewards: currentLevel.rewards
    });
    
    logger.info(`User ${user._id} leveled up from ${user.level.current} to ${currentLevel.level}`);
  }
  
  // Update user level data
  user.level.current = currentLevel.level;
  user.level.name = currentLevel.name;
  user.level.color = currentLevel.color;
  user.level.progress = progress;
  user.level.nextLevel = nextLevel !== currentLevel ? nextLevel.level : null;
  user.level.nextLevelName = nextLevel !== currentLevel ? nextLevel.name : null;
  user.level.requiredWageringForNextLevel = nextLevel !== currentLevel ? nextLevel.requiredWagering : null;
}

// Check if IP is blocked
function isIPBlocked(ip) {
  return securityEvents.blockedIPs.has(ip);
}

// Track login attempt
function trackLoginAttempt(ip, success, username) {
  const attempts = securityEvents.loginAttempts.get(ip) || [];
  
  attempts.push({
    timestamp: Date.now(),
    success,
    username
  });
  
  // Keep only last 10 attempts
  if (attempts.length > 10) {
    attempts.shift();
  }
  
  securityEvents.loginAttempts.set(ip, attempts);
  
  // Check for brute force attacks
  const recentAttempts = attempts.filter(a => Date.now() - a.timestamp < 10 * 60 * 1000); // Last 10 minutes
  const failedAttempts = recentAttempts.filter(a => !a.success);
  
  if (failedAttempts.length >= 5) {
    securityEvents.blockedIPs.add(ip);
    trackSuspiciousActivity('brute_force', { ip, failedAttempts });
  }
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
      
      // Track wager in user stats and reduce unwagered amount
      // Process unwagered amount for wagering requirements
      if (user.unwageredAmount === undefined) {
        user.unwageredAmount = 0;
      }
      
      // Track wagering progress for requirements
      if (!user.wageringProgress) {
        user.wageringProgress = {
          totalDeposited: user.unwageredAmount || 0,
          totalWageredSinceDeposit: 0
        };
      }
      
      // Add this wager to total wagered
      user.wageringProgress.totalWageredSinceDeposit += bet;
      
      // Check if wagering requirement is now met
      const requiredWagering = user.wageringProgress.totalDeposited * WAGER_REQUIREMENT_MULTIPLIER;
      if (user.wageringProgress.totalWageredSinceDeposit >= requiredWagering) {
        // Requirement met - reset counters
        user.unwageredAmount = 0;
        user.wageringProgress = {
          totalDeposited: 0,
          totalWageredSinceDeposit: 0
        };
        logger.info(`User ${userId} completed wagering requirements! Total wagered: $${user.wageringProgress.totalWageredSinceDeposit}, Required: $${requiredWagering}`);
      } else {
        // Still have requirements to meet
        const remaining = requiredWagering - user.wageringProgress.totalWageredSinceDeposit;
        user.unwageredAmount = remaining;
        logger.info(`User ${userId} wagered $${bet} in jackpot, total wagered: $${user.wageringProgress.totalWageredSinceDeposit}, still need: $${remaining.toFixed(2)}`);
      }
      
      // Track wager stats
      user.totalWagered = (user.totalWagered || 0) + bet;
      
      // Initialize game stats
      if (!user.gameStats) {
        user.gameStats = new Map();
      }
      
      if (!user.gameStats.has('jackpot')) {
        user.gameStats.set('jackpot', {
          totalWagered: 0,
          totalGames: 0,
          wins: 0,
          losses: 0
        });
      }
      
      const gameStats = user.gameStats.get('jackpot');
      gameStats.totalWagered += bet;
      gameStats.totalGames += 1;
      user.gameStats.set('jackpot', gameStats);
      
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
      
      // Track wager in user stats and reduce unwagered amount
      // Process unwagered amount for wagering requirements
      if (user.unwageredAmount === undefined) {
        user.unwageredAmount = 0;
      }
      
      // Track wagering progress for requirements
      if (!user.wageringProgress) {
        user.wageringProgress = {
          totalDeposited: user.unwageredAmount || 0,
          totalWageredSinceDeposit: 0
        };
      }
      
      // Add this wager to total wagered
      user.wageringProgress.totalWageredSinceDeposit += betAmount;
      
      // Check if wagering requirement is now met
      const requiredWagering = user.wageringProgress.totalDeposited * WAGER_REQUIREMENT_MULTIPLIER;
      if (user.wageringProgress.totalWageredSinceDeposit >= requiredWagering) {
        // Requirement met - reset counters
        user.unwageredAmount = 0;
        user.wageringProgress = {
          totalDeposited: 0,
          totalWageredSinceDeposit: 0
        };
        logger.info(`User ${userId} completed wagering requirements! Total wagered: $${user.wageringProgress.totalWageredSinceDeposit}, Required: $${requiredWagering}`);
      } else {
        // Still have requirements to meet
        const remaining = requiredWagering - user.wageringProgress.totalWageredSinceDeposit;
        user.unwageredAmount = remaining;
        logger.info(`User ${userId} wagered $${betAmount} in mines, total wagered: $${user.wageringProgress.totalWageredSinceDeposit}, still need: $${remaining.toFixed(2)}`);
      }
      
      // Track wager stats
      user.totalWagered = (user.totalWagered || 0) + betAmount;
      
      // Initialize this game type in stats if it doesn't exist
      if (!user.gameStats) {
        user.gameStats = new Map();
      }
      
      if (!user.gameStats.has('mines')) {
        user.gameStats.set('mines', {
          totalWagered: 0,
          totalGames: 0,
          wins: 0,
          losses: 0
        });
      }
      
      // Update game stats
      const gameStats = user.gameStats.get('mines');
      gameStats.totalWagered += betAmount;
      gameStats.totalGames += 1;
      user.gameStats.set('mines', gameStats);
      
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
      
      // Track wager in user stats and reduce unwagered amount
      // Process unwagered amount for wagering requirements
      if (user.unwageredAmount === undefined) {
        user.unwageredAmount = 0;
      }
      
      // Track wagering progress for requirements
      if (!user.wageringProgress) {
        user.wageringProgress = {
          totalDeposited: user.unwageredAmount || 0,
          totalWageredSinceDeposit: 0
        };
      }
      
      // Add this wager to total wagered
      user.wageringProgress.totalWageredSinceDeposit += betAmount;
      
      // Check if wagering requirement is now met
      const requiredWagering = user.wageringProgress.totalDeposited * WAGER_REQUIREMENT_MULTIPLIER;
      if (user.wageringProgress.totalWageredSinceDeposit >= requiredWagering) {
        // Requirement met - reset counters
        user.unwageredAmount = 0;
        user.wageringProgress = {
          totalDeposited: 0,
          totalWageredSinceDeposit: 0
        };
        logger.info(`User ${userId} completed wagering requirements! Total wagered: $${user.wageringProgress.totalWageredSinceDeposit}, Required: $${requiredWagering}`);
      } else {
        // Still have requirements to meet
        const remaining = requiredWagering - user.wageringProgress.totalWageredSinceDeposit;
        user.unwageredAmount = remaining;
        logger.info(`User ${userId} wagered $${betAmount} in limbo, total wagered: $${user.wageringProgress.totalWageredSinceDeposit}, still need: $${remaining.toFixed(2)}`);
      }
      
      // Track wager stats
      user.totalWagered = (user.totalWagered || 0) + betAmount;
      
      // Initialize game stats
      if (!user.gameStats) {
        user.gameStats = new Map();
      }
      
      if (!user.gameStats.has('limbo')) {
        user.gameStats.set('limbo', {
          totalWagered: 0,
          totalGames: 0,
          wins: 0,
          losses: 0
        });
      }
      
      const gameStats = user.gameStats.get('limbo');
      gameStats.totalWagered += betAmount;
      gameStats.totalGames += 1;
      user.gameStats.set('limbo', gameStats);
      
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

// Security middleware - check for blocked IPs
app.use((req, res, next) => {
  const ip = req.ip || req.connection.remoteAddress;
  
  if (isIPBlocked(ip)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  
  next();
});

// Middleware to capture raw body (needed for webhook signature verification)
const rawBodySaver = (req, res, buf, encoding) => {
  if (buf && buf.length) {
    req.rawBody = buf.toString(encoding || 'utf8');
  }
};
app.use(express.json({ verify: rawBodySaver }));

// Apply rate limiters
app.use('/api/auth/', authLimiter.middleware());
app.use('/api/', apiLimiter.middleware());

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
    version: '1.3.0'
  });
});

// Get cryptocurrency prices
app.get('/api/crypto/prices', async (req, res) => {
  try {
    const prices = await fetchCryptoPrices();
    res.json(prices);
  } catch (error) {
    logger.error('Error in crypto prices endpoint:', error);
    res.status(500).json({ error: 'Failed to fetch cryptocurrency prices' });
  }
});

// Calculate crypto conversion
app.get('/api/crypto/convert', async (req, res) => {
  const { amount, from, to } = req.query;
  
  if (!amount || !from || !to) {
    return res.status(400).json({ error: 'Missing required parameters' });
  }
  
  try {
    const prices = await fetchCryptoPrices();
    
    // Convert amount based on current prices
    let result = 0;
    
    if (from === 'USD') {
      // USD to crypto
      if (prices[to]) {
        result = calculateCryptoAmount(parseFloat(amount), prices[to].price);
      }
    } else if (to === 'USD') {
      // Crypto to USD
      if (prices[from]) {
        result = parseFloat(amount) * prices[from].price;
      }
    } else {
      // Crypto to crypto
      if (prices[from] && prices[to]) {
        const usdValue = parseFloat(amount) * prices[from].price;
        result = calculateCryptoAmount(usdValue, prices[to].price);
      }
    }
    
    res.json({
      from,
      to,
      amount: parseFloat(amount),
      result: parseFloat(result.toFixed(8)),
      rate: from === 'USD' ? 1 / prices[to]?.price : prices[from]?.price
    });
  } catch (error) {
    logger.error('Error in crypto conversion endpoint:', error);
    res.status(500).json({ error: 'Failed to convert currencies' });
  }
});

// Transaction history endpoint
app.get('/api/user/transactions', authMiddleware, async (req, res) => {
  try {
    // Get user's wager history from Wager model
    const wagers = await Wager.find({ userId: req.userId })
      .sort({ createdAt: -1 })
      .limit(50);
    
    // Get unwagered amount and progress information
    const user = await User.findById(req.userId);
    const unwageredAmount = user?.unwageredAmount || 0;
    const wageringProgress = user?.wageringProgress || { totalDeposited: 0, totalWageredSinceDeposit: 0 };
    
    res.json({
      transactions: wagers,
      wagering: {
        unwageredAmount,
        requirementMultiplier: WAGER_REQUIREMENT_MULTIPLIER,
        canWithdraw: unwageredAmount <= 0,
        progress: {
          totalDeposited: wageringProgress.totalDeposited,
          totalWagered: wageringProgress.totalWageredSinceDeposit,
          required: wageringProgress.totalDeposited * WAGER_REQUIREMENT_MULTIPLIER,
          remaining: Math.max(0, (wageringProgress.totalDeposited * WAGER_REQUIREMENT_MULTIPLIER) - wageringProgress.totalWageredSinceDeposit)
        }
      }
    });
  } catch (err) {
    logger.error('Error fetching transactions:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get wagering status endpoint
app.get('/api/user/wagering-status', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    // Ensure unwageredAmount is initialized
    if (user.unwageredAmount === undefined) {
      user.unwageredAmount = 0;
      await user.save();
    }
    
    const wageringProgress = user.wageringProgress || { totalDeposited: 0, totalWageredSinceDeposit: 0 };
    
    res.json({
      unwageredAmount: user.unwageredAmount,
      requirementMultiplier: WAGER_REQUIREMENT_MULTIPLIER,
      canWithdraw: user.unwageredAmount <= 0,
      totalWagered: user.totalWagered || 0,
      progress: {
        totalDeposited: wageringProgress.totalDeposited,
        totalWagered: wageringProgress.totalWageredSinceDeposit,
        required: wageringProgress.totalDeposited * WAGER_REQUIREMENT_MULTIPLIER,
        remaining: Math.max(0, (wageringProgress.totalDeposited * WAGER_REQUIREMENT_MULTIPLIER) - wageringProgress.totalWageredSinceDeposit)
      }
    });
  } catch (err) {
    logger.error('Error fetching wagering status:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Signup
app.post('/api/auth/signup', async (req, res) => {
  const { username, password, referralCode } = req.body;
  const ip = req.ip || req.connection.remoteAddress;
  
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

  // Validate username format
  if (!/^[a-zA-Z0-9_]{3,16}$/.test(username)) {
    return res.status(400).json({ error: 'Username must be 3-16 characters and contain only letters, numbers, and underscores' });
  }

  // Validate password strength
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters long' });
  }
  
  // Check for password strength
  const hasUpperCase = /[A-Z]/.test(password);
  const hasLowerCase = /[a-z]/.test(password);
  const hasNumbers = /\d/.test(password);
  const hasSpecialChar = /[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(password);
  
  const passwordStrength = 
    (hasUpperCase ? 1 : 0) + 
    (hasLowerCase ? 1 : 0) + 
    (hasNumbers ? 1 : 0) + 
    (hasSpecialChar ? 1 : 0);
  
  if (passwordStrength < 3) {
    return res.status(400).json({ 
      error: 'Password too weak. Include uppercase, lowercase, numbers, and special characters.',
      passwordStrength
    });
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
    
    // Record IP address for security
    user.registrationIP = ip;
    user.ipHistory = [{ ip, timestamp: new Date() }];
    
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
  const ip = req.ip || req.connection.remoteAddress;
  
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

  try {
    const user = await User.findOne({ username });
    
    // Track login attempt
    if (!user) {
      trackLoginAttempt(ip, false, username);
      return res.status(400).json({ error: 'Invalid credentials' });
    }

    const valid = await user.validatePassword(password);
    if (!valid) {
      trackLoginAttempt(ip, false, username);
      return res.status(400).json({ error: 'Invalid credentials' });
    }
    
    // Login successful
    trackLoginAttempt(ip, true, username);
    
    // Update last login time and IP
    user.lastLoginTime = new Date();
    user.lastLoginIP = ip;
    
    // Update IP history
    user.ipHistory = user.ipHistory || [];
    user.ipHistory.push({ ip, timestamp: new Date() });
    
    // Keep only last 10 IP entries
    if (user.ipHistory.length > 10) {
      user.ipHistory = user.ipHistory.slice(-10);
    }
    
    // Check for suspicious location changes
    if (user.ipHistory.length > 1) {
      const previousIP = user.ipHistory[user.ipHistory.length - 2].ip;
      if (previousIP !== ip) {
        // This could be enhanced with actual geolocation checking
        trackSuspiciousActivity('ip_change', { 
          userId: user._id, 
          username: user.username,
          previousIP,
          newIP: ip
        });
      }
    }
    
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
  
  // Check for password strength
  const hasUpperCase = /[A-Z]/.test(newPassword);
  const hasLowerCase = /[a-z]/.test(newPassword);
  const hasNumbers = /\d/.test(newPassword);
  const hasSpecialChar = /[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(newPassword);
  
  const passwordStrength = 
    (hasUpperCase ? 1 : 0) + 
    (hasLowerCase ? 1 : 0) + 
    (hasNumbers ? 1 : 0) + 
    (hasSpecialChar ? 1 : 0);
  
  if (passwordStrength < 3) {
    return res.status(400).json({ 
      error: 'Password too weak. Include uppercase, lowercase, numbers, and special characters.',
      passwordStrength
    });
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
  if (amount < 1) {
    return res.status(400).json({ error: 'Minimum deposit amount is $1' });
  }

  const allowedCurrencies = ['BTC', 'ETH', 'LTC', 'USDT'];
  if (!allowedCurrencies.includes(currency.toUpperCase())) {
    return res.status(400).json({ error: 'Unsupported cryptocurrency' });
  }

  try {
    // Get current crypto prices to show approximate crypto amount
    const prices = await fetchCryptoPrices();
    const cryptoAmount = calculateCryptoAmount(amount, prices[currency.toUpperCase()]?.price || 0);
    
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
          cryptoAmount,
          status: 'pending',
          createdAt: new Date()
        }
      }
    });

    res.json({
      deposit_url: response.data.invoice_url,
      deposit_id: response.data.id,
      cryptoAmount,
      cryptoPrice: prices[currency.toUpperCase()]?.price || 0
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
    // Get current crypto prices to show approximate crypto amount
    const prices = await fetchCryptoPrices();
    const cryptoAmount = calculateCryptoAmount(amount, prices[currency.toUpperCase()]?.price || 0);
    
    // Generate a mock deposit URL that can be used for testing
    const mockUrl = `${FRONTEND_URL}/mock-payment?amount=${amount}&currency=${currency}&userId=${req.userId}&cryptoAmount=${cryptoAmount}`;
    
    res.json({
      deposit_url: mockUrl,
      deposit_id: `mock_${Date.now()}`,
      cryptoAmount,
      cryptoPrice: prices[currency.toUpperCase()]?.price || 0,
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
    
    // Determine if we're in production mode
    const isProduction = process.env.NODE_ENV === 'production' || process.env.STRICT_WEBHOOK_VALIDATION === 'true';
    
    // Verify signature if provided
    const signature = req.headers['x-nowpayments-sig'];
    if (signature && NOWPAYMENTS_IPN_SECRET && NOWPAYMENTS_IPN_SECRET !== 'your_ipn_secret_here') {
      let signatureIsValid = false;
      
      try {
        // Try different signature calculation methods that NOWPayments might use
        const bodyString = req.rawBody ? req.rawBody.toString() : JSON.stringify(req.body);
        const sortedBodyString = JSON.stringify(req.body, Object.keys(req.body).sort());
        const cleanBodyString = JSON.stringify(req.body);
        
        // Method 1: Use raw body as received
        const sig1 = crypto.createHmac('sha256', NOWPAYMENTS_IPN_SECRET).update(bodyString).digest('hex');
        
        // Method 2: Use sorted JSON keys
        const sig2 = crypto.createHmac('sha256', NOWPAYMENTS_IPN_SECRET).update(sortedBodyString).digest('hex');
        
        // Method 3: Use clean JSON without extra whitespace
        const sig3 = crypto.createHmac('sha256', NOWPAYMENTS_IPN_SECRET).update(cleanBodyString).digest('hex');
        
        // Method 4: Try with base64 encoding
        const sig4 = crypto.createHmac('sha256', NOWPAYMENTS_IPN_SECRET).update(bodyString).digest('base64');
        
        signatureIsValid = signature === sig1 || signature === sig2 || signature === sig3 || signature === sig4;
        
        logger.info('Signature verification:', {
          received: signature,
          method1_hex: sig1,
          method2_sorted: sig2,
          method3_clean: sig3,
          method4_base64: sig4,
          isValid: signatureIsValid,
          rawBodyLength: req.rawBody ? req.rawBody.length : 0,
          secretLength: NOWPAYMENTS_IPN_SECRET.length,
          isProduction
        });
        
        if (!signatureIsValid) {
          if (isProduction) {
            logger.error('🚫 Invalid webhook signature - rejecting payment in production mode');
            return res.status(403).json({ 
              error: 'Invalid signature',
              message: 'Webhook signature verification failed. Payment rejected for security.'
            });
          } else {
            logger.warn('⚠️ Invalid webhook signature - allowing in development mode (set NODE_ENV=production for strict validation)');
          }
        } else {
          logger.info('✅ Webhook signature verified successfully');
        }
        
      } catch (err) {
        logger.error('Error during signature verification:', err);
        if (isProduction) {
          return res.status(500).json({ 
            error: 'Signature verification failed',
            message: 'Unable to verify webhook authenticity'
          });
        } else {
          logger.warn('Signature verification error in development - continuing anyway');
        }
      }
    } else {
      const missingComponents = [];
      if (!signature) missingComponents.push('x-nowpayments-sig header');
      if (!NOWPAYMENTS_IPN_SECRET || NOWPAYMENTS_IPN_SECRET === 'your_ipn_secret_here') {
        missingComponents.push('IPN secret configuration');
      }
      
      if (isProduction && missingComponents.length > 0) {
        logger.error(`🚫 Missing required webhook security components in production: ${missingComponents.join(', ')}`);
        return res.status(400).json({ 
          error: 'Missing webhook verification data',
          message: 'Required security headers or configuration missing',
          missing: missingComponents
        });
      } else {
        logger.warn(`⚠️ Missing webhook security components (${missingComponents.join(', ')}) - allowing in development mode`);
      }
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
    
    // Check both Wager records and a simple processed payments tracking
    const existingPayment = await Wager.findOne({ 
      'meta.paymentId': paymentId,
      'meta.processed': true 
    });
    
    // Also check if we've seen this specific order_id + payment_status combination
    const processedKey = `${order_id}_${payment_status}_${paymentId}`;
    if (transactions.has(processedKey)) {
      logger.warn(`Payment ${paymentId} with status ${payment_status} already processed for order ${order_id}`);
      return res.status(200).json({ message: 'Payment already processed' });
    }
    
    // Also check if it's in the user's processedPayments array in the database
    const userWithProcessedPayment = await User.findOne({
      _id: userId,
      'processedPayments.orderKey': processedKey
    });
    
    if (userWithProcessedPayment) {
      logger.warn(`Payment ${paymentId} with status ${payment_status} found in user's processedPayments`);
      return res.status(200).json({ message: 'Payment already processed (from database)' });
    }
    
    if (existingPayment) {
      logger.warn(`Payment ${paymentId} already processed (found in Wager records)`);
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

      // Credit balance - set the balance exactly to previous balance + amount (no double credits)
      const amount = parseFloat(price_amount);
      const previousBalance = user.balance;
      
      // Set balance directly to avoid double crediting issues
      user.balance = previousBalance + amount;
      
      // Add to unwagered amount for wagering requirements (track total deposits that need wagering)
      if (!user.unwageredAmount) {
        user.unwageredAmount = 0;
      }
      user.unwageredAmount += amount;
      
      // Initialize wagering tracking if needed
      if (!user.wageringProgress) {
        user.wageringProgress = {
          totalDeposited: 0,
          totalWageredSinceDeposit: 0
        };
      }
      
      // Track this deposit
      user.wageringProgress.totalDeposited += amount;
      
      logger.info(`Processing deposit for user ${userId}: $${amount} (${previousBalance} -> ${user.balance}, unwagered: ${user.unwageredAmount})`);
      
      // Update deposit status
      if (req.body.invoice_id) {
        await User.findOneAndUpdate(
          { _id: userId, "depositRequests.depositId": req.body.invoice_id },
          { 
            $set: { 
              "depositRequests.$.status": "completed"
            }
          }
        );
      }
      
      await user.save();
      logger.info(`User balance saved: ${user.balance}`);

      // Create a transaction record using recordWager helper to ensure proper validation
      try {
        const transaction = await recordWager(userId, 'manual', amount, {
          type: 'deposit',
          paymentId,
          processed: true,
          paymentDetails: req.body
        });
        
        // Update the wager to reflect it as a deposit (win outcome, profit = amount)
        await updateWagerOutcome(transaction._id, 'win', amount);
        
        logger.info(`Transaction record created: ${transaction._id}`);
      } catch (wagerError) {
        logger.error('Failed to create transaction record:', wagerError);
        // Continue processing even if transaction record fails
      }

      // Notify frontend in real-time
      const notificationData = {
        newBalance: user.balance,
        amount: amount,
        transaction: {
          id: paymentId,
          type: 'deposit',
          amount,
          timestamp: new Date()
        }
      };
      
      logger.info(`Sending balance update notification to user-${userId}:`, notificationData);
      io.to(`user-${userId}`).emit('balance_update', notificationData);

      // Mark this payment as processed to prevent duplicates (in-memory)
      const timestamp = new Date();
      transactions.set(processedKey, {
        timestamp,
        userId,
        amount,
        paymentId
      });
      
      // Also store in database for persistent storage
      try {
        await User.findByIdAndUpdate(userId, {
          $addToSet: {
            processedPayments: {
              paymentId,
              orderKey: processedKey,
              status: payment_status,
              amount,
              createdAt: timestamp
            }
          }
        });
        logger.info(`Added payment ${paymentId} to user's processedPayments array`);
      } catch (err) {
        logger.warn(`Failed to add payment to user's processedPayments array: ${err.message}`);
        // Continue processing even if this fails
      }
      
      // Clean up old transactions from memory (keep only last 1000)
      if (transactions.size > 1000) {
        const entries = Array.from(transactions.entries());
        entries.sort((a, b) => a[1].timestamp - b[1].timestamp);
        entries.slice(0, 500).forEach(([key]) => transactions.delete(key));
      }

      logger.info(`💰 Deposit success: User ${userId} +$${amount} (Payment ID: ${paymentId})`);
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
      gameType: 'deposit',
      outcome: 'win',
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

  // Validate address format based on currency
  let validAddress = false;
  
  if (currency === 'BTC') {
    // Basic Bitcoin address validation
    validAddress = /^(bc1|[13])[a-zA-HJ-NP-Z0-9]{25,62}$/.test(address);
  } else if (currency === 'ETH') {
    // Basic Ethereum address validation
    validAddress = /^0x[a-fA-F0-9]{40}$/.test(address);
  } else if (currency === 'LTC') {
    // Basic Litecoin address validation
    validAddress = /^[LM3][a-km-zA-HJ-NP-Z1-9]{26,33}$/.test(address);
  } else if (currency === 'USDT') {
    // USDT can be on multiple chains, accept Ethereum format
    validAddress = /^0x[a-fA-F0-9]{40}$/.test(address);
  }
  
  if (!validAddress) {
    return res.status(400).json({ error: `Invalid ${currency} address format` });
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

    // Check for unwagered deposits
    if (!user.unwageredAmount) {
      user.unwageredAmount = 0;
    }
    
    if (user.unwageredAmount > 0) {
      return res.status(403).json({
        error: 'Wagering requirement not met',
        details: {
          unwageredAmount: user.unwageredAmount,
          message: `You must wager $${user.unwageredAmount.toFixed(2)} before withdrawing`,
          requirement: `${WAGER_REQUIREMENT_MULTIPLIER}x deposit amount`
        }
      });
    }
    
    // Legacy check (remove in future versions)
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
    
    // Get crypto price for informational purposes
    const prices = await fetchCryptoPrices();
    const cryptoAmount = calculateCryptoAmount(amount, prices[currency]?.price || 0);

    // Deduct user balance
    user.balance -= amount;
    
    // Add to withdrawal history
    user.withdrawals = user.withdrawals || [];
    user.withdrawals.push({
      amount,
      currency,
      cryptoAmount,
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
      outcome: 'loss',
      profit: -amount,
      meta: {
        currency,
        cryptoAmount,
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
          { name: 'Crypto Amount', value: `${cryptoAmount} ${currency}`, inline: true },
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

    logger.info(`Withdrawal request: User ${user.username} $${amount} (${cryptoAmount} ${currency}) to ${address}`);
    res.json({ 
      message: 'Withdrawal request submitted successfully',
      transactionId,
      cryptoAmount,
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
    
    // Track wager in user stats and reduce unwagered amount
    // Process unwagered amount for wagering requirements
    if (user.unwageredAmount === undefined) {
      user.unwageredAmount = 0;
    }
    
    // Track wagering progress for requirements
    if (!user.wageringProgress) {
      user.wageringProgress = {
        totalDeposited: user.unwageredAmount || 0,
        totalWageredSinceDeposit: 0
      };
    }
    
    // Add this wager to total wagered
    user.wageringProgress.totalWageredSinceDeposit += amount;
    
    // Check if wagering requirement is now met
    const requiredWagering = user.wageringProgress.totalDeposited * WAGER_REQUIREMENT_MULTIPLIER;
    if (user.wageringProgress.totalWageredSinceDeposit >= requiredWagering) {
      // Requirement met - reset counters
      user.unwageredAmount = 0;
      user.wageringProgress = {
        totalDeposited: 0,
        totalWageredSinceDeposit: 0
      };
      logger.info(`User ${req.userId} completed wagering requirements! Total wagered: $${user.wageringProgress.totalWageredSinceDeposit}, Required: $${requiredWagering}`);
    } else {
      // Still have requirements to meet
      const remaining = requiredWagering - user.wageringProgress.totalWageredSinceDeposit;
      user.unwageredAmount = remaining;
      logger.info(`User ${req.userId} wagered $${amount} in coinflip, total wagered: $${user.wageringProgress.totalWageredSinceDeposit}, still need: $${remaining.toFixed(2)}`);
    }
    
    // Track wager stats
    user.totalWagered = (user.totalWagered || 0) + amount;
    
    // Update user level based on new total wagering
    updateUserLevel(user);
    
    // Initialize game stats
    if (!user.gameStats) {
      user.gameStats = new Map();
    }
    
    if (!user.gameStats.has('coinflip')) {
      user.gameStats.set('coinflip', {
        totalWagered: 0,
        totalGames: 0,
        wins: 0,
        losses: 0
      });
    }
    
    const gameStats = user.gameStats.get('coinflip');
    gameStats.totalWagered += amount;
    gameStats.totalGames += 1;
    user.gameStats.set('coinflip', gameStats);

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
    
    // Make sure user level is updated
    updateUserLevel(user);
    await user.save();
    
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
    
    // Get user's current level info
    const currentLevelIndex = user.level?.current ? Math.min(user.level.current - 1, USER_LEVELS.length - 1) : 0;
    const currentLevel = USER_LEVELS[currentLevelIndex];
    
    // Get next level info if not at max level
    const nextLevelIndex = currentLevelIndex < USER_LEVELS.length - 1 ? currentLevelIndex + 1 : currentLevelIndex;
    const nextLevel = USER_LEVELS[nextLevelIndex];
    const isMaxLevel = currentLevelIndex === USER_LEVELS.length - 1;
    
    res.json({
      username: user.username,
      displayName: user.displayName || user.username,
      avatar: user.avatar,
      level: {
        current: user.level?.current || 1,
        name: currentLevel.name,
        color: currentLevel.color,
        progress: user.level?.progress || 0,
        nextLevel: isMaxLevel ? null : nextLevel.level,
        nextLevelName: isMaxLevel ? null : nextLevel.name,
        requiredWagering: currentLevel.requiredWagering,
        nextLevelRequiredWagering: isMaxLevel ? null : nextLevel.requiredWagering,
        totalWagered: user.totalWagered || 0,
        rewards: currentLevel.rewards
      },
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

// Get detailed user level info
app.get('/api/user/level', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    
    // Make sure user level is updated
    updateUserLevel(user);
    await user.save();
    
    // Return all levels with current user position
    res.json({
      userLevel: user.level || { current: 1, progress: 0, totalWagered: 0 },
      levels: USER_LEVELS,
      totalWagered: user.totalWagered || 0
    });
  } catch (err) {
    logger.error('Get user level error:', err);
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

// Admin endpoints for wagering settings
app.post('/api/admin/wagering/settings', authMiddleware, adminMiddleware, async (req, res) => {
  const { multiplier } = req.body;
  
  if (multiplier === undefined || isNaN(multiplier) || multiplier < 0) {
    return res.status(400).json({ error: 'Invalid multiplier value' });
  }
  
  // Update the global multiplier
  const oldMultiplier = WAGER_REQUIREMENT_MULTIPLIER;
  WAGER_REQUIREMENT_MULTIPLIER = parseFloat(multiplier);
  
  logger.info(`Admin ${req.userId} updated wagering requirement multiplier from ${oldMultiplier}x to ${WAGER_REQUIREMENT_MULTIPLIER}x`);
  
  return res.json({
    success: true,
    oldMultiplier,
    newMultiplier: WAGER_REQUIREMENT_MULTIPLIER,
    message: `Wagering requirement updated to ${WAGER_REQUIREMENT_MULTIPLIER}x`
  });
});

app.get('/api/admin/wagering/settings', authMiddleware, adminMiddleware, async (req, res) => {
  return res.json({
    multiplier: WAGER_REQUIREMENT_MULTIPLIER
  });
});

// Reset a user's wagering requirements (for special cases or VIPs)
app.post('/api/admin/user/:userId/reset-wagering', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { userId } = req.params;
    
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    const previousAmount = user.unwageredAmount || 0;
    user.unwageredAmount = 0;
    await user.save();
    
    logger.info(`Admin ${req.userId} reset wagering requirements for user ${userId} (was: $${previousAmount})`);
    
    return res.json({
      success: true,
      userId,
      previousAmount,
      currentAmount: 0,
      message: `Wagering requirements reset for user ${userId}`
    });
  } catch (err) {
    logger.error('Error resetting user wagering:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// User list with wagering info
app.get('/api/admin/users', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { page = 1, limit = 20, search, sortBy = 'createdAt', sortOrder = -1 } = req.query;
    
    let query = {};
    if (search) {
      query = { username: { $regex: search, $options: 'i' } };
    }
    
    // Add filter for users with wagering requirements
    if (req.query.hasWageringRequirements === 'true') {
      query.unwageredAmount = { $gt: 0 };
    } else if (req.query.hasWageringRequirements === 'false') {
      query.unwageredAmount = { $lte: 0 };
    }
    
    // Sort options
    const sortOptions = {};
    sortOptions[sortBy] = parseInt(sortOrder);
    
    const users = await User.find(query)
      .select('-passwordHash')
      .sort(sortOptions)
      .skip((page - 1) * limit)
      .limit(parseInt(limit));
    
    const total = await User.countDocuments(query);
    
    // Enhance user objects with wagering status
    const enhancedUsers = users.map(user => {
      const userObj = user.toObject();
      
      // Ensure unwageredAmount is defined
      if (userObj.unwageredAmount === undefined) {
        userObj.unwageredAmount = 0;
      }
      
      // Add wagering status
      userObj.wageringStatus = {
        hasRequirements: userObj.unwageredAmount > 0,
        unwageredAmount: userObj.unwageredAmount || 0,
        canWithdraw: (userObj.unwageredAmount || 0) <= 0
      };
      
      return userObj;
    });
    
    res.json({
      users: enhancedUsers,
      totalPages: Math.ceil(total / limit),
      currentPage: parseInt(page),
      wageringSettings: {
        multiplier: WAGER_REQUIREMENT_MULTIPLIER
      }
    });
  } catch (err) {
    logger.error('Admin users error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Admin endpoint to manage processed payments cache
app.post('/api/admin/payment-cache', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { action } = req.body;
    
    if (action === 'clear') {
      // Clear in-memory payment cache
      const oldSize = transactions.size;
      transactions.clear();
      
      logger.info(`🧹 Admin cleared payment cache (${oldSize} entries removed)`);
      return res.json({ 
        success: true, 
        message: `Payment cache cleared (${oldSize} entries removed)`,
        previousSize: oldSize,
        currentSize: 0
      });
    } else if (action === 'stats') {
      // Return stats about the cache
      return res.json({
        size: transactions.size,
        oldestEntry: transactions.size > 0 ? 
          Array.from(transactions.values()).sort((a, b) => a.timestamp - b.timestamp)[0] : 
          null,
        newestEntry: transactions.size > 0 ?
          Array.from(transactions.values()).sort((a, b) => b.timestamp - a.timestamp)[0] :
          null
      });
    } else if (action === 'persist') {
      // Persist all in-memory entries to database
      let savedCount = 0;
      let errorCount = 0;
      
      for (const [key, entry] of transactions.entries()) {
        try {
          // Find the user and add payment to their processedPayments array
          await User.findByIdAndUpdate(entry.userId, {
            $addToSet: {
              processedPayments: {
                paymentId: entry.paymentId,
                orderKey: key,
                status: key.split('_')[2] || 'unknown',
                amount: entry.amount,
                createdAt: entry.timestamp
              }
            }
          });
          savedCount++;
        } catch (err) {
          errorCount++;
          logger.error(`Failed to persist payment ${key}:`, err);
        }
      }
      
      return res.json({
        success: true,
        savedCount,
        errorCount,
        totalProcessed: savedCount + errorCount
      });
    }
    
    return res.status(400).json({ error: 'Invalid action. Use "clear", "stats", or "persist"' });
  } catch (err) {
    logger.error('Payment cache admin error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/admin/user/:userId/update', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { userId } = req.params;
    const { balance, isAdmin, unwageredAmount } = req.body;
    
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    
    if (balance !== undefined) user.balance = balance;
    if (isAdmin !== undefined) user.isAdmin = isAdmin;
    
    // Add support for wagering requirement adjustment
    if (unwageredAmount !== undefined) {
      user.unwageredAmount = unwageredAmount;
      logger.info(`Admin ${req.userId} set unwagered amount for user ${userId} to $${unwageredAmount}`);
    }
    
    await user.save();
    
    logger.info(`Admin update: User ${userId} updated by ${req.username || req.userId}`);
    res.json({ 
      message: 'User updated successfully',
      user: {
        id: user._id,
        username: user.username,
        balance: user.balance,
        isAdmin: user.isAdmin,
        unwageredAmount: user.unwageredAmount || 0
      }
    });
  } catch (err) {
    logger.error('Admin update user error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Admin security dashboard
app.get('/api/admin/security', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    res.json({
      blockedIPs: Array.from(securityEvents.blockedIPs),
      suspiciousActivities: securityEvents.suspiciousActivities.slice(-100), // Last 100 events
      loginAttempts: Array.from(securityEvents.loginAttempts).map(([ip, attempts]) => ({ 
        ip, 
        attempts: attempts.slice(-10) // Last 10 attempts
      }))
    });
  } catch (err) {
    logger.error('Admin security error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Admin block/unblock IP
app.post('/api/admin/security/block-ip', authMiddleware, adminMiddleware, async (req, res) => {
  const { ip, action } = req.body;
  
  if (!ip) {
    return res.status(400).json({ error: 'IP address is required' });
  }
  
  if (action === 'block') {
    securityEvents.blockedIPs.add(ip);
    logger.info(`Admin blocked IP: ${ip}`);
  } else if (action === 'unblock') {
    securityEvents.blockedIPs.delete(ip);
    logger.info(`Admin unblocked IP: ${ip}`);
  } else {
    return res.status(400).json({ error: 'Invalid action' });
  }
  
  res.json({ success: true, action, ip });
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
