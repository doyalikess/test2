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

  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.balance < bet) return res.status(400).json({ error: 'Insufficient balance' });

    user.balance -= bet;
    await user.save();

    const result = Math.random() < 0.5 ? 'heads' : 'tails';
    let won = false;
    let profit = 0;

    if (choice === result) {
      won = true;
      profit = bet * 2;
      user.balance += profit;
      user.wagered += bet;
      await user.save();
    } else {
      user.wagered += bet;
      await user.save();
    }

    res.json({ result, won, profit, balance: user.balance });
  } catch (err) {
    console.error('Coinflip error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Roulette game (simplified)
app.post('/api/roulette', authMiddleware, async (req, res) => {
  const { bet, choice } = req.body;
  if (!bet || !choice) return res.status(400).json({ error: 'Bet and choice required' });
  if (bet <= 0) return res.status(400).json({ error: 'Invalid bet amount' });

  // Assuming choice is a color: 'red', 'black', or 'green'
  const colors = ['red', 'black', 'green'];
  if (!colors.includes(choice)) return res.status(400).json({ error: 'Invalid choice' });

  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.balance < bet) return res.status(400).json({ error: 'Insufficient balance' });

    user.balance -= bet;
    await user.save();

    // Simulate roulette outcome with weighted distribution: 18 red, 18 black, 1 green (0)
    const outcomes = [
      ...Array(18).fill('red'),
      ...Array(18).fill('black'),
      'green',
    ];
    const outcome = outcomes[Math.floor(Math.random() * outcomes.length)];

    let won = false;
    let profit = 0;

    if (choice === outcome) {
      won = true;
      if (choice === 'green') {
        profit = bet * 14; // 14:1 payout for green
      } else {
        profit = bet * 2; // 2:1 payout for red/black
      }
      user.balance += profit;
      user.wagered += bet;
      await user.save();
    } else {
      user.wagered += bet;
      await user.save();
    }

    res.json({ outcome, won, profit, balance: user.balance });
  } catch (err) {
    console.error('Roulette error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Deposit route with NOWPAYMENTS integration
app.post('/api/payment/deposit', authMiddleware, async (req, res) => {
  try {
    const { amount, currency } = req.body;
    if (!amount || !currency) return res.status(400).json({ error: 'Amount and currency required' });

    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const orderId = `id${Date.now()}uid${user._id}`;
    const NOWPAYMENTS_API_KEY = process.env.NOWPAYMENTS_API_KEY;

    const response = await axios.post(
      'https://api.nowpayments.io/v1/invoice',
      {
        price_amount: amount,
        price_currency: currency,
        order_id: orderId,
        ipn_callback_url: 'https://yourdomain.com/api/nowpayments-webhook',
        success_url: 'https://yourdomain.com/success',
        cancel_url: 'https://yourdomain.com/cancel',
      },
      {
        headers: {
          'x-api-key': NOWPAYMENTS_API_KEY,
          'Content-Type': 'application/json',
        },
      }
    );

    if (response.status === 201 || response.status === 200) {
      res.json(response.data);
    } else {
      res.status(response.status).json({ error: 'Failed to create payment invoice' });
    }
  } catch (err) {
    console.error('Deposit error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Server error during deposit' });
  }
});

// NOWPAYMENTS webhook endpoint
app.post('/api/nowpayments-webhook', async (req, res) => {
  try {
    const NOWPAYMENTS_WEBHOOK_SECRET = process.env.NOWPAYMENTS_WEBHOOK_SECRET;
    const signature = req.headers['x-nowpayments-signature'];
    const rawBody = req.rawBody || JSON.stringify(req.body);

    if (!signature || !NOWPAYMENTS_WEBHOOK_SECRET) {
      return res.status(400).json({ error: 'Missing signature or secret' });
    }

    const hash = crypto
      .createHmac('sha256', NOWPAYMENTS_WEBHOOK_SECRET)
      .update(rawBody)
      .digest('hex');

    if (hash !== signature) {
      return res.status(400).json({ error: 'Invalid signature' });
    }

    const { payment_status, order_id, price_amount } = req.body;

    if (payment_status === 'finished') {
      // Extract user ID from order_id
      const uidIndex = order_id.indexOf('uid');
      if (uidIndex === -1) {
        return res.status(400).json({ error: 'Invalid order_id format' });
      }

      const userId = order_id.slice(uidIndex + 3);

      const user = await User.findById(userId);
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      user.balance += price_amount;
      await user.save();

      return res.status(200).json({ message: 'Payment processed' });
    }

    res.status(200).json({ message: 'Payment status not finished' });
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(500).json({ error: 'Server error processing webhook' });
  }
});

// Default route
app.get('/', (req, res) => {
  res.send('API is running...');
});

// Start server
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
});
