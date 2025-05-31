require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const axios = require('axios');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

// Socket.IO setup with CORS for frontend origins
const io = new Server(server, {
  cors: {
    origin: ['http://localhost:3000', 'https://dgenrand0.vercel.app'],
    methods: ['GET', 'POST'],
    credentials: true,
  },
});

// --- Jackpot game state ---
const jackpotGame = {
  players: [],  // { id, username, bet, socketId }
  isRunning: false,
  totalPot: 0,
};

// --- Roulette game state ---
const rouletteGame = {
  bets: [], // { userId, username, betAmount, betType, betValue, socketId }
  isRunning: false,
  totalPot: 0,
};

// --- Coinflip game state ---
const coinflipGame = {
  players: [], // { id, username, bet, choice, socketId }
  isRunning: false,
  totalPot: 0,
};

// --- Jackpot game logic ---
async function startJackpotGame(io) {
  jackpotGame.isRunning = true;
  io.emit('jackpot_start');

  // 7 second delay simulating the spinner
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
    if (!winner) winner = jackpotGame.players[0]; // fallback

    // Update winner balance
    try {
      const user = await User.findById(winner.id);
      if (user) {
        user.balance += jackpotGame.totalPot;
        await user.save();
      }
    } catch (err) {
      console.error('Error updating jackpot winner balance:', err);
    }

    io.emit('jackpot_winner', {
      winner: { id: winner.id, username: winner.username },
      totalPot: jackpotGame.totalPot,
    });

    // Reset jackpot game
    jackpotGame.players = [];
    jackpotGame.totalPot = 0;
    jackpotGame.isRunning = false;
  }, 7000);
}

// --- Roulette payout calculator ---
function calculateRoulettePayout(betType, betValue) {
  return (winningNumber) => {
    if (betType === 'number') {
      return betValue === winningNumber ? 36 : 0;
    }
    if (betType === 'color') {
      const redNumbers = [
        1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36
      ];
      if (winningNumber === 0) return 0;
      const isRed = redNumbers.includes(winningNumber);
      return (betValue === 'red' && isRed) || (betValue === 'black' && !isRed) ? 2 : 0;
    }
    if (betType === 'even_odd') {
      if (winningNumber === 0) return 0;
      const isEven = winningNumber % 2 === 0;
      return (betValue === 'even' && isEven) || (betValue === 'odd' && !isEven) ? 2 : 0;
    }
    if (betType === 'low_high') {
      if (winningNumber === 0) return 0;
      const isLow = winningNumber >= 1 && winningNumber <= 18;
      return (betValue === 'low' && isLow) || (betValue === 'high' && !isLow) ? 2 : 0;
    }
    return 0;
  };
}

// --- Start roulette game ---
async function startRouletteGame(io) {
  rouletteGame.isRunning = true;
  io.emit('roulette_start');

  setTimeout(async () => {
    const winningNumber = Math.floor(Math.random() * 37); // 0-36
    const payoutResults = [];

    for (const bet of rouletteGame.bets) {
      const payoutMultiplierFunc = calculateRoulettePayout(bet.betType, bet.betValue);
      const multiplier = payoutMultiplierFunc(winningNumber);

      try {
        const user = await User.findById(bet.userId);
        if (!user) continue;

        if (multiplier > 0) {
          const winnings = bet.betAmount * multiplier;
          user.balance += winnings;
          payoutResults.push({
            username: bet.username,
            winnings,
            betAmount: bet.betAmount,
            betType: bet.betType,
            betValue: bet.betValue,
          });
        } else {
          payoutResults.push({
            username: bet.username,
            winnings: 0,
            betAmount: bet.betAmount,
            betType: bet.betType,
            betValue: bet.betValue,
          });
        }
        await user.save();
      } catch (err) {
        console.error('Roulette payout error:', err);
      }
    }

    io.emit('roulette_result', {
      winningNumber,
      payouts: payoutResults,
    });

    // Reset roulette game
    rouletteGame.bets = [];
    rouletteGame.totalPot = 0;
    rouletteGame.isRunning = false;
  }, 10000);
}

// --- Start coinflip game ---
async function startCoinflipGame(io) {
  coinflipGame.isRunning = true;
  io.emit('coinflip_start');

  setTimeout(async () => {
    const flipResult = Math.random() < 0.5 ? 'heads' : 'tails';

    for (const player of coinflipGame.players) {
      try {
        const user = await User.findById(player.id);
        if (!user) continue;

        if (player.choice === flipResult) {
          user.balance += player.bet * 2;
        }
        await user.save();
      } catch (err) {
        console.error('Coinflip payout error:', err);
      }
    }

    io.emit('coinflip_result', {
      result: flipResult,
      players: coinflipGame.players.map(p => ({ username: p.username, bet: p.bet, choice: p.choice })),
    });

    coinflipGame.players = [];
    coinflipGame.totalPot = 0;
    coinflipGame.isRunning = false;
  }, 7000);
}

// --- Socket.IO connection ---
io.on('connection', (socket) => {
  console.log('🔌 A user connected');

  socket.on('chatMessage', (message) => {
    io.emit('chatMessage', message);
  });

  // --- Jackpot join ---
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

      user.balance -= bet;
      await user.save();

      jackpotGame.players.push({ id: userId, username, bet, socketId: socket.id });
      jackpotGame.totalPot += bet;

      io.emit('jackpot_update', {
        players: jackpotGame.players.map(p => ({ id: p.id, username: p.username, bet: p.bet })),
        totalPot: jackpotGame.totalPot,
      });

      if (jackpotGame.players.length >= 2) {
        startJackpotGame(io);
      }
    } catch (err) {
      console.error('Join jackpot error:', err);
      socket.emit('jackpot_error', 'Server error while joining jackpot.');
    }
  });

  // --- Roulette place bet ---
  socket.on('place_roulette_bet', async ({ userId, username, betAmount, betType, betValue }) => {
    if (rouletteGame.isRunning) {
      socket.emit('roulette_error', 'Roulette game in progress. Please wait.');
      return;
    }
    if (!betAmount || betAmount <= 0) {
      socket.emit('roulette_error', 'Invalid bet amount.');
      return;
    }

    const validBetTypes = ['number', 'color', 'even_odd', 'low_high'];
    if (!validBetTypes.includes(betType)) {
      socket.emit('roulette_error', 'Invalid bet type.');
      return;
    }
    if (betType === 'number' && (typeof betValue !== 'number' || betValue < 0 || betValue > 36)) {
      socket.emit('roulette_error', 'Invalid number bet value.');
      return;
    }
    if (betType === 'color' && !['red', 'black'].includes(betValue)) {
      socket.emit('roulette_error', 'Invalid color bet value.');
      return;
    }
    if (betType === 'even_odd' && !['even', 'odd'].includes(betValue)) {
      socket.emit('roulette_error', 'Invalid even/odd bet value.');
      return;
    }
    if (betType === 'low_high' && !['low', 'high'].includes(betValue)) {
      socket.emit('roulette_error', 'Invalid low/high bet value.');
      return;
    }
    if (rouletteGame.bets.find(b => b.userId === userId)) {
      socket.emit('roulette_error', 'You have already placed a bet.');
      return;
    }

    try {
      const user = await User.findById(userId);
      if (!user) {
        socket.emit('roulette_error', 'User not found.');
        return;
      }
      if (user.balance < betAmount) {
        socket.emit('roulette_error', 'Insufficient balance.');
        return;
      }

      user.balance -= betAmount;
      await user.save();

      rouletteGame.bets.push({ userId, username, betAmount, betType, betValue, socketId: socket.id });
      rouletteGame.totalPot += betAmount;

      io.emit('roulette_update', {
        bets: rouletteGame.bets.map(b => ({ username: b.username, betAmount: b.betAmount, betType: b.betType, betValue: b.betValue })),
        totalPot: rouletteGame.totalPot,
      });

      // Start roulette automatically once at least 2 bets placed
      if (rouletteGame.bets.length >= 2) {
        startRouletteGame(io);
      }
    } catch (err) {
      console.error('Place roulette bet error:', err);
      socket.emit('roulette_error', 'Server error while placing roulette bet.');
    }
  });

  // --- Coinflip join ---
  socket.on('join_coinflip', async ({ userId, username, bet, choice }) => {
    if (coinflipGame.isRunning) {
      socket.emit('coinflip_error', 'Coinflip game in progress. Please wait.');
      return;
    }
    if (!bet || bet <= 0) {
      socket.emit('coinflip_error', 'Invalid bet amount.');
      return;
    }
    if (!['heads', 'tails'].includes(choice)) {
      socket.emit('coinflip_error', 'Invalid choice. Choose "heads" or "tails".');
      return;
    }
    if (coinflipGame.players.find(p => p.id === userId)) {
      socket.emit('coinflip_error', 'You have already joined the coinflip.');
      return;
    }

    try {
      const user = await User.findById(userId);
      if (!user) {
        socket.emit('coinflip_error', 'User not found.');
        return;
      }
      if (user.balance < bet) {
        socket.emit('coinflip_error', 'Insufficient balance.');
        return;
      }

      user.balance -= bet;
      await user.save();

      coinflipGame.players.push({ id: userId, username, bet, choice, socketId: socket.id });
      coinflipGame.totalPot += bet;

      io.emit('coinflip_update', {
        players: coinflipGame.players.map(p => ({ username: p.username, bet: p.bet, choice: p.choice })),
        totalPot: coinflipGame.totalPot,
      });

      // Start coinflip automatically when 2 players joined
      if (coinflipGame.players.length >= 2) {
        startCoinflipGame(io);
      }
    } catch (err) {
      console.error('Join coinflip error:', err);
      socket.emit('coinflip_error', 'Server error while joining coinflip.');
    }
  });

  socket.on('disconnect', () => {
    console.log('🔌 A user disconnected');
  });
});

// --- MongoDB User Schema & Model ---
const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  email: { type: String, required: true, unique: true },
  passwordHash: { type: String, required: true },
  balance: { type: Number, default: 1000 },
  isAdmin: { type: Boolean, default: false },
  refreshToken: String,
});

const User = mongoose.model('User', userSchema);

// --- Middleware ---
app.use(cors({ origin: ['http://localhost:3000', 'https://dgenrand0.vercel.app'], credentials: true }));
app.use(express.json());

// --- JWT helper functions ---
const JWT_SECRET = process.env.JWT_SECRET || 'your_jwt_secret';
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'your_jwt_refresh_secret';

function generateAccessToken(user) {
  return jwt.sign({ id: user._id, username: user.username, isAdmin: user.isAdmin }, JWT_SECRET, { expiresIn: '15m' });
}

function generateRefreshToken(user) {
  return jwt.sign({ id: user._id }, JWT_REFRESH_SECRET, { expiresIn: '7d' });
}

function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader) return res.sendStatus(401);
  const token = authHeader.split(' ')[1];
  if (!token) return res.sendStatus(401);

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.sendStatus(403);
    req.user = user;
    next();
  });
}

// --- Routes ---

// Register
app.post('/register', async (req, res) => {
  try {
    const { username, email, password } = req.body;
    if (!username || !email || !password) return res.status(400).json({ message: 'Missing fields' });

    const existingUser = await User.findOne({ $or: [{ username }, { email }] });
    if (existingUser) return res.status(400).json({ message: 'User or email already exists' });

    const passwordHash = await bcrypt.hash(password, 10);

    const user = new User({ username, email, passwordHash });
    await user.save();

    res.status(201).json({ message: 'User registered successfully' });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// Login
app.post('/login', async (req, res) => {
  try {
    const { usernameOrEmail, password } = req.body;
    if (!usernameOrEmail || !password) return res.status(400).json({ message: 'Missing fields' });

    const user = await User.findOne({ $or: [{ username: usernameOrEmail }, { email: usernameOrEmail }] });
    if (!user) return res.status(400).json({ message: 'Invalid credentials' });

    const isValid = await bcrypt.compare(password, user.passwordHash);
    if (!isValid) return res.status(400).json({ message: 'Invalid credentials' });

    const accessToken = generateAccessToken(user);
    const refreshToken = generateRefreshToken(user);

    user.refreshToken = refreshToken;
    await user.save();

    res.json({ accessToken, refreshToken, username: user.username, balance: user.balance });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// Refresh token
app.post('/token', async (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) return res.status(401).json({ message: 'No refresh token provided' });

  try {
    const payload = jwt.verify(refreshToken, JWT_REFRESH_SECRET);
    const user = await User.findById(payload.id);
    if (!user || user.refreshToken !== refreshToken) return res.status(403).json({ message: 'Invalid refresh token' });

    const accessToken = generateAccessToken(user);
    res.json({ accessToken });
  } catch (err) {
    return res.status(403).json({ message: 'Invalid refresh token' });
  }
});

// Logout
app.post('/logout', authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(400).json({ message: 'User not found' });

    user.refreshToken = null;
    await user.save();

    res.json({ message: 'Logged out' });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// Get user balance
app.get('/balance', authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('balance');
    if (!user) return res.status(404).json({ message: 'User not found' });
    res.json({ balance: user.balance });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// Admin endpoints
app.get('/admin/users', authenticateToken, async (req, res) => {
  if (!req.user.isAdmin) return res.status(403).json({ message: 'Access denied' });
  const users = await User.find({}, 'username email balance isAdmin');
  res.json(users);
});

// --- Connect to MongoDB and start server ---
const PORT = process.env.PORT || 4000;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/casino';

mongoose.connect(MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => {
    server.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`);
    });
  })
  .catch(err => {
    console.error('MongoDB connection error:', err);
  });
