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

// Jackpot game state outside connection handler
const jackpotGame = {
  players: [],  // { id, username, bet, socketId }
  isRunning: false,
  totalPot: 0,
};

// Roulette game state
const rouletteGame = {
  bets: [], // { userId, username, betAmount, betType, betValue, socketId }
  isRunning: false,
  totalPot: 0,
};

async function startJackpotGame(io) {
  jackpotGame.isRunning = true;
  io.emit('jackpot_start');

  // 7 second delay simulating the spinner
  setTimeout(async () => {
    // Weighted winner selection by bet amount
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

    // Update winner balance in DB
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

    // Reset jackpot game state
    jackpotGame.players = [];
    jackpotGame.totalPot = 0;
    jackpotGame.isRunning = false;
  }, 7000);
}

function calculateRoulettePayout(betType, betValue) {
  // Returns multiplier payout for winning bets, 0 for losing.
  // We'll implement basic roulette bets:
  // - 'number': betValue is 0-36, payout 35:1
  // - 'color': betValue is 'red' or 'black', payout 1:1
  // - 'even_odd': betValue is 'even' or 'odd', payout 1:1
  // - 'low_high': betValue is 'low' (1-18) or 'high' (19-36), payout 1:1
  // For simplicity, zero (0) is neither red/black nor even/odd or low/high (house wins)

  return (winningNumber) => {
    if (betType === 'number') {
      return betValue === winningNumber ? 36 : 0;
    }

    if (betType === 'color') {
      // Roulette red numbers:
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

async function startRouletteGame(io) {
  rouletteGame.isRunning = true;
  io.emit('roulette_start');

  // Wait 10 seconds for bets
  setTimeout(async () => {
    const winningNumber = Math.floor(Math.random() * 37); // 0-36
    const payoutResults = [];

    // For each bet, calculate payout
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
          // Player lost their bet amount (already deducted when placing bet)
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

    // Reset roulette game state
    rouletteGame.bets = [];
    rouletteGame.totalPot = 0;
    rouletteGame.isRunning = false;
  }, 10000);
}

io.on('connection', (socket) => {
  console.log('🔌 A user connected');

  socket.on('chatMessage', (message) => {
    io.emit('chatMessage', message);
  });

  // Jackpot handlers
  socket.on('join_jackpot', async ({ userId, username, bet }) => {
    if (jackpotGame.isRunning) {
      socket.emit('jackpot_error', 'A jackpot game is currently running. Please wait.');
      return;
    }

    if (!bet || bet <= 0) {
      socket.emit('jackpot_error', 'Invalid bet amount.');
      return;
    }

    // Check if user already joined
    if (jackpotGame.players.find(p => p.id === userId)) {
      socket.emit('jackpot_error', 'You have already joined the jackpot.');
      return;
    }

    // Check user balance
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

      // Deduct bet from user balance
      user.balance -= bet;
      await user.save();

      // Add player to jackpot
      jackpotGame.players.push({ id: userId, username, bet, socketId: socket.id });
      jackpotGame.totalPot += bet;

      // Broadcast current jackpot status to everyone
      io.emit('jackpot_update', {
        players: jackpotGame.players.map(p => ({ id: p.id, username: p.username, bet: p.bet })),
        totalPot: jackpotGame.totalPot,
      });

      // Start game if 2 or more players joined
      if (jackpotGame.players.length >= 2) {
        startJackpotGame(io);
      }
    } catch (err) {
      console.error('Join jackpot error:', err);
      socket.emit('jackpot_error', 'Server error while joining jackpot.');
    }
  });

  // Roulette handlers
  socket.on('place_roulette_bet', async ({ userId, username, betAmount, betType, betValue }) => {
    if (rouletteGame.isRunning) {
      socket.emit('roulette_error', 'Roulette game in progress. Please wait for the next round.');
      return;
    }

    if (!betAmount || betAmount <= 0) {
      socket.emit('roulette_error', 'Invalid bet amount.');
      return;
    }

    // Validate betType and betValue
    const validBetTypes = ['number', 'color', 'even_odd', 'low_high'];
    if (!validBetTypes.includes(betType)) {
      socket.emit('roulette_error', 'Invalid bet type.');
      return;
    }

    if (betType === 'number') {
      if (typeof betValue !== 'number' || betValue < 0 || betValue > 36) {
        socket.emit('roulette_error', 'Invalid number bet value.');
        return;
      }
    }

    if (betType === 'color') {
      if (!['red', 'black'].includes(betValue)) {
        socket.emit('roulette_error', 'Invalid color bet value.');
        return;
      }
    }

    if (betType === 'even_odd') {
      if (!['even', 'odd'].includes(betValue)) {
        socket.emit('roulette_error', 'Invalid even/odd bet value.');
        return;
      }
    }

    if (betType === 'low_high') {
      if (!['low', 'high'].includes(betValue)) {
        socket.emit('roulette_error', 'Invalid low/high bet value.');
        return;
      }
    }

    // Check if user has enough balance
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

      // Deduct bet amount
      user.balance -= betAmount;
      await user.save();

      // Add bet to roulette game state
      rouletteGame.bets.push({ userId, username, betAmount, betType, betValue, socketId: socket.id });
      rouletteGame.totalPot += betAmount;

      io.emit('roulette_update', {
        bets: rouletteGame.bets.map(b => ({
          username: b.username,
          betAmount: b.betAmount,
          betType: b.betType,
          betValue: b.betValue,
        })),
        totalPot: rouletteGame.totalPot,
      });

      // Start roulette if >= 2 bets
      if (rouletteGame.bets.length >= 2 && !rouletteGame.isRunning) {
        startRouletteGame(io);
      }
    } catch (err) {
      console.error('Place roulette bet error:', err);
      socket.emit('roulette_error', 'Server error placing bet.');
    }
  });

  // Handle disconnect - remove player from jackpot and roulette if game not running
  socket.on('disconnect', () => {
    console.log('❌ A user disconnected');

    if (!jackpotGame.isRunning) {
      const idx = jackpotGame.players.findIndex(p => p.socketId === socket.id);
      if (idx !== -1) {
        const removed = jackpotGame.players.splice(idx, 1)[0];
        jackpotGame.totalPot -= removed.bet;

        // Refund the bet to disconnected user balance
        User.findById(removed.id).then(user => {
          if (user) {
            user.balance += removed.bet;
            return user.save();
          }
        }).catch(console.error);

        io.emit('jackpot_update', {
          players: jackpotGame.players.map(p => ({ id: p.id, username: p.username, bet: p.bet })),
          totalPot: jackpotGame.totalPot,
        });
      }
    }

    if (!rouletteGame.isRunning) {
      const idx = rouletteGame.bets.findIndex(b => b.socketId === socket.id);
      if (idx !== -1) {
        const removed = rouletteGame.bets.splice(idx, 1)[0];
        rouletteGame.totalPot -= removed.betAmount;

        // Refund bet amount to disconnected user
        User.findById(removed.userId).then(user => {
          if (user) {
            user.balance += removed.betAmount;
            return user.save();
          }
        }).catch(console.error);

        io.emit('roulette_update', {
          bets: rouletteGame.bets.map(b => ({
            username: b.username,
            betAmount: b.betAmount,
            betType: b.betType,
            betValue: b.betValue,
          })),
          totalPot: rouletteGame.totalPot,
        });
      }
    }
  });
});

// CORS middleware for REST API requests
app.use(
  cors({
    origin: ['http://localhost:3000', 'https://dgenrand0.vercel.app'],
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
  .then(() => console.log('✅ MongoDB connected'))
  .catch((err) => {
    console.error('MongoDB connection error:', err);
    process.exit(1);
  });

const JWT_SECRET = process.env.JWT_SECRET || 'secret_key';

const UserSchema = new mongoose.Schema({
  username: { type: String, unique: true, required: true },
  passwordHash: { type: String, required: true },
  balance: { type: Number, default: 0 },
});

UserSchema.methods.setPassword = async function (password) {
  this.passwordHash = await bcrypt.hash(password, 10);
};

UserSchema.methods.validatePassword = async function (password) {
  return await bcrypt.compare(password, this.passwordHash);
};

const User = mongoose.model('User', UserSchema);

// Auth middleware
function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Authorization header missing' });

  const token = authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Token missing' });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.userId;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

// === Routes ===

// Signup
app.post('/api/auth/signup', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

  try {
    let user = await User.findOne({ username });
    if (user) return res.status(400).json({ error: 'Username already taken' });

    user = new User({ username });
    await user.setPassword(password);
    await user.save();

    res.json({ message: 'User created' });
  } catch (err) {
    console.error('Error creating user:', err);
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

    const token = jwt.sign({ userId: user._id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, balance: user.balance, username: user.username });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Get current user info
app.get('/api/auth/me', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ username: user.username, balance: user.balance });
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

// Add coins (admin or user request simulation)
app.post('/api/addcoins', authMiddleware, async (req, res) => {
  const { amount } = req.body;
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });

  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    user.balance += amount;
    await user.save();
    res.json({ balance: user.balance });
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

// PayPal payment webhook (mock)
app.post('/api/paypal/webhook', (req, res) => {
  // Validate webhook signature if needed (omitted here)

  // Process payment info from req.rawBody or req.body
  // For demo, just respond OK
  res.sendStatus(200);
});

// Coinflip game logic
const coinflipGame = {
  players: [], // { id, username, bet, choice, socketId }
  isRunning: false,
  totalPot: 0,
};

async function startCoinflipGame(io) {
  coinflipGame.isRunning = true;
  io.emit('coinflip_start');

  setTimeout(async () => {
    // Flip coin
    const flipResult = Math.random() < 0.5 ? 'heads' : 'tails';

    // Payout winners
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

io.on('connection', (socket) => {
  // Duplicate events avoided by using same handler

  socket.on('join_coinflip', async ({ userId, username, bet, choice }) => {
    if (coinflipGame.isRunning) {
      socket.emit('coinflip_error', 'Coinflip game is in progress.');
      return;
    }
    if (bet <= 0 || !['heads', 'tails'].includes(choice)) {
      socket.emit('coinflip_error', 'Invalid bet or choice.');
      return;
    }

    if (coinflipGame.players.find(p => p.id === userId)) {
      socket.emit('coinflip_error', 'You already joined the coinflip.');
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

      if (coinflipGame.players.length >= 2) {
        startCoinflipGame(io);
      }
    } catch (err) {
      console.error('Join coinflip error:', err);
      socket.emit('coinflip_error', 'Server error.');
    }
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
