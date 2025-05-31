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
  players: [], // { id, username, betAmount, betType, socketId }
  isRunning: false,
  timer: null,
  totalBets: 0,
};

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

    jackpotGame.players = [];
    jackpotGame.totalPot = 0;
    jackpotGame.isRunning = false;
  }, 7000);
}

function startRouletteGame(io) {
  rouletteGame.isRunning = true;
  io.emit('roulette_start');

  // 15 seconds for betting phase, then spin
  rouletteGame.timer = setTimeout(async () => {
    // Spin roulette wheel: number 0-36
    const spinResult = Math.floor(Math.random() * 37); 

    // Determine color
    // 0 is green, red and black alternate starting with red at 1
    const redNumbers = new Set([
      1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36
    ]);
    let color;
    if (spinResult === 0) color = 'green';
    else if (redNumbers.has(spinResult)) color = 'red';
    else color = 'black';

    // Calculate payouts
    for (const player of rouletteGame.players) {
      try {
        const user = await User.findById(player.id);
        if (!user) continue;

        let payout = 0;

        if (player.betType.type === 'number') {
          // Bet on exact number (payout 35:1)
          if (player.betType.value === spinResult) {
            payout = player.betAmount * 35;
          }
        } else if (player.betType.type === 'color') {
          // Bet on color red or black (payout 1:1)
          if (player.betType.value === color) {
            payout = player.betAmount * 2;
          }
        } else if (player.betType.type === 'even_odd') {
          // Bet on even or odd (payout 1:1)
          if (spinResult !== 0) {
            const isEven = spinResult % 2 === 0;
            if ((player.betType.value === 'even' && isEven) ||
                (player.betType.value === 'odd' && !isEven)) {
              payout = player.betAmount * 2;
            }
          }
        }

        if (payout > 0) {
          user.balance += payout;
        } else {
          user.balance -= player.betAmount;
        }

        await user.save();
      } catch (err) {
        console.error('Error processing roulette payout:', err);
      }
    }

    io.emit('roulette_result', {
      number: spinResult,
      color,
    });

    // Reset roulette game state
    rouletteGame.players = [];
    rouletteGame.totalBets = 0;
    rouletteGame.isRunning = false;
    rouletteGame.timer = null;
  }, 15000);
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

  // Roulette handlers
  socket.on('join_roulette', async ({ userId, username, betAmount, betType }) => {
    if (rouletteGame.isRunning) {
      socket.emit('roulette_error', 'A roulette game is currently running. Please wait.');
      return;
    }

    // Validate betAmount and betType
    if (!betAmount || betAmount <= 0) {
      socket.emit('roulette_error', 'Invalid bet amount.');
      return;
    }

    const validBetTypes = ['color', 'number', 'even_odd'];
    if (!betType || !validBetTypes.includes(betType.type)) {
      socket.emit('roulette_error', 'Invalid bet type.');
      return;
    }

    if (betType.type === 'color' && !['red', 'black'].includes(betType.value)) {
      socket.emit('roulette_error', 'Invalid color bet.');
      return;
    }

    if (betType.type === 'even_odd' && !['even', 'odd'].includes(betType.value)) {
      socket.emit('roulette_error', 'Invalid even/odd bet.');
      return;
    }

    if (betType.type === 'number') {
      if (typeof betType.value !== 'number' || betType.value < 0 || betType.value > 36) {
        socket.emit('roulette_error', 'Invalid number bet.');
        return;
      }
    }

    if (rouletteGame.players.find(p => p.id === userId)) {
      socket.emit('roulette_error', 'You have already placed a bet this round.');
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

      // Deduct bet amount now to avoid race conditions
      user.balance -= betAmount;
      await user.save();

      rouletteGame.players.push({ id: userId, username, betAmount, betType, socketId: socket.id });
      rouletteGame.totalBets += betAmount;

      io.emit('roulette_update', {
        players: rouletteGame.players.map(p => ({
          id: p.id,
          username: p.username,
          betAmount: p.betAmount,
          betType: p.betType,
        })),
        totalBets: rouletteGame.totalBets,
      });

      // Start roulette game timer if first player joined
      if (!rouletteGame.isRunning) {
        startRouletteGame(io);
      }
    } catch (err) {
      console.error('Join roulette error:', err);
      socket.emit('roulette_error', 'Server error while joining roulette.');
    }
  });

  // Handle disconnect
  socket.on('disconnect', () => {
    console.log('❌ A user disconnected');

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
        }).catch(console.error);

        io.emit('jackpot_update', {
          players: jackpotGame.players.map(p => ({ id: p.id, username: p.username, bet: p.bet })),
          totalPot: jackpotGame.totalPot,
        });
      }
    }

    if (!rouletteGame.isRunning) {
      const idx = rouletteGame.players.findIndex(p => p.socketId === socket.id);
      if (idx !== -1) {
        const removed = rouletteGame.players.splice(idx, 1)[0];
        rouletteGame.totalBets -= removed.betAmount;

        User.findById(removed.id).then(user => {
          if (user) {
            user.balance += removed.betAmount;
            return user.save();
          }
        }).catch(console.error);

        io.emit('roulette_update', {
          players: rouletteGame.players.map(p => ({
            id: p.id,
            username: p.username,
            betAmount: p.betAmount,
            betType: p.betType,
          })),
          totalBets: rouletteGame.totalBets,
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

// MongoDB connection with environment variable check
const mongoUri = process.env.MONGO_URL;
if (!mongoUri) {
  console.error('❌ MONGO_URL environment variable is not set');
  process.exit(1);
}

mongoose
  .connect(mongoUri, { useNewUrlParser: true, useUnifiedTopology: true })
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

    const token = jwt.sign({ userId: user._id }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, username: user.username, balance: user.balance });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get user balance
app.get('/api/user/balance', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ balance: user.balance });
  } catch (err) {
    console.error('Get balance error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
