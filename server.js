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

  // Handle disconnect - remove player if game not running
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
  console.log('Received raw body:', req.rawBody);

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

      if (!userId) {
        return res.status(400).json({ error: 'UserId not found in order_id' });
      }

      const user = await User.findById(userId);
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

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

// Add balance manually (auth required)
app.post('/api/user/add-balance', authMiddleware, async (req, res) => {
  const { amount } = req.body;

  if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });

  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    user.balance += amount;
    await user.save();

    res.json({ message: 'Balance updated successfully', balance: user.balance });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// === TIP ENDPOINT ===
app.post('/api/user/tip', authMiddleware, async (req, res) => {
  const { recipientUsername, amount } = req.body;

  if (!recipientUsername || !amount || amount <= 0) {
    return res.status(400).json({ error: 'Recipient and positive amount are required' });
  }

  try {
    const sender = await User.findById(req.userId);
    if (!sender) return res.status(404).json({ error: 'Sender not found' });

    if (sender.balance < amount) {
      return res.status(400).json({ error: 'Insufficient balance' });
    }

    const recipient = await User.findOne({ username: recipientUsername });
    if (!recipient) return res.status(404).json({ error: 'Recipient not found' });

    // Deduct from sender
    sender.balance -= amount;

    // Add to recipient
    recipient.balance += amount;

    // Save both users
    await sender.save();
    await recipient.save();

    res.json({ message: `Successfully tipped ${amount} to ${recipientUsername}` });
  } catch (err) {
    console.error('Tip error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// === COINFLIP GAME ===
app.post('/api/game/coinflip', authMiddleware, async (req, res) => {
  const { bet, choice } = req.body;

  if (!bet || bet <= 0) return res.status(400).json({ error: 'Invalid bet amount' });
  if (!['heads', 'tails'].includes(choice)) return res.status(400).json({ error: 'Choice must be heads or tails' });

  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (user.balance < bet) return res.status(400).json({ error: 'Insufficient balance' });

    // Deduct bet first
    user.balance -= bet;
    await user.save();

    // Flip coin
    const outcome = Math.random() < 0.5 ? 'heads' : 'tails';

    let result = 'lose';
    if (choice === outcome) {
      // Win: user wins double bet amount
      user.balance += bet * 2;
      await user.save();
      result = 'win';
    }

    res.json({ result, outcome, balance: user.balance });
  } catch (err) {
    console.error('Coinflip error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// === ROULETTE GAME ===
app.post('/api/game/roulette', authMiddleware, async (req, res) => {
  /*
    Request body:
    {
      bet: number,
      choice: number | 'red' | 'black' | 'even' | 'odd' | '1st12' | '2nd12' | '3rd12'
    }
  */

  const { bet, choice } = req.body;

  const validChoices = [
    'red', 'black', 'even', 'odd', '1st12', '2nd12', '3rd12',
  ];

  // Numbers 0-36 are valid numbers for bet
  if (!bet || bet <= 0) return res.status(400).json({ error: 'Invalid bet amount' });
  if (
    !validChoices.includes(choice) &&
    !(typeof choice === 'number' && choice >= 0 && choice <= 36)
  ) {
    return res.status(400).json({ error: 'Invalid choice' });
  }

  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (user.balance < bet) return res.status(400).json({ error: 'Insufficient balance' });

    // Deduct bet first
    user.balance -= bet;
    await user.save();

    // Spin roulette (0-36)
    const spin = Math.floor(Math.random() * 37);

    // Roulette color mapping (0 is green, others red/black)
    const redNumbers = new Set([
      1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36
    ]);
    const blackNumbers = new Set([
      2,4,6,8,10,11,13,15,17,20,22,24,26,28,29,31,33,35
    ]);

    let won = false;
    let payoutMultiplier = 0;

    if (typeof choice === 'number') {
      // Bet on exact number pays 35:1
      if (spin === choice) {
        won = true;
        payoutMultiplier = 35;
      }
    } else {
      switch (choice) {
        case 'red':
          if (redNumbers.has(spin)) {
            won = true;
            payoutMultiplier = 1;
          }
          break;
        case 'black':
          if (blackNumbers.has(spin)) {
            won = true;
            payoutMultiplier = 1;
          }
          break;
        case 'even':
          if (spin !== 0 && spin % 2 === 0) {
            won = true;
            payoutMultiplier = 1;
          }
          break;
        case 'odd':
          if (spin % 2 === 1) {
            won = true;
            payoutMultiplier = 1;
          }
          break;
        case '1st12':
          if (spin >= 1 && spin <= 12) {
            won = true;
            payoutMultiplier = 2;
          }
          break;
        case '2nd12':
          if (spin >= 13 && spin <= 24) {
            won = true;
            payoutMultiplier = 2;
          }
          break;
        case '3rd12':
          if (spin >= 25 && spin <= 36) {
            won = true;
            payoutMultiplier = 2;
          }
          break;
      }
    }

    let result = 'lose';
    if (won) {
      const winnings = bet * (payoutMultiplier + 1);
      user.balance += winnings;
      await user.save();
      result = 'win';
    }

    res.json({
      result,
      spin,
      balance: user.balance,
    });
  } catch (err) {
    console.error('Roulette error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Start server
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
