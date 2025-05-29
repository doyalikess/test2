// routes/user.js

const express = require('express');
const User = require('../models/User');
const jwt = require('jsonwebtoken');
const router = express.Router();

// Middleware to protect routes and get user ID from token
function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Authorization header missing' });

  const token = authHeader.split(' ')[1]; // Extract token from "Bearer <token>"
  if (!token) return res.status(401).json({ error: 'Token missing' });

  try {
    // Decode the token to get the user ID
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.userId = decoded.userId; // Attach userId to request object
    next();
  } catch (err) {
    res.status(401).json({ error: 'Invalid token' });
  }
}

// Route to add balance for the user
router.post('/add-balance', authMiddleware, async (req, res) => {
  const { amount } = req.body;
  
  if (!amount || amount <= 0) {
    return res.status(400).json({ error: 'Amount must be a positive number' });
  }

  try {
    // Find the user by userId (attached to req object by authMiddleware)
    const user = await User.findById(req.userId);
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Add the balance to the user's current balance
    user.balance += amount;

    // Save the updated user
    await user.save();

    // Respond with success message and updated balance
    res.json({
      message: 'Balance updated successfully',
      balance: user.balance
    });
  } catch (err) {
    console.error('Error updating balance:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
