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

    // Reset jackpot game state
    jackpotGame.players = [];
    jackpotGame.totalPot = 0;
    jackpotGame.isRunning = false;
  }, 7000);
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

// User schema with wagered field (keeping wagered stat)
const UserSchema = new mongoose.Schema({
  username: { type: String, unique: true, required: true },
  passwordHash: { type: String, required: true },
  balance: { type: Number, default: 0 },
  wagered: { type: Number, default: 0 },
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
    req.userId = decoded.userId; // ensure userId is here (matches your token)
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
    res.json({ token, balance: user.balance, username: user.username, wagered: user.wagered || 0 });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Get current user info (include wagered)
app.get('/api/auth/me', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId).select('-passwordHash -__v');
    if (!user) return res.status(404).json({ error: 'User not found' });

    res.json({
      username: user.username,
      balance: user.balance,
      wagered: user.wagered || 0,
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Coinflip game
app.post('/api/coinflip', authMiddleware, async (req, res) => {
  const { bet, choice } = req.body;
  if (!bet || !choice) return res.status(400).json({ error: 'Bet and choice required' });
  if (bet <= 0) return res.status(400).json({ error: 'Invalid bet amount' });
  if (!['heads', 'tails'].includes(choice)) return res.status(400).json({ error: 'Choice must be heads or tails' });

  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (user.balance < bet) return res.status(400).json({ error: 'Insufficient balance' });

    // Simulate coin flip
    const result = Math.random() < 0.5 ? 'heads' : 'tails';

    if (result === choice) {
      // User wins double the bet
      user.balance += bet;
    } else {
      // User loses bet
      user.balance -= bet;
    }
    user.wagered = (user.wagered || 0) + bet;

    await user.save();

    res.json({ result, balance: user.balance });
  } catch (err) {
    console.error('Coinflip error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Roulette game
app.post('/api/roulette', authMiddleware, async (req, res) => {
  const { bet, choice } = req.body;
  if (!bet || !choice) return res.status(400).json({ error: 'Bet and choice required' });
  if (bet <= 0) return res.status(400).json({ error: 'Invalid bet amount' });

  const validColors = ['red', 'black', 'green'];
  const validNumbers = Array.from({ length: 37 }, (_, i) => i.toString()); // "0" to "36"
  if (![...validColors, ...validNumbers].includes(choice.toString())) {
    return res.status(400).json({ error: 'Choice must be a color (red, black, green) or a number (0-36)' });
  }

  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (user.balance < bet) return res.status(400).json({ error: 'Insufficient balance' });

    // Spin the roulette
    const spinNumber = Math.floor(Math.random() * 37); // 0-36
    const colorsByNumber = {
      0: 'green',
      1: 'red',
      2: 'black',
      3: 'red',
      4: 'black',
      5: 'red',
      6: 'black',
      7: 'red',
      8: 'black',
      9: 'red',
      10: 'black',
      11: 'black',
      12: 'red',
      13: 'black',
      14: 'red',
      15: 'black',
      16: 'red',
      17: 'black',
      18: 'red',
      19: 'red',
      20: 'black',
      21: 'red',
      22: 'black',
      23: 'red',
      24: 'black',
      25: 'red',
      26: 'black',
      27: 'red',
      28: 'black',
      29: 'black',
      30: 'red',
      31: 'black',
      32: 'red',
      33: 'black',
      34: 'red',
      35: 'black',
      36: 'red',
    };
    const spinColor = colorsByNumber[spinNumber];

    let winAmount = 0;
    if (choice.toString() === spinNumber.toString()) {
      // Exact number, payout 36x
      winAmount = bet * 36;
    } else if (validColors.includes(choice) && choice === spinColor) {
      // Color match, payout 2x
      winAmount = bet * 2;
    }

    if (winAmount > 0) {
      user.balance += winAmount - bet; // add net win (payout minus original bet)
    } else {
      user.balance -= bet;
    }

    user.wagered = (user.wagered || 0) + bet;
    await user.save();

    res.json({
      spinNumber,
      spinColor,
      winAmount,
      balance: user.balance,
    });
  } catch (err) {
    console.error('Roulette error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Tip user
app.post('/api/tip', authMiddleware, async (req, res) => {
  const { toUsername, amount } = req.body;
  if (!toUsername || !amount || amount <= 0) return res.status(400).json({ error: 'To username and positive amount required' });

  try {
    const sender = await User.findById(req.userId);
    if (!sender) return res.status(404).json({ error: 'Sender not found' });

    if (sender.balance < amount) return res.status(400).json({ error: 'Insufficient balance' });

    const receiver = await User.findOne({ username: toUsername });
    if (!receiver) return res.status(404).json({ error: 'Recipient not found' });

    if (receiver._id.equals(sender._id)) return res.status(400).json({ error: 'Cannot tip yourself' });

    sender.balance -= amount;
    receiver.balance += amount;

    await sender.save();
    await receiver.save();

    res.json({ message: `Tipped ${amount} to ${toUsername}`, balance: sender.balance });
  } catch (err) {
    console.error('Tip error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Donation webhook with signature verification
app.post('/api/donation', async (req, res) => {
  const secret = process.env.DONATION_SECRET || '';
  const signature = req.headers['x-signature'];

  if (!signature) return res.status(400).json({ error: 'Signature header missing' });
  if (!req.rawBody) return res.status(400).json({ error: 'Raw body missing' });

  const computedSig = crypto.createHmac('sha256', secret).update(req.rawBody).digest('hex');
  if (computedSig !== signature) return res.status(403).json({ error: 'Invalid signature' });

  const donation = req.body;
  console.log('Donation received:', donation);

  // Here you could update user balances or stats if needed

  res.json({ message: 'Donation verified' });
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
