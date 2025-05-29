require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
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

// Jackpot game state
const jackpotGame = {
  players: [],  // { id, username, bet, socketId }
  totalPot: 0,
  roundActive: false,
  timeLeft: 30,
  timer: null,
  roundNumber: 0,
};

// Helper to reset jackpot state
function resetJackpot() {
  jackpotGame.players = [];
  jackpotGame.totalPot = 0;
  jackpotGame.timeLeft = 30;
  jackpotGame.roundActive = false;
}

// Jackpot round logic
async function startJackpotRound() {
  if (jackpotGame.roundActive) return;

  jackpotGame.roundActive = true;
  jackpotGame.timeLeft = 30;
  jackpotGame.roundNumber++;

  io.emit('jackpot_start', { roundNumber: jackpotGame.roundNumber });

  jackpotGame.timer = setInterval(async () => {
    jackpotGame.timeLeft--;

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

      if (jackpotGame.players.length === 0) {
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
          random -= player.bet;
          if (random <= 0) {
            winner = player;
            break;
          }
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
          roundNumber: jackpotGame.roundNumber,
        });
      }

      resetJackpot();

      setTimeout(() => {
        startJackpotRound();
      }, 10000);
    }
  }, 1000);
}

// User Schema and Model
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

// Middleware and routes setup

app.use(
  cors({
    origin: ['http://localhost:3000', 'https://dgenrand0.vercel.app'],
    credentials: true,
  })
);

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

// Auth middleware
function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Authorization header missing' });

  const token = authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Token missing' });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret_key');
    req.userId = decoded.userId;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

// Routes

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

app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

  try {
    const user = await User.findOne({ username });
    if (!user) return res.status(400).json({ error: 'Invalid credentials' });

    const valid = await user.validatePassword(password);
    if (!valid) return res.status(400).json({ error: 'Invalid credentials' });

    const token = jwt.sign({ userId: user._id, username: user.username }, process.env.JWT_SECRET || 'secret_key', { expiresIn: '7d' });
    res.json({ token, balance: user.balance, username: user.username });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

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

// Payment deposit endpoint
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

// Webhook to update balance after payment
app.post('/api/payment/webhook', async (req, res) => {
  const sig = req.headers['x-nowpayments-signature'];
  if (!sig) return res.status(400).send('Missing signature');

  // TODO: Verify signature here for security

  const data = req.body;

  if (data.status === 'finished') {
    const order_id = data.order_id;
    const userId = order_id.split('_').pop();

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

// Socket.IO jackpot logic and handlers

io.on('connection', (socket) => {
  console.log('🔌 A user connected:', socket.id);

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

  socket.on('join_jackpot', async ({ userId, username, bet }) => {
    if (!jackpotGame.roundActive) {
      socket.emit('jackpot_error', 'No active jackpot round right now. Please wait.');
      return;
    }

    if (!bet || bet <= 0) {
      socket.emit('jackpot_error', 'Invalid bet amount.');
      return;
    }

    if (jackpotGame.players.some(p => p.id === userId)) {
      socket.emit('jackpot_error', 'You have already joined the jackpot this round.');
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
        timeLeft: jackpotGame.timeLeft,
        roundActive: jackpotGame.roundActive,
        roundNumber: jackpotGame.roundNumber,
      });
    } catch (err) {
      console.error('Join jackpot error:', err);
      socket.emit('jackpot_error', 'Server error while joining jackpot.');
    }
  });

  socket.on('disconnect', async () => {
    console.log('❌ User disconnected:', socket.id);

    const idx = jackpotGame.players.findIndex(p => p.socketId === socket.id);

    if (idx !== -1 && jackpotGame.roundActive) {
      const player = jackpotGame.players[idx];
      jackpotGame.players.splice(idx, 1);
      jackpotGame.totalPot -= player.bet;

      try {
        const user = await User.findById(player.id);
        if (user) {
          user.balance += player.bet;
          await user.save();
        }
      } catch (err) {
        console.error('Error refunding bet on disconnect:', err);
      }

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

// Start first jackpot round on server startup
startJackpotRound();

const PORT = process.env.PORT || 8000;
server.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
});
