const express = require('express');
const router = express.Router();
const User = require('../models/user'); // Changed from updated-user to match server.js
const crypto = require('crypto');

// Use this to switch to mock mode when hitting rate limits
const USE_MOCK_MODE = true; // Hardcode to true for now

const jwt = require('jsonwebtoken');

// Auth middleware - same as in server.js
function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Authorization header missing' });

  const token = authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Token missing' });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret_key');
    req.userId = decoded.userId;
    next();
  } catch (error) {
    console.error('JWT verification error:', error.message);
    res.status(401).json({ error: 'Invalid token' });
  }
}

// Define mock functions here
function generateMockBitcoinAddress() {
  return {
    address: `1Mock${Math.random().toString(36).substring(2, 10)}BitcoinAddress`,
    privateKey: 'mock_private_key_do_not_use',
    publicKey: 'mock_public_key'
  };
}

function generateMockEthereumAddress() {
  return {
    address: `0x${Math.random().toString(36).substring(2, 10)}MockEthereumAddress`,
    privateKey: 'mock_private_key_do_not_use',
    publicKey: 'mock_public_key'
  };
}

// Generate a new Bitcoin address for the authenticated user
router.post('/generate-btc-address', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Check if user already has a Bitcoin address
    if (user.cryptoAddresses && user.cryptoAddresses.bitcoin) {
      return res.json({ 
        address: user.cryptoAddresses.bitcoin,
        message: 'You already have a Bitcoin address'
      });
    }

    // Generate a mock Bitcoin address
    const addressData = generateMockBitcoinAddress();
    
    // Store only the public address in database (NEVER store private keys in DB)
    if (!user.cryptoAddresses) {
      user.cryptoAddresses = {};
    }
    user.cryptoAddresses.bitcoin = addressData.address;
    await user.save();

    res.json({ 
      address: addressData.address,
      message: 'Bitcoin address generated successfully'
    });
  } catch (error) {
    console.error('Error generating Bitcoin address:', error);
    res.status(500).json({ error: error.message || 'Server error' });
  }
});

// Generate a new Ethereum address for the authenticated user
router.post('/generate-eth-address', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Check if user already has an Ethereum address
    if (user.cryptoAddresses && user.cryptoAddresses.ethereum) {
      return res.json({ 
        address: user.cryptoAddresses.ethereum,
        message: 'You already have an Ethereum address'
      });
    }

    // Generate a mock Ethereum address
    const addressData = generateMockEthereumAddress();
    
    // Store only the public address in database
    if (!user.cryptoAddresses) {
      user.cryptoAddresses = {};
    }
    user.cryptoAddresses.ethereum = addressData.address;
    await user.save();

    res.json({ 
      address: addressData.address,
      message: 'Ethereum address generated successfully'
    });
  } catch (error) {
    console.error('Error generating Ethereum address:', error);
    res.status(500).json({ error: error.message || 'Server error' });
  }
});

// Get all crypto addresses for the authenticated user
router.get('/addresses', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Ensure the cryptoAddresses object exists
    const addresses = user.cryptoAddresses || { bitcoin: null, ethereum: null };

    res.json({
      bitcoin: addresses.bitcoin,
      ethereum: addresses.ethereum
    });
  } catch (error) {
    console.error('Error fetching addresses:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Manual check for balances (for testing/backup)
router.get('/check-balances', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Generate random mock balances for testing
    const btcBalance = Math.random() * 0.01;
    const ethBalance = Math.random() * 0.1;

    res.json({
      bitcoin: {
        address: user.cryptoAddresses?.bitcoin || null,
        balance: btcBalance
      },
      ethereum: {
        address: user.cryptoAddresses?.ethereum || null,
        balance: ethBalance
      }
    });
  } catch (error) {
    console.error('Error checking balances:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Webhook handler for Bitcoin deposits
router.post('/btc-webhook', async (req, res) => {
  try {
    const { address, hash, total, confirmations } = req.body;
    
    // Only process confirmed transactions (2+ confirmations)
    if (confirmations < 2) {
      return res.status(200).send('Waiting for more confirmations');
    }
    
    // Find user with this address
    const user = await User.findOne({ 'cryptoAddresses.bitcoin': address });
    if (!user) {
      return res.status(404).json({ error: 'User not found for this address' });
    }
    
    // Convert from satoshis to BTC
    const btcAmount = total / 100000000;
    
    // Update user balance
    // Note: In production, you'd want to check if this transaction was already processed
    user.balance += btcAmount;
    await user.save();
    
    console.log(`Bitcoin deposit: ${btcAmount} BTC for user ${user.username}`);
    
    res.status(200).json({ message: 'Deposit processed successfully' });
  } catch (error) {
    console.error('BTC webhook error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Webhook handler for Ethereum deposits
router.post('/eth-webhook', async (req, res) => {
  try {
    const { address, hash, total, confirmations } = req.body;
    
    // Only process confirmed transactions (12+ confirmations for ETH)
    if (confirmations < 12) {
      return res.status(200).send('Waiting for more confirmations');
    }
    
    // Find user with this address
    const user = await User.findOne({ 'cryptoAddresses.ethereum': address });
    if (!user) {
      return res.status(404).json({ error: 'User not found for this address' });
    }
    
    // Convert from wei to ETH
    const ethAmount = total / 1000000000000000000;
    
    // Update user balance
    // Note: In production, you'd want to check if this transaction was already processed
    user.balance += ethAmount;
    await user.save();
    
    console.log(`Ethereum deposit: ${ethAmount} ETH for user ${user.username}`);
    
    res.status(200).json({ message: 'Deposit processed successfully' });
  } catch (error) {
    console.error('ETH webhook error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
