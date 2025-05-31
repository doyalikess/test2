// routes/user.js

const express = require('express');
const User = require('../models/User');
const jwt = require('jsonwebtoken');
const router = express.Router();

// ===================
// Middleware
// ===================
function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Authorization header missing' });

  const token = authHeader.split(' ')[1]; // Format: "Bearer <token>"
  if (!token) return res.status(401).json({ error: 'Token missing' });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.userId = decoded.userId;
    next();
  } catch (err) {
    res.status(401).json({ error: 'Invalid token' });
  }
}

// ===================
// Register Route
// ===================
router.post('/register', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password)
    return res.status(400).json({ error: 'Username and password are required' });

  try {
    const existingUser = await User.findOne({ username });
    if (existingUser)
      return res.status(409).json({ error: 'Username already taken' });

    const newUser = new User({ username });
    await newUser.setPassword(password);
    await newUser.save();

    const token = jwt.sign({ userId: newUser._id }, process.env.JWT_SECRET, {
      expiresIn: '7d',
    });

    res.status(201).json({
      message: 'User registered successfully',
      token,
      username: newUser.username,
      balance: newUser.balance,
    });
  } catch (err) {
    console.error('Registration error:', err);
    res.status(500).json({ error: 'Server error during registration' });
  }
});

// ===================
// Login Route
// ===================
router.post('/login', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password)
    return res.status(400).json({ error: 'Username and password are required' });

  try {
    const user = await User.findOne({ username });
    if (!user || !(await user.validatePassword(password)))
      return res.status(401).json({ error: 'Invalid username or password' });

    const token = jwt.sign({ userId: user._id }, process.env.JWT_SECRET, {
      expiresIn: '7d',
    });

    res.json({
      token,
      username: user.username,
      balance: user.balance,
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Server error during login' });
  }
});

// ===================
// Add Balance Route
// ===================
router.post('/add-balance', authMiddleware, async (req, res) => {
  const { amount } = req.body;

  if (!amount || isNaN(amount) || amount <= 0)
    return res.status(400).json({ error: 'Amount must be a positive number' });

  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    user.balance += Number(amount);
    await user.save();

    res.json({
      message: 'Balance updated successfully',
      balance: user.balance,
    });
  } catch (err) {
    console.error('Error updating balance:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
