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
  totalPot: 0,
  roundActive: false,
  timeLeft: 30, // seconds countdown for each round
  timer: null,
  roundNumber: 1,
};

// Starts a new jackpot round timer and handles winner picking
async function startJackpotRound() {
  jackpotGame.roundActive = true;
  jackpotGame.timeLeft = 30;
  jackpotGame.roundNumber++;

  io.emit('jackpot_start', { roundNumber: jackpotGame.roundNumber });

  jackpotGame.timer = setInterval(async () => {
    jackpotGame.timeLeft--;

    // Broadcast the updated jackpot state every second
    io.emit('jackpot_update', {
      players: jackpotGame.players.map(p => ({ id: p.id, username: p.username, bet: p.bet })),
      totalPot: jackpotGame.totalPot,
      timeLeft: jackpotGame.timeLeft,
      roundActive: jackpotGame.roundActive,
      roundNumber: jackpotGame.roundNumber,
    });

    if (jackpotGame.timeLeft <= 0) {
      clearInterval(jackpotGame.timer);
      jackpotGame.roundActive = false;

      // Pick winner weighted by bet amounts
      if (jackpotGame.players.length === 0) {
        // No players joined this round
        io.emit('jackpot_winner', {
          winner: null,
          totalPot: 0,
          roundNumber: jackpotGame.roundNumber,
        });
      } else {
        let totalBet = jackpotGame.totalPot;
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
          roundNumber: jackpotGame.roundNumber,
        });
      }

      // Reset jackpot game state for next round
      jackpotGame.players = [];
      jackpotGame.totalPot = 0;

      // Wait 10 seconds before starting next round automatically
      setTimeout(() => {
        startJackpotRound();
      }, 10000);
    }
  }, 1000);
}

io.on('connection', (socket) => {
  console.log('🔌 A user connected');

  // Send current jackpot state on connection
  socket.emit('jackpot_update', {
    players: jackpotGame.players.map(p => ({ id: p.id, username: p.username, bet: p.bet })),
    totalPot: jackpotGame.totalPot,
    timeLeft: jackpotGame.timeLeft,
    roundActive: jackpotGame.roundActive,
    roundNumber: jackpotGame.roundNumber,
  });

  socket.on('chatMessage', (message) => {
    io.emit('chatMessage', message);
  });

  // Jackpot handlers
  socket.on('join_jackpot', async ({ userId, username, bet }) => {
    if (!jackpotGame.roundActive) {
      socket.emit('jackpot_error', 'No active jackpot round right now. Please wait.');
      return;
    }

    if (!bet || bet <= 0) {
      socket.emit('jackpot_error', 'Invalid bet amount.');
      return;
    }

    // Check if user already joined this round
    if (jackpotGame.players.find(p => p.id === userId)) {
      socket.emit('jackpot_error', 'You have already joined the jackpot this round.');
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

      // Add player to jackpot round
      jackpotGame.players.push({ id: userId, username, bet, socketId: socket.id });
      jackpotGame.totalPot += bet;

      // Broadcast current jackpot status to everyone
      io.emit('jackpot_update', {
        players: jackpotGame.players.map(p => ({ id: p.id, username: p.username, bet: p.bet })),
        totalPot: jackpotGame.totalPot,
        timeLeft: jackpotGame.timeLeft,
        roundActive: jackpotGame.roundActive,
        roundNumber: jackpotGame.roundNumber,
      });
    } catch (err) {
      console.error('Join jackpot error:', err);
      socket.emit('jackpot_error', 'Server error while joining jackpot.');
    }
  });

  // Handle disconnect - refund bets if player leaves mid-round
  socket.on('disconnect', () => {
    console.log('❌ A user disconnected');

    // Find player in jackpot players by socket id
    const idx = jackpotGame.players.findIndex(p => p.socketId === socket.id);

    if (idx !== -1 && jackpotGame.roundActive) {
      const player = jackpotGame.players[idx];
      jackpotGame.players.splice(idx, 1);
      jackpotGame.totalPot -= player.bet;

      // Refund bet to user balance
      User.findById(player.id).then(user => {
        if (user) {
          user.balance += player.bet;
          return user.save();
        }
      }).catch(console.error);

      io.emit('jackpot_update', {
        players: jackpotGame.players.map(p => ({ id: p.id, username: p.username, bet: p.bet })),
        totalPot: jackpotGame.totalPot,
        timeLeft: jackpotGame.timeLeft,
        roundActive: jackpotGame.roundActive,
        roundNumber: jackpotGame.roundNumber,
      });
    }
  });
});

// Start the jackpot round timer on server start
startJackpotRound();

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
    const user = await User.findById(req.userId).select('-passwordHash -__v');
    if (!user) return res.status(404).json({ error: 'User not found' });

    res.json({
      username: user.username,
      balance: user.balance,
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Deposit endpoint with NOWPAYMENTS
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

    const { invoice_url } = response.data;

    res.json({ invoice_url });
  } catch (err) {
    console.error('Payment deposit error:', err.response ? err.response.data : err.message);
    res.status(500).json({ error: 'Failed to create payment invoice' });
  }
});

// NOWPAYMENTS webhook to update balance after payment
app.post('/api/payment/webhook', async (req, res) => {
  const sig = req.headers['x-nowpayments-signature'];
  if (!sig) return res.status(400).send('Missing signature');

  // TODO: Verify signature here (NOWPAYMENTS webhook security best practices)
  // Skipping for demo

  const data = req.body;

  // Payment completed status check
  if (data.status === 'finished') {
    const order_id = data.order_id;
    const userId = order_id.split('_').pop(); // Extract userId from order_id

    const amount = Number(data.price_amount);
    if (!userId || !amount || amount <= 0) {
      return res.status(400).send('Invalid payment data');
    }

    try {
      const user = await User.findById(userId);
      if (!user) return res.status(404).send('User not found');

      user.balance += amount;
      await user.save();

      res.status(200).send('OK');
    } catch (err) {
      console.error('Webhook error:', err);
      res.status(500).send('Server error');
    }
  } else {
    res.status(200).send('OK');
  }
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
