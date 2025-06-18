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
const cron = require('node-cron');
const ReferralReward = require('./models/referralReward');

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
  5 * 1000, // 5 seconds
  200, // limit each IP to 20 requests per window
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

// ENHANCED: Global payment processing tracker with Redis-like behavior
const paymentProcessingTracker = {
  processing: new Map(),
  processed: new Set(),
  confirmed: new Set(), // ✅ NEW SET to track confirmed payments

  acquireLock(paymentId, userId, lockDurationMs = 30000) {
    const now = Date.now();
    if (this.processed.has(paymentId) || this.confirmed.has(paymentId)) {
      return { acquired: false, reason: 'already_processed' };
    }

    if (this.processing.has(paymentId)) {
      const lock = this.processing.get(paymentId);
      if (lock.lockExpiry > now) {
        return { acquired: false, reason: 'currently_processing', existingUserId: lock.userId };
      } else {
        this.processing.delete(paymentId);
      }
    }

    this.processing.set(paymentId, {
      timestamp: now,
      userId,
      lockExpiry: now + lockDurationMs
    });

    return { acquired: true };
  },

  markProcessed(paymentId) {
    this.processing.delete(paymentId);
    this.processed.add(paymentId);
    this.confirmed.add(paymentId); // ✅ add here

    // Prune old
    const maxSize = 10000;
    if (this.processed.size > maxSize) {
      const entries = Array.from(this.processed).slice(-maxSize / 2);
      this.processed = new Set(entries);
    }
    if (this.confirmed.size > maxSize) {
      const entries = Array.from(this.confirmed).slice(-maxSize / 2);
      this.confirmed = new Set(entries);
    }
  },

  releaseLock(paymentId) {
    this.processing.delete(paymentId);
  },

  cleanup() {
    const now = Date.now();
    for (const [id, lock] of this.processing.entries()) {
      if (lock.lockExpiry <= now) this.processing.delete(id);
    }
  }
};

  
  // Attempt to acquire processing lock for a payment
  acquireLock(paymentId, userId, lockDurationMs = 30000) {
    const now = Date.now();
    
    // Check if already processed
    if (this.processed.has(paymentId)) {
      return { acquired: false, reason: 'already_processed' };
    }
    
    // Check if currently being processed
    if (this.processing.has(paymentId)) {
      const lock = this.processing.get(paymentId);
      if (lock.lockExpiry > now) {
        return { acquired: false, reason: 'currently_processing', existingUserId: lock.userId };
      } else {
        // Lock expired, remove it
        this.processing.delete(paymentId);
      }
    }
    
    // Acquire lock
    this.processing.set(paymentId, {
      timestamp: now,
      userId,
      lockExpiry: now + lockDurationMs
    });
    
    return { acquired: true };
  },
  
  // Release processing lock and mark as processed
  markProcessed(paymentId) {
    this.processing.delete(paymentId);
    this.processed.add(paymentId);
    
    // Cleanup old processed entries (keep only last 10000)
    if (this.processed.size > 10000) {
      const entries = Array.from(this.processed);
      this.processed.clear();
      entries.slice(-5000).forEach(id => this.processed.add(id));
    }
  },
  
  // Release lock without marking as processed (for errors)
  releaseLock(paymentId) {
    this.processing.delete(paymentId);
  },
  
  // Cleanup expired locks periodically
  cleanup() {
    const now = Date.now();
    for (const [paymentId, lock] of this.processing.entries()) {
      if (lock.lockExpiry <= now) {
        this.processing.delete(paymentId);
      }
    }
  }
};

// Cleanup expired payment locks every minute
setInterval(() => paymentProcessingTracker.cleanup(), 60000);

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
}// Mines game helper functions
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
}io.on('connection', (socket) => {
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
});// Signup
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
    user.balance = 0.05; // $0.05 welcome bonus
    
    // Record IP address for security
    user.registrationIP = ip;
    user.ipHistory = [{ ip, timestamp: new Date() }];
    
    await user.save();

    logger.info(`New user registered: ${username}`);
    res.json({ message: 'User created with $0.05 welcome bonus' });
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

// Helper function to get a random reward based on weighted probabilities
const getRandomReward = () => {
  // Define rewards and their probabilities
  const rewards = [
    { value: 1.00, chance: 1 },    // 1% chance for $1.00
    { value: 0.50, chance: 9 },    // 9% chance for $0.50
    { value: 0.20, chance: 50 },   // 50% chance for $0.20
    { value: 0.10, chance: 40 }    // 40% chance for $0.10
  ];
  
  // Calculate total weight
  const totalChance = rewards.reduce((sum, reward) => sum + reward.chance, 0);
  
  // Generate random number
  let random = Math.random() * totalChance;
  
  // Find the reward based on the random number
  for (const reward of rewards) {
    if (random < reward.chance) {
      return reward.value;
    }
    random -= reward.chance;
  }
  
  // Fallback (should never reach here)
  return 0.10;
};

// Get free coins status
app.get('/api/user/free-coins-status', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Check if user has already claimed free coins
    const hasClaimed = user.freeCoinsClaimedAt ? true : false;

    res.json({
      claimed: hasClaimed,
      claimedAt: user.freeCoinsClaimedAt || null
    });
  } catch (err) {
    logger.error('Error checking free coins status:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Claim free coins (one-time only per account) - WITH WEIGHTED RANDOM REWARDS
app.post('/api/user/claim-free-coins', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Check if user has already claimed free coins
    if (user.freeCoinsClaimedAt) {
      return res.status(400).json({ 
        error: 'Free coins already claimed',
        claimedAt: user.freeCoinsClaimedAt
      });
    }

    // Determine reward amount based on weighted probabilities
    const rewardAmount = getRandomReward();
    
    // Calculate number of cases to award based on reward amount
    const casesAwarded = Math.max(1, Math.floor(rewardAmount * 3)); // At least 1 case

    // Update user balance and mark as claimed
    user.balance += rewardAmount;
    user.freeCoinsClaimedAt = new Date();

    // Initialize free coins tracking if needed
    if (!user.freeCoinsHistory) {
      user.freeCoinsHistory = [];
    }

    user.freeCoinsHistory.push({
      amount: rewardAmount,
      casesAwarded,
      claimedAt: new Date(),
      ipAddress: req.ip || req.connection.remoteAddress
    });

    // Award cases to inventory
    if (!user.caseInventory) {
      user.caseInventory = new Map();
    }
    
    const currentCases = user.caseInventory.get('level_1') || 0;
    user.caseInventory.set('level_1', currentCases + casesAwarded);

    await user.save();

    // Create a wager record for tracking
    await new Wager({
      userId: user._id,
      gameType: 'free_coins',
      amount: 0, // No cost to user
      outcome: 'win',
      profit: rewardAmount,
      meta: {
        rewardType: 'free_coins',
        casesAwarded,
        rewardAmount
      }
    }).save();

    // Log the action
    logger.info(`User ${req.userId} claimed free coins: $${rewardAmount.toFixed(2)} (${casesAwarded} cases)`);

    res.json({
      success: true,
      newBalance: user.balance,
      casesAwarded,
      amount: rewardAmount,
      message: `Congratulations! You received $${rewardAmount.toFixed(2)} and ${casesAwarded} free case${casesAwarded !== 1 ? 's' : ''}!`
    });
  } catch (err) {
    logger.error('Error claiming free coins:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Admin endpoint to reset free coins for a user (for special cases)
app.post('/api/admin/user/:userId/reset-free-coins', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { userId } = req.params;
    
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    const previousClaimDate = user.freeCoinsClaimedAt;
    user.freeCoinsClaimedAt = null;
    
    await user.save();
    
    logger.info(`Admin ${req.userId} reset free coins eligibility for user ${userId} (was claimed: ${previousClaimDate})`);
    
    return res.json({
      success: true,
      userId,
      previousClaimDate,
      message: `Free coins eligibility reset for user ${userId}`
    });
  } catch (err) {
    logger.error('Error resetting free coins:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// Cases System Backend

// Case types and their contents
const CASE_TYPES = {
  level_1: {
    name: 'Bronze Case',
    minLevel: 1,
    maxLevel: 9,
    cost: 5,
    items: [
      { name: 'Common Coin Bonus', type: 'balance', value: 1, rarity: 'common', weight: 40 },
      { name: 'Small Coin Bonus', type: 'balance', value: 2, rarity: 'common', weight: 30 },
      { name: 'Medium Coin Bonus', type: 'balance', value: 5, rarity: 'uncommon', weight: 20 },
      { name: 'Large Coin Bonus', type: 'balance', value: 10, rarity: 'rare', weight: 8 },
      { name: 'Mega Coin Bonus', type: 'balance', value: 25, rarity: 'epic', weight: 2 }
    ]
  },
  level_2: {
    name: 'Silver Case',
    minLevel: 10,
    maxLevel: 19,
    cost: 10,
    items: [
      { name: 'Small Coin Bonus', type: 'balance', value: 2, rarity: 'common', weight: 35 },
      { name: 'Medium Coin Bonus', type: 'balance', value: 5, rarity: 'common', weight: 30 },
      { name: 'Large Coin Bonus', type: 'balance', value: 10, rarity: 'uncommon', weight: 20 },
      { name: 'Mega Coin Bonus', type: 'balance', value: 25, rarity: 'rare', weight: 12 },
      { name: 'Super Coin Bonus', type: 'balance', value: 50, rarity: 'epic', weight: 3 }
    ]
  },
  level_3: {
    name: 'Gold Case',
    minLevel: 20,
    maxLevel: 100,
    cost: 20,
    items: [
      { name: 'Medium Coin Bonus', type: 'balance', value: 5, rarity: 'common', weight: 30 },
      { name: 'Large Coin Bonus', type: 'balance', value: 10, rarity: 'common', weight: 25 },
      { name: 'Mega Coin Bonus', type: 'balance', value: 25, rarity: 'uncommon', weight: 25 },
      { name: 'Super Coin Bonus', type: 'balance', value: 50, rarity: 'rare', weight: 15 },
      { name: 'Ultra Coin Bonus', type: 'balance', value: 100, rarity: 'epic', weight: 4 },
      { name: 'Legendary Jackpot', type: 'balance', value: 500, rarity: 'legendary', weight: 1 }
    ]
  }
};

// Rarity colors for frontend display
const RARITY_COLORS = {
  common: '#9ca3af',
  uncommon: '#22c55e',
  rare: '#3b82f6',
  epic: '#a855f7',
  legendary: '#f59e0b'
};

// Function to select case type based on user level
function getCaseTypeForLevel(userLevel) {
  if (userLevel >= 20) return 'level_3';
  if (userLevel >= 10) return 'level_2';
  return 'level_1';
}

// Function to open a case and get random item
function openCase(caseType) {
  const caseData = CASE_TYPES[caseType];
  if (!caseData) throw new Error('Invalid case type');

  // Calculate total weight
  const totalWeight = caseData.items.reduce((sum, item) => sum + item.weight, 0);
  
  // Generate random number
  let random = Math.random() * totalWeight;
  
  // Select item based on weight
  for (const item of caseData.items) {
    if (random < item.weight) {
      return {
        ...item,
        color: RARITY_COLORS[item.rarity],
        caseName: caseData.name
      };
    }
    random -= item.weight;
  }
  
  // Fallback to last item if something goes wrong
  const fallback = caseData.items[caseData.items.length - 1];
  return {
    ...fallback,
    color: RARITY_COLORS[fallback.rarity],
    caseName: caseData.name
  };
}

// Get available cases for user
app.get('/api/user/cases', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Get user level
    const userLevel = user.level?.current || 1;
    
    // Get available case types based on level
    const availableCases = [];
    
    for (const [caseKey, caseData] of Object.entries(CASE_TYPES)) {
      if (userLevel >= caseData.minLevel) {
        availableCases.push({
          id: caseKey,
          name: caseData.name,
          cost: caseData.cost,
          minLevel: caseData.minLevel,
          maxLevel: caseData.maxLevel,
          unlocked: userLevel >= caseData.minLevel,
          items: caseData.items.map(item => ({
            ...item,
            color: RARITY_COLORS[item.rarity]
          }))
        });
      }
    }

    // Get user's case inventory
    const userCases = user.caseInventory || {};

    res.json({
      availableCases,
      userCases,
      userLevel,
      balance: user.balance
    });
  } catch (err) {
    logger.error('Error fetching user cases:', err);
    res.status(500).json({ error: 'Server error' });
  }
});// BULLETPROOF webhook handler with enhanced duplicate prevention
app.post('/api/payment/webhook', async (req, res) => {
  const startTime = Date.now();
  
  try {
    // Log the raw webhook
    logger.info('Payment webhook received:', req.body);
    
    // Extract critical payment data first
    const { payment_status, order_id, price_amount, payment_id, invoice_id } = req.body;
    
    // Validate required fields
    if (!order_id || !order_id.startsWith('deposit_')) {
      logger.warn('Invalid order ID format:', order_id);
      return res.status(400).json({ error: 'Invalid order ID format' });
    }
    
    // Extract user ID from order_id (format: deposit_userId_timestamp)
    const userId = order_id.split('_')[1];
    
    // Get payment ID - this is the primary key for deduplication
    const paymentId = payment_id || invoice_id;
    
    if (!paymentId) {
      logger.error('No payment_id found in webhook');
      return res.status(400).json({ error: 'Payment ID required' });
    }

    // CRITICAL: Attempt to acquire processing lock FIRST
    const lockResult = paymentProcessingTracker.acquireLock(paymentId, userId);
    
    if (!lockResult.acquired) {
      if (lockResult.reason === 'already_processed') {
        logger.warn(`🔒 Payment ${paymentId} already processed completely`);
        return res.status(200).json({ message: 'Payment already processed' });
      } else if (lockResult.reason === 'currently_processing') {
        logger.warn(`🔒 Payment ${paymentId} currently being processed by user ${lockResult.existingUserId}`);
        return res.status(409).json({ message: 'Payment currently being processed' });
      }
    }
    
    logger.info(`🔓 Acquired processing lock for payment ${paymentId}`);
    
    try {
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
              paymentProcessingTracker.releaseLock(paymentId);
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
            paymentProcessingTracker.releaseLock(paymentId);
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
          paymentProcessingTracker.releaseLock(paymentId);
          return res.status(400).json({ 
            error: 'Missing webhook verification data',
            message: 'Required security headers or configuration missing',
            missing: missingComponents
          });
        } else {
          logger.warn(`⚠️ Missing webhook security components (${missingComponents.join(', ')}) - allowing in development mode`);
        }
      }

      // DOUBLE CHECK: Database-level duplicate prevention with atomic operation
      // This is our final safety net against race conditions
      const user = await User.findOneAndUpdate(
        { 
          _id: userId,
          'processedPayments.paymentId': { $ne: paymentId } // Only update if payment not already processed
        },
        {
          $addToSet: {
            processedPayments: {
              paymentId,
              orderKey: `${order_id}_${payment_status}_${paymentId}`,
              status: payment_status,
              amount: parseFloat(price_amount),
              createdAt: new Date(),
              processingTime: Date.now() - startTime
            }
          }
        },
        { new: true } // Return updated document
      );

      // If user is null, it means either user doesn't exist OR payment was already processed
      if (!user) {
        // Check if user exists but payment was already processed
        const existingUser = await User.findById(userId);
        if (existingUser) {
          const alreadyProcessed = existingUser.processedPayments.some(p => p.paymentId === paymentId);
          if (alreadyProcessed) {
            logger.warn(`💀 Payment ${paymentId} already processed in database for user ${userId}`);
            paymentProcessingTracker.markProcessed(paymentId);
            return res.status(200).json({ message: 'Payment already processed' });
          }
        }
        logger.error('User not found for deposit:', userId);
        paymentProcessingTracker.releaseLock(paymentId);
        return res.status(404).json({ error: 'User not found' });
      }

      // TRIPLE CHECK: Backup check in Wager records
      const existingWager = await Wager.findOne({ 
        'meta.paymentId': paymentId,
        'meta.processed': true 
      });
      
      if (existingWager) {
        logger.warn(`💀 Payment ${paymentId} already processed (found in Wager records)`);
        paymentProcessingTracker.markProcessed(paymentId);
        return res.status(200).json({ message: 'Payment already processed' });
      }
      
      if (payment_status === 'finished' || payment_status === 'confirmed') {
        // Process the successful payment
        const amount = parseFloat(price_amount);
        const previousBalance = user.balance;
        
        // ATOMIC BALANCE UPDATE: Set balance directly to avoid double crediting issues
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
        
        logger.info(`✅ Processing deposit for user ${userId}: $${amount} (${previousBalance} -> ${user.balance}, unwagered: ${user.unwageredAmount})`);
        
        // Update deposit status if we have invoice_id
        if (invoice_id) {
          await User.findOneAndUpdate(
            { _id: userId, "depositRequests.depositId": invoice_id },
            { 
              $set: { 
                "depositRequests.$.status": "completed"
              }
            }
          );
        }
        
        // Save user with all updates
        await user.save();
        logger.info(`✅ User balance saved: ${user.balance}`);

        // Create a transaction record using recordWager helper
        try {
          const transaction = await recordWager(userId, 'manual', amount, {
            type: 'deposit',
            paymentId,
            processed: true,
            paymentDetails: req.body,
            processingTime: Date.now() - startTime
          });
          
          // Update the wager to reflect it as a deposit (win outcome, profit = amount)
          await updateWagerOutcome(transaction._id, 'win', amount);
          
          logger.info(`✅ Transaction record created: ${transaction._id}`);
        } catch (wagerError) {
          logger.error('Failed to create transaction record:', wagerError);
          // Continue processing even if transaction record fails
        }

        // Mark payment as fully processed BEFORE notifications
        paymentProcessingTracker.markProcessed(paymentId);

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
        
        logger.info(`📡 Sending balance update notification to user-${userId}:`, notificationData);
        io.to(`user-${userId}`).emit('balance_update', notificationData);

        logger.info(`💰 Deposit success: User ${userId} +$${amount} (Payment ID: ${paymentId}) - Processing time: ${Date.now() - startTime}ms`);
        return res.status(200).json({ success: true });
      }

      // For other payment statuses, just log and acknowledge without processing
      logger.info(`📝 Payment status update: ${payment_status} for ${order_id} (Payment ID: ${paymentId})`);
      paymentProcessingTracker.releaseLock(paymentId); // Release lock since we're not processing
      res.status(200).json({ received: true });
      
    } catch (processingError) {
      // Release lock on any processing error
      paymentProcessingTracker.releaseLock(paymentId);
      throw processingError;
    }
    
  } catch (err) {
    logger.error('💥 Webhook processing error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// Rest of your endpoints continue here...
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
