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

// --- Roulette Game State for Socket.IO ---
const rouletteGame = {
  players: [], // { id, username, socketId, bets: [{betType, betValue, amount}] }
  isRunning: false,
  roundDuration: 15000, // 15 seconds per round
  timer: null,
};

// Helper arrays for roulette colors
const redNumbers = [1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36];
const blackNumbers = [2,4,6,8,10,11,13,15,17,20,22,24,26,28,29,31,33,35];

// Function to start a roulette round
async function startRouletteRound(io) {
  rouletteGame.isRunning = true;
  io.emit('roulette_round_start');

  // Wait roundDuration, then spin
  rouletteGame.timer = setTimeout(async () => {
    // Generate server seed & hash
    const serverSeed = crypto.randomBytes(16).toString('hex');
    const hash = crypto.createHash('sha256').update(serverSeed).digest('hex');

    // Outcome number 0-36
    const outcomeNumber = parseInt(hash.slice(0, 8), 16) % 37;

    let outcomeColor = 'green';
    if (redNumbers.includes(outcomeNumber)) outcomeColor = 'red';
    else if (blackNumbers.includes(outcomeNumber)) outcomeColor = 'black';

    let outcomeParity = null;
    if (outcomeNumber !== 0) {
      outcomeParity = outcomeNumber % 2 === 0 ? 'even' : 'odd';
    }

    // Evaluate bets & update balances
    for (const player of rouletteGame.players) {
      try {
        const user = await User.findById(player.id);
        if (!user) continue;

        let totalWin = 0;
        let totalBetAmount = 0;

        for (const bet of player.bets) {
          totalBetAmount += bet.amount;
          let win = false;
          let payoutMultiplier = 0;

          if (bet.betType === 'number') {
            if (bet.betValue === outcomeNumber) {
              win = true;
              payoutMultiplier = 35;
            }
          } else if (bet.betType === 'color') {
            if (bet.betValue === outcomeColor) {
              win = true;
              payoutMultiplier = 2;
            }
          } else if (bet.betType === 'parity') {
            if (outcomeNumber !== 0 && bet.betValue === outcomeParity) {
              win = true;
              payoutMultiplier = 2;
            }
          }

          if (win) {
            totalWin += bet.amount * (payoutMultiplier - 1);
          } else {
            totalWin -= bet.amount;
          }
        }

        user.balance += totalWin;
        await user.save();

        // Notify player about round result and new balance
        io.to(player.socketId).emit('roulette_round_result', {
          outcome: {
            number: outcomeNumber,
            color: outcomeColor,
            parity: outcomeParity,
          },
          totalWin,
          newBalance: user.balance,
          serverSeed,
          hash,
        });
      } catch (err) {
        console.error('Roulette round player update error:', err);
      }
    }

    // Clear players' bets for next round
    rouletteGame.players.forEach(p => p.bets = []);

    rouletteGame.isRunning = false;

    // Start next round automatically if players remain
    if (rouletteGame.players.length > 0) {
      startRouletteRound(io);
    } else {
      io.emit('roulette_idle');
    }
  }, rouletteGame.roundDuration);
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

  // Jackpot disconnect refund
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

    // Roulette disconnect - remove player and refund bets (if round not running)
    const rIdx = rouletteGame.players.findIndex(p => p.socketId === socket.id);
    if (rIdx !== -1) {
      const player = rouletteGame.players.splice(rIdx, 1)[0];

      if (!rouletteGame.isRunning && player.bets.length > 0) {
        // Refund all bets on disconnect if round not running
        User.findById(player.id).then(async user => {
          if (user) {
            const refundAmount = player.bets.reduce((acc, b) => acc + b.amount, 0);
            user.balance += refundAmount;
            await user.save();
          }
        }).catch(console.error);
      }

      io.emit('roulette_player_update', {
        players: rouletteGame.players.map(p => ({ id: p.id, username: p.username })),
      });
    }
  });

  // Roulette handlers
  socket.on('join_roulette', async ({ userId, username }) => {
    // Prevent duplicate joins
    if (rouletteGame.players.find(p => p.id === userId)) {
      socket.emit('roulette_error', 'You have already joined the roulette game.');
      return;
    }

    rouletteGame.players.push({ id: userId, username, socketId: socket.id, bets: [] });
    socket.emit('roulette_joined');
    io.emit('roulette_player_update', {
      players: rouletteGame.players.map(p => ({ id: p.id, username: p.username })),
    });

    // Start round if not running
    if (!rouletteGame.isRunning) {
      startRouletteRound(io);
    }
  });

  // Place bet socket event
  socket.on('roulette_place_bet', async ({ userId, betType, betValue, amount }) => {
    if (rouletteGame.isRunning) {
      socket.emit('roulette_error', 'Bets are closed during the spin. Please wait for next round.');
      return;
    }

    const player = rouletteGame.players.find(p => p.id === userId);
    if (!player) {
      socket.emit('roulette_error', 'You are not joined in the roulette game.');
      return;
    }

    if (!amount || amount <= 0) {
      socket.emit('roulette_error', 'Invalid bet amount.');
      return;
    }

    // Validate betType and betValue similar to REST API validation
    const validColors = ['red', 'black'];
    const validParities = ['odd', 'even'];

    if (!betType || betValue === undefined || betValue === null) {
      socket.emit('roulette_error', 'Bet type and value required.');
      return;
    }

    if (betType === 'number') {
      if (typeof betValue !== 'number' || betValue < 0 || betValue > 36) {
        socket.emit('roulette_error', 'Invalid number betValue.');
        return;
      }
    } else if (betType === 'color') {
      if (!validColors.includes(betValue)) {
        socket.emit('roulette_error', 'Invalid color betValue.');
        return;
      }
    } else if (betType === 'parity') {
      if (!validParities.includes(betValue)) {
        socket.emit('roulette_error', 'Invalid parity betValue.');
        return;
      }
    } else {
      socket.emit('roulette_error', 'Unsupported bet type.');
      return;
    }

    try {
      const user = await User.findById(userId);
      if (!user) {
        socket.emit('roulette_error', 'User not found.');
        return;
      }
      if (user.balance < amount) {
        socket.emit('roulette_error', 'Insufficient balance.');
        return;
      }

      user.balance -= amount;
      await user.save();

      // Add bet to player's bets
      player.bets.push({ betType, betValue, amount });

      socket.emit('roulette_bet_placed', {
        betType, betValue, amount,
        newBalance: user.balance,
      });
    } catch (err) {
      console.error('Error placing roulette bet:', err);
      socket.emit('roulette_error', 'Server error placing bet.');
    }
  });
});

// Middleware and routes

app.use(cors({
  origin: ['http://localhost:3000', 'https://dgenrand0.vercel.app'],
  credentials: true,
}));
app.use(express.json());

mongoose.connect(process.env.MONGO_URL, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
}).then(() => console.log('Connected to MongoDB')).catch(console.error);

const userSchema = new mongoose.Schema({
  username: { type: String, unique: true },
  email: String,
  password: String,
  balance: { type: Number, default: 1000 },
});
const User = mongoose.model('User', userSchema);

function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
    if (err) return res.status(403).json({ error: 'Forbidden' });
    req.userId = decoded.id;
    next();
  });
}

// Auth routes

app.post('/api/register', async (req, res) => {
  const { username, email, password } = req.body;
  if (!username || !email || !password) return res.status(400).json({ error: 'Missing fields' });

  const hashed = await bcrypt.hash(password, 10);
  try {
    const user = new User({ username, email, password: hashed });
    await user.save();
    res.json({ message: 'Registered successfully' });
  } catch (err) {
    res.status(400).json({ error: 'Username or email already exists' });
  }
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Missing fields' });

  const user = await User.findOne({ username });
  if (!user) return res.status(400).json({ error: 'Invalid username or password' });

  const valid = await bcrypt.compare(password, user.password);
  if (!valid) return res.status(400).json({ error: 'Invalid username or password' });

  const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: '1d' });
  res.json({ token, username: user.username, balance: user.balance, id: user._id });
});

// Get balance
app.get('/api/balance', authMiddleware, async (req, res) => {
  const user = await User.findById(req.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ balance: user.balance });
});

// Coinflip game (existing)

app.post('/api/game/coinflip', authMiddleware, async (req, res) => {
  const { amount, side } = req.body;
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });
  if (!['heads', 'tails'].includes(side)) return res.status(400).json({ error: 'Invalid side' });

  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.balance < amount) return res.status(400).json({ error: 'Insufficient balance' });

    const serverSeed = crypto.randomBytes(16).toString('hex');
    const hash = crypto.createHash('sha256').update(serverSeed).digest('hex');
    const outcome = parseInt(hash.slice(0, 8), 16) % 2 === 0 ? 'heads' : 'tails';

    let win = false;
    if (outcome === side) {
      win = true;
      user.balance += amount;
    } else {
      user.balance -= amount;
    }
    await user.save();

    res.json({ outcome, win, newBalance: user.balance, serverSeed, hash });
  } catch (err) {
    console.error('Coinflip error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Roulette REST API (instant spin)
app.post('/api/game/roulette', authMiddleware, async (req, res) => {
  const { amount, betType, betValue } = req.body;

  if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid bet amount' });

  const validColors = ['red', 'black'];
  const validParities = ['odd', 'even'];

  if (!betType || betValue === undefined || betValue === null) {
    return res.status(400).json({ error: 'Bet type and value required' });
  }

  if (betType === 'number') {
    if (typeof betValue !== 'number' || betValue < 0 || betValue > 36) {
      return res.status(400).json({ error: 'Invalid number betValue' });
    }
  } else if (betType === 'color') {
    if (!validColors.includes(betValue)) {
      return res.status(400).json({ error: 'Invalid color betValue' });
    }
  } else if (betType === 'parity') {
    if (!validParities.includes(betValue)) {
      return res.status(400).json({ error: 'Invalid parity betValue' });
    }
  } else {
    return res.status(400).json({ error: 'Unsupported bet type' });
  }

  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.balance < amount) return res.status(400).json({ error: 'Insufficient balance' });

    const serverSeed = crypto.randomBytes(16).toString('hex');
    const hash = crypto.createHash('sha256').update(serverSeed).digest('hex');
    const outcomeNumber = parseInt(hash.slice(0, 8), 16) % 37;

    let outcomeColor = 'green';
    if (redNumbers.includes(outcomeNumber)) outcomeColor = 'red';
    else if (blackNumbers.includes(outcomeNumber)) outcomeColor = 'black';

    let outcomeParity = null;
    if (outcomeNumber !== 0) {
      outcomeParity = outcomeNumber % 2 === 0 ? 'even' : 'odd';
    }

    let win = false;
    let payoutMultiplier = 0;

    if (betType === 'number') {
      if (betValue === outcomeNumber) {
        win = true;
        payoutMultiplier = 35;
      }
    } else if (betType === 'color') {
      if (betValue === outcomeColor) {
        win = true;
        payoutMultiplier = 2;
      }
    } else if (betType === 'parity') {
      if (outcomeNumber !== 0 && betValue === outcomeParity) {
        win = true;
        payoutMultiplier = 2;
      }
    }

    if (win) {
      user.balance += amount * (payoutMultiplier - 1);
    } else {
      user.balance -= amount;
    }

    await user.save();

    res.json({
      outcome: {
        number: outcomeNumber,
        color: outcomeColor,
        parity: outcomeParity,
      },
      win,
      payoutMultiplier: win ? payoutMultiplier : 0,
      newBalance: user.balance,
      serverSeed,
      hash,
    });
  } catch (err) {
    console.error('Roulette game error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
