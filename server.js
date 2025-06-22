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
  15 * 1000, // 15 seconds (increased window)
  10, // limit each IP to 10 login attempts per 15 seconds (reasonable for auth)
  { error: 'Too many login attempts, please try again later' }
);

const apiLimiter = new RateLimiter(
  60 * 1000, // 1 minute
  300, // limit each IP to 300 requests per minute (5 requests per second for gaming)
  { error: 'Too many requests, please try again later' }
);

// Game-specific rate limiter - more permissive for gameplay
const gameLimiter = new RateLimiter(
  60 * 1000, // 1 minute
  600, // limit each IP to 600 requests per minute (10 requests per second for active gaming)
  { error: 'Too many game requests, please slow down slightly' }
);

// Strict rate limiter for sensitive operations
const strictLimiter = new RateLimiter(
  60 * 1000, // 1 minute
  30, // limit each IP to 30 requests per minute for sensitive operations
  { error: 'Too many sensitive requests, please wait before trying again' }
);

// Cache for crypto prices
const cryptoPriceCache = {
  prices: {},
  lastFetch: 0,
  cacheDuration: 5 * 60 * 1000, // 5 minutes
};

// ENHANCED: Global payment processing tracker with Redis-like behavior
const paymentProcessingTracker = {
  processing: new Map(), // paymentId -> { timestamp, userId, lockExpiry }
  processed: new Set(), // Set of successfully processed payment IDs
  
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
const adminRoutes = require('./admin');  // Make sure this path is correct
app.use('/api/admin', adminRoutes);

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

// Helper function to get cases awarded for level
function getCasesForLevel(level) {
  if (level < 10) return 1;
  if (level < 20) return 2;
  if (level < 50) return 3;
  return Math.floor(level / 10);
}

// Helper function to get case name for level
function getCaseNameForLevel(level) {
  if (level < 25) return 'common';
  if (level < 50) return 'rare';
  if (level < 75) return 'epic';
  return 'legendary';
}

// House Edge Configuration
const HOUSE_EDGES = {
  coinflip: 0.09,    // 9% house edge
  upgrader: 0.08,    // 8% house edge
  limbo: 0.10,       // 10% house edge
  roulette: 0.08,    // 8% house edge
  crash: 0.09,       // 9% house edge
  dice: 0.08,        // 8% house edge
  default: 0.08      // Default 8% house edge
};

// Helper function to get house edge for a game
function getHouseEdge(gameType) {
  return HOUSE_EDGES[gameType] || HOUSE_EDGES.default;
}

// Helper function to award cases to user
function awardCasesToUser(user, caseName, amount) {
  try {
    if (!user.caseInventory) {
      user.caseInventory = new Map();
    }
    
    const currentAmount = user.caseInventory.get(caseName) || 0;
    user.caseInventory.set(caseName, currentAmount + amount);
    
    logger.info(`Awarded ${amount} ${caseName} cases to user ${user.username} for reaching level ${user.level?.current || 1}`);
  } catch (error) {
    logger.error('Error awarding cases to user:', error);
  }
}

// Helper function to update wager progress for bonuses and referrals
async function updateWagerProgress(user, amount) {
  try {
    // Update wager progress for bonuses (if user has active bonus)
    if (user.wageringRequirement && user.wageringRequirement > 0) {
      user.wageringProgress = (user.wageringProgress || 0) + amount;
      
      // Check if wager requirement is completed
      if (user.wageringProgress >= user.wageringRequirement) {
        user.wageringProgress = user.wageringRequirement;
        user.wageringCompleted = true;
        logger.info(`User ${user.username} completed wager requirement: ${user.wageringRequirement}`);
      }
    }
    
    // Update referral progress (wagering counts towards referral commissions)
    if (user.referredBy) {
      await processReferralWager(user.referredBy, user._id, amount);
    }
    
  } catch (error) {
    logger.error('Error updating wager progress:', error);
  }
}

// Process referral commissions from wagering
async function processReferralWager(referrerUserId, referredUserId, wagerAmount) {
  try {
    const referrer = await User.findById(referrerUserId);
    if (!referrer) return;
    
    // Referral commission rate: 5% of wagered amount
    const REFERRAL_RATE = 0.05;
    const commission = wagerAmount * REFERRAL_RATE;
    
    // Initialize referral stats if not exists
    if (!referrer.referralStats) {
      referrer.referralStats = {
        totalReferred: 0,
        totalCommission: 0,
        pendingCommission: 0,
        lifetimeWagered: 0
      };
    }
    
    // Update referrer's stats
    referrer.referralStats.totalCommission += commission;
    referrer.referralStats.pendingCommission += commission;
    referrer.referralStats.lifetimeWagered += wagerAmount;
    
    // Initialize referrals array if not exists
    if (!referrer.referrals) {
      referrer.referrals = [];
    }
    
    // Update specific referral data
    let referralData = referrer.referrals.find(r => r.userId.toString() === referredUserId.toString());
    if (!referralData) {
      // Add new referral data
      referralData = {
        userId: referredUserId,
        username: (await User.findById(referredUserId)).username,
        dateReferred: new Date(),
        totalWagered: 0,
        commissionEarned: 0
      };
      referrer.referrals.push(referralData);
      referrer.referralStats.totalReferred = referrer.referrals.length;
    }
    
    // Update referral specific stats
    referralData.totalWagered += wagerAmount;
    referralData.commissionEarned += commission;
    
    await referrer.save();
    
    // Emit real-time update to referrer
    io.to(`user-${referrerUserId}`).emit('referral_commission', {
      amount: commission,
      fromUser: (await User.findById(referredUserId)).username,
      newPendingTotal: referrer.referralStats.pendingCommission
    });
    
    logger.info(`Referral commission: $${commission.toFixed(2)} earned by ${referrer.username} from ${referralData.username}'s wager`);
    
  } catch (error) {
    logger.error('Error processing referral wager:', error);
  }
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
      socket.userId = userId;
      logger.info(`User ${userId} authenticated and joined their room`);
    }
  });
  
  // Game room management for real-time player counts
  socket.on('join_game_room', (data) => {
    try {
      if (data.game) {
        const roomName = `game_${data.game}`;
        socket.join(roomName);
        socket.currentGameRoom = roomName;
        
        // Get room member count and broadcast update
        const room = io.sockets.adapter.rooms.get(roomName);
        const playerCount = room ? room.size : 0;
        
        logger.info(`User joined ${roomName}, current players: ${playerCount}`);
        
        // Broadcast updated player count to all users in the room
        io.to(roomName).emit(`${data.game}_players_update`, {
          count: playerCount,
          timestamp: new Date().toISOString()
        });
        
        // Also emit general online players update
        io.to(roomName).emit('online_players_update', {
          count: playerCount,
          game: data.game,
          timestamp: new Date().toISOString()
        });
      }
    } catch (error) {
      logger.error('Join game room error:', error);
    }
  });
  
  socket.on('leave_game_room', (data) => {
    try {
      if (data.game && socket.currentGameRoom) {
        const roomName = `game_${data.game}`;
        socket.leave(roomName);
        
        // Get updated room member count and broadcast
        const room = io.sockets.adapter.rooms.get(roomName);
        const playerCount = room ? room.size : 0;
        
        logger.info(`User left ${roomName}, current players: ${playerCount}`);
        
        // Broadcast updated player count
        io.to(roomName).emit(`${data.game}_players_update`, {
          count: playerCount,
          timestamp: new Date().toISOString()
        });
        
        socket.currentGameRoom = null;
      }
    } catch (error) {
      logger.error('Leave game room error:', error);
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
    
    // Clean up game room if user was in one
    if (socket.currentGameRoom) {
      const roomName = socket.currentGameRoom;
      const gameType = roomName.replace('game_', '');
      
      // Get updated room member count and broadcast after a small delay
      setTimeout(() => {
        const room = io.sockets.adapter.rooms.get(roomName);
        const playerCount = room ? room.size : 0;
        
        logger.info(`User disconnected from ${roomName}, current players: ${playerCount}`);
        
        // Broadcast updated player count
        io.to(roomName).emit(`${gameType}_players_update`, {
          count: playerCount,
          timestamp: new Date().toISOString()
        });
        
        io.to(roomName).emit('online_players_update', {
          count: playerCount,
          game: gameType,
          timestamp: new Date().toISOString()
        });
      }, 100); // Small delay to ensure disconnect is processed
    }

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
}, 5 * 60 * 1000); // Run every 5 minutes// CORS middleware for REST API requests
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

// Apply rate limiters with different levels for different endpoints
app.use('/api/auth/', authLimiter.middleware()); // Auth endpoints - moderate limiting

// Game endpoints - very permissive for smooth gameplay
app.use('/api/game/', gameLimiter.middleware());
app.use('/api/upgrader', gameLimiter.middleware());
app.use('/api/coinflip/', gameLimiter.middleware());
app.use('/api/limbo/', gameLimiter.middleware());
app.use('/api/user/upgrader-stats', gameLimiter.middleware());
app.use('/api/user/recent-upgrader-games', gameLimiter.middleware());
app.use('/api/stats/online-players', gameLimiter.middleware());

// Sensitive endpoints - strict limiting
app.use('/api/admin/', strictLimiter.middleware());
app.use('/api/wallet/', strictLimiter.middleware());
app.use('/api/withdraw/', strictLimiter.middleware());

// General API endpoints - moderate limiting
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

// Get wager requirement status (alternative endpoint that Dashboard may call)
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
      id: user._id.toString(),  // Add id field for React compatibility
      _id: user._id,  // Keep _id for backward compatibility
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
      level: user.level,
      unwageredAmount: user.unwageredAmount,
      wageringProgress: user.wageringProgress
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
});// Create a deposit invoice - REAL
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
});

// Get user level information
app.get('/api/user/level', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Update user level based on total wagering
    updateUserLevel(user);
    await user.save();

    res.json({
      userLevel: user.level || {
        current: 1,
        name: 'Rookie',
        color: '#a9b1d6',
        progress: 0,
        totalWagered: user.totalWagered || 0
      },
      levels: USER_LEVELS,
      totalWagered: user.totalWagered || 0
    });
  } catch (err) {
    logger.error('Get user level error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Send tip to another user
app.post('/api/user/tip', authMiddleware, async (req, res) => {
  try {
    const { recipientUsername, amount } = req.body;
    
    if (!recipientUsername || !amount || amount <= 0) {
      return res.status(400).json({ error: 'Invalid tip data' });
    }

    const sender = await User.findById(req.userId);
    if (!sender) {
      return res.status(404).json({ error: 'Sender not found' });
    }

    if (sender.balance < amount) {
      return res.status(400).json({ error: 'Insufficient balance' });
    }

    const recipient = await User.findOne({ username: recipientUsername });
    if (!recipient) {
      return res.status(404).json({ error: 'Recipient not found' });
    }

    if (sender._id.toString() === recipient._id.toString()) {
      return res.status(400).json({ error: 'Cannot tip yourself' });
    }

    // Process the tip
    sender.balance -= amount;
    recipient.balance += amount;

    // Tips count towards wager requirements for both sender and recipient
    await updateWagerProgress(sender, amount);
    await updateWagerProgress(recipient, amount);

    // Update level progression for both users
    updateUserLevel(sender);
    updateUserLevel(recipient);

    // Track tip statistics
    sender.totalTipsSent = (sender.totalTipsSent || 0) + amount;
    recipient.totalTipsReceived = (recipient.totalTipsReceived || 0) + amount;

    // Save both users
    await sender.save();
    await recipient.save();

    // Create tip record
    try {
      const Tip = require('./models/tip');
      await new Tip({
        fromUser: sender._id,
        toUser: recipient._id,
        amount,
        createdAt: new Date()
      }).save();
    } catch (tipError) {
      logger.error('Error creating tip record:', tipError);
      // Continue even if tip record fails
    }

    // Emit balance updates to both users
    io.to(`user-${sender._id}`).emit('balance_update', {
      newBalance: sender.balance,
      change: -amount,
      reason: 'tip_sent'
    });

    io.to(`user-${recipient._id}`).emit('balance_update', {
      newBalance: recipient.balance,
      change: amount,
      reason: 'tip_received'
    });

    // Emit tip notification to recipient
    io.to(`user-${recipient._id}`).emit('tip_received', {
      from: sender.username,
      amount: amount,
      message: `You received a $${amount.toFixed(2)} tip from ${sender.username}!`
    });

    logger.info(`Tip: ${sender.username} sent $${amount.toFixed(2)} to ${recipient.username}`);

    res.json({
      success: true,
      balance: sender.balance,
      message: `Successfully tipped $${amount.toFixed(2)} to ${recipientUsername}`
    });
  } catch (err) {
    logger.error('Tip error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Open a case
app.post('/api/user/open-case/:caseType', authMiddleware, async (req, res) => {
  try {
    const { caseType } = req.params;
    
    const user = await User.findById(req.userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Check if user has cases
    const userCaseCount = user.caseInventory?.get(caseType) || 0;
    if (userCaseCount <= 0) {
      return res.status(400).json({ error: 'No cases of this type available' });
    }

    // Get case data from our case system
    const caseData = CASE_TYPES[caseType];
    if (!caseData) {
      return res.status(400).json({ error: 'Invalid case type' });
    }

    // Open the case and get item
    const item = openCase(caseType);
    
    // Update user inventory and balance
    user.caseInventory.set(caseType, userCaseCount - 1);
    user.balance += item.value;

    await user.save();

    res.json({
      success: true,
      item: {
        name: item.name,
        value: item.value,
        rarity: item.rarity,
        color: item.color,
        emoji: '🎁' // Default emoji
      },
      newBalance: user.balance,
      remainingCases: userCaseCount - 1
    });
  } catch (err) {
    logger.error('Open case error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get case history
app.get('/api/user/case-history', authMiddleware, async (req, res) => {
  try {
    // For now, return empty array since we don't have case history model
    // This can be implemented later with a proper CaseHistory model
    res.json({
      history: []
    });
  } catch (err) {
    logger.error('Get case history error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// COINFLIP GAME ENDPOINTS FOR REACT COMPONENT
app.post('/api/game/coinflip', authMiddleware, async (req, res) => {
  try {
    const { amount, choice } = req.body;
    
    if (!amount || amount <= 0) {
      return res.status(400).json({ error: 'Invalid bet amount' });
    }
    
    if (!['heads', 'tails'].includes(choice)) {
      return res.status(400).json({ error: 'Invalid choice. Must be heads or tails' });
    }
    
    const user = await User.findById(req.userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    if (user.balance < amount) {
      return res.status(400).json({ error: 'Insufficient balance' });
    }
    
    // House edge for coinflip
    const HOUSE_EDGE = getHouseEdge('coinflip');
    
    // Record the wager (counts towards wager requirements)
    const wager = await recordWager(req.userId, 'coinflip', amount);
    
    // Track wager progress for bonuses and referrals
    await updateWagerProgress(user, amount);
    
    // Update user level based on wagering
    updateUserLevel(user);
    
    // Track wager stats
    user.totalWagered = (user.totalWagered || 0) + amount;
    user.balance -= amount;
    
    // Generate random outcome
    const outcome = Math.random() < 0.5 ? 'heads' : 'tails';
    const won = outcome === choice;
    
    let profit = 0;
    if (won) {
      // Apply house edge: payout is less than 2x to account for house edge
      // Effective payout: 2x * (1 - house_edge) = 1.82x
      const effectivePayout = 2 * (1 - HOUSE_EDGE);
      const winnings = amount * effectivePayout;
      
      profit = winnings - amount; // Net profit
      user.balance += winnings;
      
      // Record win
      await user.recordGameOutcome(true, profit);
      await updateWagerOutcome(wager._id, 'win', profit);
      
      // Track high win
      if (profit > 100) {
        io.emit('high_win', {
          username: user.username,
          game: 'coinflip',
          profit,
          multiplier: effectivePayout
        });
      }
      
      // Check for level up
      const oldLevel = user.level?.current || 1;
      updateUserLevel(user);
      const newLevel = user.level?.current || 1;
      
      if (newLevel > oldLevel) {
        // Award cases for level up
        const casesAwarded = getCasesForLevel(newLevel);
        const caseName = getCaseNameForLevel(newLevel);
        awardCasesToUser(user, caseName, casesAwarded);
        
        io.to(req.userId).emit('level_up', {
          newLevel,
          levelName: user.level.name,
          casesAwarded,
          caseName
        });
      }
    } else {
      profit = -amount;
      await user.recordGameOutcome(false, amount);
      await updateWagerOutcome(wager._id, 'loss', profit);
    }
    
    await user.save();
    
    // Emit balance update
    io.to(req.userId).emit('balance_update', {
      newBalance: user.balance,
      change: won ? profit : -amount
    });
    
    res.json({
      outcome,
      won,
      profit,
      newBalance: user.balance,
      multiplier: won ? (2 * (1 - HOUSE_EDGE)) : 0,
      houseEdge: HOUSE_EDGE
    });
    
  } catch (err) {
    logger.error('Coinflip game error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get coinflip statistics
app.get('/api/game/coinflip/stats', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    // Get user's game stats for coinflip
    const coinflipStats = user.gameStats?.get('coinflip') || {
      totalGames: 0,
      totalWagered: 0,
      totalWon: 0,
      totalLost: 0,
      winStreak: 0,
      bestWinStreak: 0,
      profit: 0
    };
    
    res.json({
      stats: coinflipStats,
      recentGames: user.recentGames || []
    });
  } catch (err) {
    logger.error('Get coinflip stats error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get recent coinflip games
app.get('/api/game/coinflip/recent', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    // Return recent games from user object
    const recentGames = user.recentGames || [];
    
    res.json({
      recentGames: recentGames.slice(0, 10) // Last 10 games
    });
  } catch (err) {
    logger.error('Get recent coinflip games error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Generic game statistics endpoint
app.get('/api/game/stats', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    res.json({
      totalGames: user.gamesPlayed || 0,
      totalWins: user.gamesWon || 0,
      totalLosses: user.gamesLost || 0,
      totalWagered: user.totalWagered || 0,
      totalProfit: user.totalProfit || 0,
      highestWin: user.highestWin || 0,
      winRate: user.gamesPlayed > 0 ? ((user.gamesWon || 0) / user.gamesPlayed * 100).toFixed(2) : 0,
      recentGames: user.recentGames || []
    });
  } catch (err) {
    logger.error('Get game stats error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// UPGRADER GAME ENDPOINTS FOR REACT COMPONENT
app.post('/api/upgrader', authMiddleware, async (req, res) => {
  try {
    const { itemValue, multiplier } = req.body;
    
    if (!itemValue || itemValue <= 0) {
      return res.status(400).json({ error: 'Invalid item value' });
    }
    
    if (!multiplier || multiplier < 1) {
      return res.status(400).json({ error: 'Invalid multiplier. Must be >= 1' });
    }
    
    const user = await User.findById(req.userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    if (user.balance < itemValue) {
      return res.status(400).json({ error: 'Insufficient balance' });
    }
    
    // House edge for upgrader
    const HOUSE_EDGE = getHouseEdge('upgrader');
    
    // Calculate win chance based on multiplier with house edge
    // Original chance: (1 / multiplier) * 100
    // With house edge: ((1 / multiplier) * (1 - house_edge)) * 100
    const theoreticalChance = (1 / multiplier) * 100;
    const chance = Math.min(95, theoreticalChance * (1 - HOUSE_EDGE));
    
    // Record the wager (counts towards wager requirements)
    const wager = await recordWager(req.userId, 'upgrader', itemValue);
    
    // Track wager progress for bonuses and referrals
    await updateWagerProgress(user, itemValue);
    
    // Update user level based on wagering
    updateUserLevel(user);
    
    // Track wager stats
    user.totalWagered = (user.totalWagered || 0) + itemValue;
    user.balance -= itemValue;
    
    // Generate random roll (0-100)
    const roll = Math.random() * 100;
    const won = roll <= chance;
    
    let profit = 0;
    let newBalance = user.balance;
    
    if (won) {
      // Full multiplier payout (house edge already applied to win chance)
      const winnings = itemValue * multiplier;
      profit = winnings - itemValue;
      newBalance = user.balance + winnings;
      user.balance = newBalance;
      
      // Record win
      await user.recordGameOutcome(true, profit);
      await updateWagerOutcome(wager._id, 'win', profit);
      
      // Track high win
      if (profit > 100) {
        io.emit('high_win', {
          username: user.username,
          game: 'upgrader',
          profit,
          multiplier
        });
      }
      
      // Check for level up
      const oldLevel = user.level?.current || 1;
      updateUserLevel(user);
      const newLevel = user.level?.current || 1;
      
      if (newLevel > oldLevel) {
        // Award cases for level up
        const casesAwarded = getCasesForLevel(newLevel);
        const caseName = getCaseNameForLevel(newLevel);
        awardCasesToUser(user, caseName, casesAwarded);
        
        io.to(req.userId).emit('level_up', {
          newLevel,
          levelName: user.level.name,
          casesAwarded,
          caseName
        });
      }
    } else {
      profit = -itemValue;
      await user.recordGameOutcome(false, itemValue);
      await updateWagerOutcome(wager._id, 'loss', profit);
    }
    
    // Store recent game in user's game stats
    if (!user.gameStats) {
      user.gameStats = new Map();
    }
    
    const upgraderStats = user.gameStats.get('upgrader') || {
      totalGames: 0,
      totalWagered: 0,
      totalProfit: 0,
      recentGames: []
    };
    
    upgraderStats.totalGames += 1;
    upgraderStats.totalWagered += itemValue;
    upgraderStats.totalProfit += profit;
    
    // Add to recent games (keep last 10)
    upgraderStats.recentGames.unshift({
      amount: itemValue,
      multiplier: parseFloat(multiplier),
      won,
      profit,
      roll: parseFloat(roll.toFixed(2)),
      chance: parseFloat(chance.toFixed(2)),
      houseEdge: HOUSE_EDGE,
      timestamp: new Date()
    });
    
    if (upgraderStats.recentGames.length > 10) {
      upgraderStats.recentGames = upgraderStats.recentGames.slice(0, 10);
    }
    
    user.gameStats.set('upgrader', upgraderStats);
    
    await user.save();
    
    // Emit balance update
    io.to(req.userId).emit('balance_update', {
      newBalance,
      change: won ? profit : -itemValue
    });
    
    res.json({
      win: won,
      result: won ? `Upgrade successful! Won $${(itemValue * multiplier).toFixed(2)}` : `Upgrade failed. Lost $${itemValue.toFixed(2)}`,
      newBalance,
      chance: parseFloat(chance.toFixed(2)),
      theoreticalChance: parseFloat(theoreticalChance.toFixed(2)),
      roll: parseFloat(roll.toFixed(2)),
      profit,
      multiplier: parseFloat(multiplier),
      houseEdge: HOUSE_EDGE
    });
    
  } catch (err) {
    logger.error('Upgrader game error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get user's upgrader statistics
app.get('/api/user/upgrader-stats', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    const upgraderStats = user.gameStats?.get('upgrader') || {
      totalGames: 0,
      totalWagered: 0,
      totalProfit: 0,
      recentGames: []
    };
    
    res.json({
      totalWagered: upgraderStats.totalWagered || 0,
      totalGames: upgraderStats.totalGames || 0,
      totalProfit: upgraderStats.totalProfit || 0,
      winRate: upgraderStats.totalGames > 0 ? 
        ((upgraderStats.recentGames.filter(g => g.won).length / upgraderStats.totalGames) * 100).toFixed(2) : 
        0
    });
  } catch (err) {
    logger.error('Get upgrader stats error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get user's recent upgrader games
app.get('/api/user/recent-upgrader-games', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    const upgraderStats = user.gameStats?.get('upgrader') || {
      recentGames: []
    };
    
    res.json({
      games: upgraderStats.recentGames || []
    });
  } catch (err) {
    logger.error('Get recent upgrader games error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get online players count
app.get('/api/stats/online-players', authMiddleware, async (req, res) => {
  try {
    // Get connected socket count as approximation
    const connectedSockets = io.engine.clientsCount || 0;
    
    // Add some randomization for demo purposes (500-1500 range)
    const baseCount = Math.floor(Math.random() * 1000) + 500;
    const onlineCount = Math.max(connectedSockets, baseCount);
    
    res.json({
      count: onlineCount,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    logger.error('Get online players error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// COMPREHENSIVE GAME ANALYTICS ENDPOINTS

// Get detailed user analytics
app.get('/api/analytics/user-stats', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const analytics = {
      overview: {
        totalWagered: user.totalWagered || 0,
        totalProfit: user.totalProfit || 0,
        gamesPlayed: user.gamesPlayed || 0,
        winRate: user.gamesPlayed > 0 ? ((user.gamesWon || 0) / user.gamesPlayed * 100).toFixed(2) : 0,
        averageBet: user.gamesPlayed > 0 ? (user.totalWagered / user.gamesPlayed).toFixed(2) : 0,
        biggestWin: user.highestWin || 0,
        currentStreak: user.currentStreak || 0,
        bestStreak: user.bestStreak || 0
      },
      gameBreakdown: {},
      timeAnalysis: {
        sessionStart: user.lastLogin || new Date(),
        sessionDuration: Date.now() - (user.lastLogin || Date.now()),
        averageSessionTime: user.averageSessionTime || 0,
        totalPlayTime: user.totalPlayTime || 0
      },
      progression: {
        level: user.level?.current || 1,
        levelName: user.level?.name || 'Rookie',
        experience: user.level?.experience || 0,
        nextLevelRequirement: user.level?.nextLevelRequirement || 100,
        wageringProgress: user.wageringProgress || 0,
        wageringRequirement: user.wageringRequirement || 0
      }
    };

    // Analyze game-specific stats
    if (user.gameStats) {
      for (const [game, stats] of user.gameStats.entries()) {
        analytics.gameBreakdown[game] = {
          totalGames: stats.totalGames || 0,
          totalWagered: stats.totalWagered || 0,
          totalProfit: stats.totalProfit || 0,
          winRate: stats.totalGames > 0 ? ((stats.wins || 0) / stats.totalGames * 100).toFixed(2) : 0,
          averageBet: stats.totalGames > 0 ? (stats.totalWagered / stats.totalGames).toFixed(2) : 0,
          favoriteMultiplier: stats.favoriteMultiplier || 'N/A',
          bestWin: stats.bestWin || 0,
          recentPerformance: stats.recentGames ? stats.recentGames.slice(0, 10) : []
        };
      }
    }

    res.json(analytics);
  } catch (err) {
    logger.error('Get user analytics error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get global game analytics (admin only)
app.get('/api/analytics/global-stats', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user || !user.isAdmin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const { timeframe = '24h' } = req.query;
    
    let startDate;
    switch (timeframe) {
      case '1h':
        startDate = new Date(Date.now() - 60 * 60 * 1000);
        break;
      case '24h':
        startDate = new Date(Date.now() - 24 * 60 * 60 * 1000);
        break;
      case '7d':
        startDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        break;
      case '30d':
        startDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        break;
      default:
        startDate = new Date(Date.now() - 24 * 60 * 60 * 1000);
    }

    // Get aggregate stats from all users
    const users = await User.find({
      lastLogin: { $gte: startDate }
    }).limit(1000); // Limit for performance

    const analytics = {
      timeframe,
      overview: {
        totalUsers: await User.countDocuments(),
        activeUsers: users.length,
        totalGamesPlayed: users.reduce((sum, u) => sum + (u.gamesPlayed || 0), 0),
        totalWagered: users.reduce((sum, u) => sum + (u.totalWagered || 0), 0),
        totalProfit: users.reduce((sum, u) => sum + (u.totalProfit || 0), 0),
        averageWinRate: users.length > 0 ? 
          (users.reduce((sum, u) => sum + (u.gamesPlayed > 0 ? (u.gamesWon || 0) / u.gamesPlayed : 0), 0) / users.length * 100).toFixed(2) : 0
      },
      gamePopularity: {},
      playerBehavior: {
        averageSessionTime: users.reduce((sum, u) => sum + (u.averageSessionTime || 0), 0) / Math.max(users.length, 1),
        peakHours: [], // Could be calculated from login times
        commonBetSizes: [],
        retentionRate: 0 // Could be calculated from login patterns
      },
      performance: {
        requestsPerSecond: Math.floor(Math.random() * 50) + 10, // Mock data
        averageResponseTime: Math.floor(Math.random() * 200) + 50, // Mock data
        errorRate: (Math.random() * 2).toFixed(2), // Mock data
        uptime: '99.8%' // Mock data
      }
    };

    // Analyze game popularity
    const gameStats = {};
    users.forEach(user => {
      if (user.gameStats) {
        for (const [game, stats] of user.gameStats.entries()) {
          if (!gameStats[game]) {
            gameStats[game] = {
              totalPlayers: 0,
              totalGames: 0,
              totalWagered: 0,
              totalProfit: 0
            };
          }
          gameStats[game].totalPlayers++;
          gameStats[game].totalGames += stats.totalGames || 0;
          gameStats[game].totalWagered += stats.totalWagered || 0;
          gameStats[game].totalProfit += stats.totalProfit || 0;
        }
      }
    });

    analytics.gamePopularity = gameStats;

    res.json(analytics);
  } catch (err) {
    logger.error('Get global analytics error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get performance metrics
app.get('/api/analytics/performance', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user || !user.isAdmin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    // Mock performance data (in a real app, this would come from monitoring tools)
    const performance = {
      server: {
        cpu: Math.floor(Math.random() * 100),
        memory: Math.floor(Math.random() * 100),
        disk: Math.floor(Math.random() * 100),
        network: Math.floor(Math.random() * 1000),
        uptime: Math.floor(Math.random() * 1000000)
      },
      api: {
        totalRequests: Math.floor(Math.random() * 10000) + 5000,
        averageResponseTime: Math.floor(Math.random() * 200) + 50,
        errorRate: (Math.random() * 5).toFixed(2),
        rpsLimit: 600,
        currentRps: Math.floor(Math.random() * 100)
      },
      database: {
        connectionPool: Math.floor(Math.random() * 100),
        queryTime: Math.floor(Math.random() * 100),
        slowQueries: Math.floor(Math.random() * 10),
        activeConnections: Math.floor(Math.random() * 50)
      },
      realTime: {
        connectedSockets: io.engine.clientsCount || 0,
        messagesPerSecond: Math.floor(Math.random() * 50),
        roomsActive: Object.keys(io.sockets.adapter.rooms).length,
        latency: Math.floor(Math.random() * 100) + 10
      }
    };

    res.json(performance);
  } catch (err) {
    logger.error('Get performance metrics error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get leaderboard with analytics
app.get('/api/analytics/leaderboard', authMiddleware, async (req, res) => {
  try {
    const { game = 'all', metric = 'totalWagered', limit = 20 } = req.query;

    let sortField;
    switch (metric) {
      case 'totalWagered':
        sortField = 'totalWagered';
        break;
      case 'totalProfit':
        sortField = 'totalProfit';
        break;
      case 'gamesPlayed':
        sortField = 'gamesPlayed';
        break;
      case 'winRate':
        sortField = 'gamesWon';
        break;
      default:
        sortField = 'totalWagered';
    }

    const users = await User.find({
      [sortField]: { $gt: 0 }
    })
    .sort({ [sortField]: -1 })
    .limit(parseInt(limit))
    .select('username totalWagered totalProfit gamesPlayed gamesWon highestWin level gameStats');

    const leaderboard = users.map((user, index) => {
      const userData = {
        rank: index + 1,
        username: user.username,
        totalWagered: user.totalWagered || 0,
        totalProfit: user.totalProfit || 0,
        gamesPlayed: user.gamesPlayed || 0,
        winRate: user.gamesPlayed > 0 ? ((user.gamesWon || 0) / user.gamesPlayed * 100).toFixed(2) : 0,
        highestWin: user.highestWin || 0,
        level: user.level?.current || 1,
        levelName: user.level?.name || 'Rookie'
      };

      // Add game-specific stats if requested
      if (game !== 'all' && user.gameStats && user.gameStats.has(game)) {
        const gameStats = user.gameStats.get(game);
        userData.gameSpecific = {
          totalGames: gameStats.totalGames || 0,
          totalWagered: gameStats.totalWagered || 0,
          totalProfit: gameStats.totalProfit || 0,
          winRate: gameStats.totalGames > 0 ? ((gameStats.wins || 0) / gameStats.totalGames * 100).toFixed(2) : 0
        };
      }

      return userData;
    });

    res.json({
      game,
      metric,
      leaderboard,
      total: users.length,
      lastUpdated: new Date().toISOString()
    });
  } catch (err) {
    logger.error('Get leaderboard error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get house edge analytics (admin only)
app.get('/api/analytics/house-edge', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user || !user.isAdmin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const { timeframe = '24h' } = req.query;
    
    let startDate;
    switch (timeframe) {
      case '1h':
        startDate = new Date(Date.now() - 60 * 60 * 1000);
        break;
      case '24h':
        startDate = new Date(Date.now() - 24 * 60 * 60 * 1000);
        break;
      case '7d':
        startDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        break;
      case '30d':
        startDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        break;
      default:
        startDate = new Date(Date.now() - 24 * 60 * 60 * 1000);
    }

    // Get all users who played in the timeframe
    const users = await User.find({
      lastLogin: { $gte: startDate }
    }).limit(1000);

    // Calculate house edge performance by game
    const houseEdgeAnalytics = {};
    let totalWagered = 0;
    let totalProfit = 0;

    for (const game in HOUSE_EDGES) {
      if (game === 'default') continue;
      
      houseEdgeAnalytics[game] = {
        configuredEdge: HOUSE_EDGES[game],
        totalWagered: 0,
        totalProfit: 0,
        actualEdge: 0,
        efficiency: 0,
        totalGames: 0,
        players: 0
      };
    }

    // Analyze user game stats
    users.forEach(user => {
      if (user.gameStats) {
        for (const [game, stats] of user.gameStats.entries()) {
          if (houseEdgeAnalytics[game]) {
            houseEdgeAnalytics[game].totalWagered += stats.totalWagered || 0;
            houseEdgeAnalytics[game].totalProfit -= stats.totalProfit || 0; // House profit is opposite of player profit
            houseEdgeAnalytics[game].totalGames += stats.totalGames || 0;
            houseEdgeAnalytics[game].players++;
            
            totalWagered += stats.totalWagered || 0;
            totalProfit -= stats.totalProfit || 0;
          }
        }
      }
    });

    // Calculate actual house edge and efficiency
    for (const game in houseEdgeAnalytics) {
      const analytics = houseEdgeAnalytics[game];
      if (analytics.totalWagered > 0) {
        analytics.actualEdge = (analytics.totalProfit / analytics.totalWagered) * 100;
        analytics.efficiency = (analytics.actualEdge / (HOUSE_EDGES[game] * 100)) * 100;
      }
    }

    const overallEdge = totalWagered > 0 ? (totalProfit / totalWagered) * 100 : 0;
    const targetOverallEdge = Object.values(HOUSE_EDGES).reduce((sum, edge, index, arr) => {
      if (index === arr.length - 1) return sum; // Skip 'default'
      return sum + edge;
    }, 0) / (Object.keys(HOUSE_EDGES).length - 1) * 100;

    res.json({
      timeframe,
      overallStats: {
        totalWagered,
        totalProfit,
        actualEdge: overallEdge.toFixed(2),
        targetEdge: targetOverallEdge.toFixed(2),
        efficiency: targetOverallEdge > 0 ? ((overallEdge / targetOverallEdge) * 100).toFixed(2) : 0
      },
      gameAnalytics: houseEdgeAnalytics,
      houseEdgeConfig: HOUSE_EDGES,
      recommendations: generateHouseEdgeRecommendations(houseEdgeAnalytics, overallEdge, targetOverallEdge)
    });
  } catch (err) {
    logger.error('Get house edge analytics error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update house edge configuration (admin only)
app.post('/api/admin/update-house-edge', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user || !user.isAdmin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const { game, newEdge } = req.body;
    
    if (!game || typeof newEdge !== 'number' || newEdge < 0 || newEdge > 0.5) {
      return res.status(400).json({ error: 'Invalid house edge configuration' });
    }

    if (!HOUSE_EDGES.hasOwnProperty(game)) {
      return res.status(400).json({ error: 'Invalid game type' });
    }

    const oldEdge = HOUSE_EDGES[game];
    HOUSE_EDGES[game] = newEdge;

    logger.info(`Admin ${user.username} updated house edge for ${game}: ${oldEdge} -> ${newEdge}`);

    res.json({
      success: true,
      game,
      oldEdge,
      newEdge,
      message: `House edge for ${game} updated to ${(newEdge * 100).toFixed(1)}%`
    });
  } catch (err) {
    logger.error('Update house edge error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Generate house edge recommendations
function generateHouseEdgeRecommendations(analytics, actualOverall, targetOverall) {
  const recommendations = [];
  
  if (actualOverall < targetOverall * 0.8) {
    recommendations.push('Overall house edge is significantly below target. Consider reviewing game configurations.');
  }
  
  if (actualOverall > targetOverall * 1.2) {
    recommendations.push('House edge may be too high, potentially affecting player retention.');
  }
  
  for (const [game, stats] of Object.entries(analytics)) {
    if (stats.efficiency < 70 && stats.totalGames > 100) {
      recommendations.push(`${game} house edge is underperforming. Actual: ${stats.actualEdge.toFixed(2)}%, Target: ${(HOUSE_EDGES[game] * 100).toFixed(1)}%`);
    }
    
    if (stats.efficiency > 130 && stats.totalGames > 100) {
      recommendations.push(`${game} house edge may be too aggressive. Consider reducing from ${(HOUSE_EDGES[game] * 100).toFixed(1)}%`);
    }
  }
  
  if (recommendations.length === 0) {
    recommendations.push('House edge performance is within expected parameters.');
  }
  
  return recommendations;
}// BULLETPROOF webhook handler with enhanced duplicate prevention
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

// Streamer promo code creation
app.post('/api/streamer/create-promocode', authMiddleware, async (req, res) => {
  try {
    const { code, value } = req.body;
    if (!code || !value) return res.status(400).json({ error: 'Missing code or value' });

    const user = await User.findById(req.userId);
    if (!user || !user.roles.includes('streamer')) {
      return res.status(403).json({ error: 'Only streamers can create promo codes' });
    }

    const existing = await PromoCode.findOne({ code });
    if (existing) {
      return res.status(400).json({ error: 'Promo code already exists' });
    }

    const promo = new PromoCode({
      code,
      value,
      createdBy: user._id,
      createdAt: new Date()
    });
    await promo.save();

    res.json({ success: true, promo });
  } catch (err) {
    logger.error('Error creating promo code:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Admin add role to user
app.post('/api/admin/user/:userId/add-role', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { userId } = req.params;
    const { role } = req.body;
    if (!role) return res.status(400).json({ error: 'Role is required' });

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (!user.roles.includes(role)) {
      user.roles.push(role);
      await user.save();
    }

    res.json({ success: true, roles: user.roles });
  } catch (err) {
    logger.error('Error adding role:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Admin add balance
app.post('/api/admin/user/:userId/add-balance', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { userId } = req.params;
    const { amount } = req.body;
    if (!amount) return res.status(400).json({ error: 'Amount is required' });

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    user.balance += parseFloat(amount);
    await user.save();

    res.json({ success: true, balance: user.balance });
  } catch (err) {
    logger.error('Error adding balance:', err);
    res.status(500).json({ error: 'Server error' });
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

// Get referral statistics
app.get('/api/referral/stats', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Initialize referral stats if not exists
    if (!user.referralStats) {
      user.referralStats = {
        totalReferred: 0,
        totalCommission: 0,
        pendingCommission: 0,
        lifetimeWagered: 0
      };
    }

    // Get referred users with updated data
    const referredUsers = await User.find({ referredBy: req.userId })
      .select('username totalWagered createdAt')
      .lean();

    // Update referral count
    user.referralStats.totalReferred = referredUsers.length;

    // Ensure referrals array exists and is updated
    if (!user.referrals) {
      user.referrals = [];
    }

    // Update referrals array with current data
    for (const refUser of referredUsers) {
      let existingRef = user.referrals.find(r => r.userId.toString() === refUser._id.toString());
      if (!existingRef) {
        user.referrals.push({
          userId: refUser._id,
          username: refUser.username,
          dateReferred: refUser.createdAt,
          totalWagered: refUser.totalWagered || 0,
          commissionEarned: (refUser.totalWagered || 0) * 0.05
        });
      } else {
        existingRef.totalWagered = refUser.totalWagered || 0;
        existingRef.commissionEarned = (refUser.totalWagered || 0) * 0.05;
      }
    }

    await user.save();

    res.json({
      referralCode: user.referralCode || '',
      totalReferrals: user.referralStats.totalReferred,
      totalEarnings: user.referralStats.totalCommission || 0,
      pendingRewards: user.referralStats.pendingCommission || 0,
      lifetimeWagered: user.referralStats.lifetimeWagered || 0,
      referralEarnings: user.referralStats.totalCommission || 0,
      referredUsers: user.referrals.map(ref => ({
        username: ref.username,
        totalWagered: ref.totalWagered || 0,
        commission: ref.commissionEarned || 0,
        joinedAt: ref.dateReferred,
        isActive: ref.totalWagered > 0
      }))
    });
  } catch (err) {
    logger.error('Get referral stats error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Process referral rewards (claim pending commissions)
app.post('/api/referral/process-rewards', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    // Initialize referral stats if not exists
    if (!user.referralStats) {
      user.referralStats = {
        totalReferred: 0,
        totalCommission: 0,
        pendingCommission: 0,
        lifetimeWagered: 0
      };
    }
    
    const pendingAmount = user.referralStats.pendingCommission || 0;
    
    if (pendingAmount <= 0) {
      return res.status(400).json({ error: 'No pending referral rewards to claim' });
    }
    
    // Add pending commission to user balance
    user.balance += pendingAmount;
    
    // Clear pending commission
    user.referralStats.pendingCommission = 0;
    
    await user.save();
    
    // Emit balance update
    io.to(`user-${req.userId}`).emit('balance_update', {
      newBalance: user.balance,
      change: pendingAmount,
      reason: 'referral_claim'
    });
    
    logger.info(`User ${user.username} claimed referral rewards: $${pendingAmount.toFixed(2)}`);
    
    res.json({
      success: true,
      totalRewards: pendingAmount,
      newBalance: user.balance,
      message: 'Referral rewards claimed successfully'
    });
    
  } catch (err) {
    logger.error('Process referral rewards error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Referral routes
app.use('/api/referral', referralRouter);

// Wager routes
app.use('/api/wager', wagerRouter);

// Mount upgrader router
app.use('/api/upgrader', upgraderRouter);

// UPGRADER GAME ENDPOINTS
app.post('/api/upgrader/play', authMiddleware, async (req, res) => {
  try {
    const { amount, targetMultiplier } = req.body;
    
    if (!amount || amount <= 0) {
      return res.status(400).json({ error: 'Invalid bet amount' });
    }
    
    if (!targetMultiplier || targetMultiplier < 1.01) {
      return res.status(400).json({ error: 'Invalid target multiplier' });
    }
    
    const user = await User.findById(req.userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    if (user.balance < amount) {
      return res.status(400).json({ error: 'Insufficient balance' });
    }
    
    // Record the wager
    const wager = await recordWager(req.userId, 'upgrader', amount);
    
    // Track wager progress if user has wager requirements
    if (user.recordWagerProgress) {
      user.recordWagerProgress(amount);
    }
    
    // Track wager stats
    user.totalWagered = (user.totalWagered || 0) + amount;
    user.balance -= amount;
    
    // Generate random result (0.00 to 100.00)
    const result = Math.random() * 100;
    const winChance = 100 / targetMultiplier;
    const won = result < winChance;
    
    let profit = 0;
    if (won) {
      profit = amount * targetMultiplier - amount;
      user.balance += amount * targetMultiplier;
      
      // Record win
      await user.recordGameOutcome(true, profit);
      await updateWagerOutcome(wager._id, 'win', profit);
      
      // Track high win
      if (profit > 100) {
        io.emit('high_win', {
          username: user.username,
          game: 'upgrader',
          profit,
          multiplier: targetMultiplier
        });
      }
    } else {
      profit = -amount;
      await user.recordGameOutcome(false, amount);
      await updateWagerOutcome(wager._id, 'loss', profit);
    }
    
    await user.save();
    
    res.json({
      won,
      result: result.toFixed(2),
      winChance: winChance.toFixed(2),
      targetMultiplier,
      profit,
      newBalance: user.balance
    });
    
  } catch (err) {
    logger.error('Upgrader play error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// COINFLIP GAME ENDPOINTS
app.post('/api/coinflip/play', authMiddleware, async (req, res) => {
  try {
    const { amount, side } = req.body;
    
    if (!amount || amount <= 0) {
      return res.status(400).json({ error: 'Invalid bet amount' });
    }
    
    if (!side || !['heads', 'tails'].includes(side.toLowerCase())) {
      return res.status(400).json({ error: 'Invalid side selection' });
    }
    
    const user = await User.findById(req.userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    if (user.balance < amount) {
      return res.status(400).json({ error: 'Insufficient balance' });
    }
    
    // Record the wager
    const wager = await recordWager(req.userId, 'coinflip', amount);
    
    // Track wager progress if user has wager requirements
    if (user.recordWagerProgress) {
      user.recordWagerProgress(amount);
    }
    
    // Track wager stats
    user.totalWagered = (user.totalWagered || 0) + amount;
    user.balance -= amount;
    
    // Generate random result
    const result = Math.random() < 0.5 ? 'heads' : 'tails';
    const won = result === side.toLowerCase();
    
    let profit = 0;
    if (won) {
      profit = amount; // 2x multiplier (double the bet)
      user.balance += amount * 2;
      
      // Record win
      await user.recordGameOutcome(true, profit);
      await updateWagerOutcome(wager._id, 'win', profit);
      
      // Track high win
      if (profit > 50) {
        io.emit('high_win', {
          username: user.username,
          game: 'coinflip',
          profit,
          multiplier: 2.0
        });
      }
    } else {
      profit = -amount;
      await user.recordGameOutcome(false, amount);
      await updateWagerOutcome(wager._id, 'loss', profit);
    }
    
    await user.save();
    
    res.json({
      won,
      result,
      playerChoice: side.toLowerCase(),
      profit,
      newBalance: user.balance
    });
    
  } catch (err) {
    logger.error('Coinflip play error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

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
