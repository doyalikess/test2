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

// Import roulettegame route (make sure ./routes/roulettegame.js exists)
const rouletteGameRouter = require('./routes/roulettegame');

// Socket.IO setup with CORS
const io = new Server(server, {
  cors: {
    origin: ['http://localhost:3000', 'https://dgenrand0.vercel.app'],
    methods: ['GET', 'POST'],
    credentials: true,
  },
});

// MongoDB User Schema & Model
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

// JWT secret
const JWT_SECRET = process.env.JWT_SECRET || 'secret_key';

// Middleware to capture raw body for webhook signature verification
const rawBodySaver = (req, res, buf, encoding) => {
  if (buf && buf.length) {
    req.rawBody = buf.toString(encoding || 'utf8');
  }
};

// CORS for REST API
app.use(
  cors({
    origin: ['http://localhost:3000', 'https://dgenrand0.vercel.app'],
    credentials: true,
  })
);
app.use(express.json({ verify: rawBodySaver }));

// Connect to MongoDB
mongoose
  .connect(process.env.MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log('✅ MongoDB connected'))
  .catch((err) => {
    console.error('MongoDB connection error:', err);
    process.exit(1);
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
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

// --- AUTH ROUTES ---

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
    const user = await User.findById(req.userId).select('-passwordHash -__v');
    if (!user) return res.status(404).json({ error: 'User not found' });

    res.json({ username: user.username, balance: user.balance });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// --- PAYMENT (NOWPAYMENTS) ---

app.post('/api/payment/deposit', authMiddleware, async (req, res) => {
  const { amount, currency } = req.body;

  if (!amount || !currency) {
    return res.status(400).json({ error: 'Amount and currency are required' });
  }

  try {
    const order_id = `order_${Date.now()}_${req.userId}`;

    const response = await axios.post(
      'https://api.nowpayments.io/v1/invoice',
      {
        price_amount: amount,
        price_currency: currency.toUpperCase(),
        pay_currency: currency.toUpperCase(),
        order_id: order_id,
        order_description: 'Deposit',
      },
      {
        headers: {
          'x-api-key': process.env.NOWPAYMENTS_API_KEY,
          'Content-Type': 'application/json',
        },
      }
    );

    res.status(200).json({
      invoice_url: response.data.invoice_url,
      invoice_id: response.data.id,
    });
  } catch (error) {
    console.error('NOWPAYMENTS error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to create invoice with NOWPAYMENTS' });
  }
});

// NOWPAYMENTS webhook
app.post('/api/nowpayments-webhook', async (req, res) => {
  const ipnSecret = process.env.NOWPAYMENTS_IPN_SECRET;
  const signature = req.headers['x-nowpayments-signature'];
  const bodyString = req.rawBody;

  const hash = crypto.createHmac('sha256', ipnSecret).update(bodyString).digest('hex');
  if (signature !== hash) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  const data = req.body;
  const { payment_status, order_id, price_amount } = data;

  if (payment_status === 'confirmed' || payment_status === 'finished') {
    try {
      const parts = order_id.split('_');
      const userId = parts.slice(2).join('_');
      if (!userId) return res.status(400).json({ error: 'UserId not found in order_id' });

      const user = await User.findById(userId);
      if (!user) return res.status(404).json({ error: 'User not found' });

      user.balance += price_amount;
      await user.save();

      return res.json({ message: 'Balance updated' });
    } catch (err) {
      console.error('Webhook processing error:', err);
      return res.status(500).json({ error: 'Server error' });
    }
  }

  res.json({ message: 'Payment status not confirmed, no action taken' });
});

// --- USER BALANCE ---

app.post('/api/user/add-balance', authMiddleware, async (req, res) => {
  const { amount } = req.body;
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });

  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    user.balance += amount;
    await user.save();

    res.json({ balance: user.balance });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/user/balance', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    res.json({ balance: user.balance });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// --- TIPPING ---

app.post('/api/user/tip', authMiddleware, async (req, res) => {
  const { toUserId, amount } = req.body;

  if (!toUserId || !amount || amount <= 0) return res.status(400).json({ error: 'Invalid parameters' });
  if (toUserId === req.userId) return res.status(400).json({ error: 'Cannot tip yourself' });

  try {
    const fromUser = await User.findById(req.userId);
    const toUser = await User.findById(toUserId);

    if (!fromUser || !toUser) return res.status(404).json({ error: 'User not found' });
    if (fromUser.balance < amount) return res.status(400).json({ error: 'Insufficient balance' });

    fromUser.balance -= amount;
    toUser.balance += amount;

    await fromUser.save();
    await toUser.save();

    res.json({ message: 'Tip successful', fromBalance: fromUser.balance, toBalance: toUser.balance });
  } catch (err) {
    console.error('Tip error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// --- JACKPOT GAME ---

const jackpotGame = {
  players: [], // { id, username, bet, socketId }
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

    if (!winner) winner = jackpotGame.players[0];

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
    if (jackpotGame.players.find((p) => p.id === userId)) {
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
        players: jackpotGame.players.map((p) => ({ username: p.username, bet: p.bet })),
        totalPot: jackpotGame.totalPot,
      });

      if (jackpotGame.players.length >= 2) {
        startJackpotGame(io);
      }
    } catch (err) {
      console.error('Join jackpot error:', err);
      socket.emit('jackpot_error', 'Server error.');
    }
  });

  socket.on('disconnect', () => {
    // Remove user from jackpot if they disconnect before game starts
    const idx = jackpotGame.players.findIndex((p) => p.socketId === socket.id);
    if (idx !== -1) {
      jackpotGame.totalPot -= jackpotGame.players[idx].bet;
      jackpotGame.players.splice(idx, 1);
      io.emit('jackpot_update', {
        players: jackpotGame.players.map((p) => ({ username: p.username, bet: p.bet })),
        totalPot: jackpotGame.totalPot,
      });
    }
    console.log('🔌 User disconnected');
  });

  // --- COINFLIP GAME ---

  const coinflipGame = {
    waitingPlayer: null, // { id, username, bet, socketId, choice }
    activeGames: new Map(), // socketId => game details
  };

  socket.on('coinflip_join', async ({ userId, username, bet, choice }) => {
    if (!bet || bet <= 0) {
      socket.emit('coinflip_error', 'Invalid bet amount.');
      return;
    }
    if (!['heads', 'tails'].includes(choice)) {
      socket.emit('coinflip_error', 'Invalid choice.');
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

      if (!coinflipGame.waitingPlayer) {
        coinflipGame.waitingPlayer = { id: userId, username, bet, socketId: socket.id, choice };
        socket.emit('coinflip_waiting', 'Waiting for an opponent...');
      } else {
        // Start game
        const player1 = coinflipGame.waitingPlayer;
        const player2 = { id: userId, username, bet, socketId: socket.id, choice };

        // Bet must match
        if (player1.bet !== player2.bet) {
          // Refund player2
          const refundUser = await User.findById(userId);
          refundUser.balance += bet;
          await refundUser.save();

          socket.emit('coinflip_error', 'Bet amount must match the waiting player.');
          return;
        }

        // Coin flip
        const flipResult = Math.random() < 0.5 ? 'heads' : 'tails';

        let winner = null;
        if (flipResult === player1.choice) winner = player1;
        else winner = player2;

        // Winner gets total pot
        const totalPot = player1.bet + player2.bet;

        try {
          const winnerUser = await User.findById(winner.id);
          if (winnerUser) {
            winnerUser.balance += totalPot;
            await winnerUser.save();
          }
        } catch (err) {
          console.error('Coinflip winner balance update error:', err);
        }

        // Notify players
        io.to(player1.socketId).emit('coinflip_result', {
          result: flipResult,
          winner: winner.username,
          totalPot,
        });
        io.to(player2.socketId).emit('coinflip_result', {
          result: flipResult,
          winner: winner.username,
          totalPot,
        });

        coinflipGame.waitingPlayer = null;
      }
    } catch (err) {
      console.error('Coinflip error:', err);
      socket.emit('coinflip_error', 'Server error.');
    }
  });
});

// Mount roulette routes
app.use('/api/roulette', rouletteGameRouter);

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
