// routes/auth.js
const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const User = require('../models/User');
const router = express.Router();

// Signup
router.post('/signup', async (req, res) => {
  const { username, password } = req.body;

  try {
    const user = new User({ username });
    await user.setPassword(password);
    await user.save();
    res.json({ message: 'User created successfully' });
  } catch (err) {
    res.status(500).json({ error: 'Error creating user' });
  }
});

// Login
router.post('/login', async (req, res) => {
  const { username, password } = req.body;

  try {
    const user = await User.findOne({ username });
    if (!user) return res.status(400).json({ error: 'Invalid credentials' });

    const validPassword = await user.validatePassword(password);
    if (!validPassword) return res.status(400).json({ error: 'Invalid credentials' });

    const token = jwt.sign({ userId: user._id }, process.env.JWT_SECRET, { expiresIn: '1d' });
    res.json({ token, username: user.username, balance: user.balance });
  } catch (err) {
    res.status(500).json({ error: 'Error logging in' });
  }
});

module.exports = router;
