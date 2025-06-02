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

// User schema with wagered field
const UserSchema = new mongoose.Schema({
  username: { type: String, unique: true, required: true },
  passwordHash: { type: String, required: true },
  balance: { type: Number, default: 0 },
  wagered: { type: Number, default: 0 },  // <--- New wagering stat
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

// Deposit and payment webhook routes here if needed (unchanged)

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

    // Update wagering stat
    user.wagered += bet;

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

    res.json({ result, outcome, balance: user.balance, wagered: user.wagered });
  } catch (err) {
    console.error('Coinflip error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// === ROULETTE GAME ===
app.post('/api/game/roulette', authMiddleware, async (req, res) => {
  const { bet, choice } = req.body;

  const validChoices = [
    'red', 'black', 'even', 'odd', '1st12', '2nd12', '3rd12',
  ];

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

    // Update wagering stat
    user.wagered += bet;

    await user.save();

    // Spin roulette (0-36)
    const spin = Math.floor(Math.random() * 37);

    const redNumbers = new Set([
      1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36
    ]);
    const blackNumbers = new Set([
      2,4,6,8,10,11,13,15,17,20,22,24,26,28,29,31,33,35
    ]);

    let won = false;
    let payoutMultiplier = 0;

    if (typeof choice === 'number') {
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
      wagered: user.wagered,
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
