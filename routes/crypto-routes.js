const express = require('express');
const router = express.Router();
const User = require('../models/user'); // Changed from updated-user to match server.js
const { 
  generateBitcoinAddress, 
  generateEthereumAddress,
  getBitcoinAddressBalance,
  getEthereumAddressBalance,
  createAddressWebhook,
  // For development/testing when hitting rate limits
  generateMockBitcoinAddress,
  generateMockEthereumAddress
} = require('../services/crypto-service');

// Use this to switch to mock mode when hitting rate limits
const USE_MOCK_MODE = process.env.NODE_ENV === 'development';

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

    // Generate a new Bitcoin address - use mock in development if enabled
    const addressData = USE_MOCK_MODE ? 
      generateMockBitcoinAddress() : 
      await generateBitcoinAddress();
    
    // Store only the public address in database (NEVER store private keys in DB)
    if (!user.cryptoAddresses) {
      user.cryptoAddresses = {};
    }
    user.cryptoAddresses.bitcoin = addressData.address;
    await user.save();
    
    // Create a webhook for this address if a webhook URL is configured
    if (process.env.WEBHOOK_CALLBACK_URL && !USE_MOCK_MODE) {
      try {
        const webhook = await createAddressWebhook(
          addressData.address,
          `${process.env.WEBHOOK_CALLBACK_URL}/api/crypto/btc-webhook`,
          'btc'
        );
        
        // Store the webhook ID for future reference
        if (!user.webhooks) {
          user.webhooks = {};
        }
        user.webhooks.bitcoin = webhook.id;
        await user.save();
      } catch (webhookError) {
        console.error('Webhook creation error:', webhookError);
        // Continue even if webhook creation fails
      }
    }

    res.json({ 
      address: addressData.address,
      message: 'Bitcoin address generated successfully'
    });
  } catch (error) {
    console.error('Error generating Bitcoin address:', error);
    
    // Handle rate limit errors specially
    if (error.message && error.message.includes('rate limit')) {
      return res.status(429).json({ 
        error: 'API rate limit exceeded. Please try again in a few minutes.' 
      });
    }
    
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

    // Generate a new Ethereum address - use mock in development if enabled
    const addressData = USE_MOCK_MODE ? 
      generateMockEthereumAddress() : 
      await generateEthereumAddress();
    
    // Store only the public address in database
    if (!user.cryptoAddresses) {
      user.cryptoAddresses = {};
    }
    user.cryptoAddresses.ethereum = addressData.address;
    await user.save();
    
    // Create a webhook for this address if a webhook URL is configured
    if (process.env.WEBHOOK_CALLBACK_URL && !USE_MOCK_MODE) {
      try {
        const webhook = await createAddressWebhook(
          addressData.address,
          `${process.env.WEBHOOK_CALLBACK_URL}/api/crypto/eth-webhook`,
          'eth'
        );
        
        // Store the webhook ID for future reference
        if (!user.webhooks) {
          user.webhooks = {};
        }
        user.webhooks.ethereum = webhook.id;
        await user.save();
      } catch (webhookError) {
        console.error('Webhook creation error:', webhookError);
        // Continue even if webhook creation fails
      }
    }

    res.json({ 
      address: addressData.address,
      message: 'Ethereum address generated successfully'
    });
  } catch (error) {
    console.error('Error generating Ethereum address:', error);
    
    // Handle rate limit errors specially
    if (error.message && error.message.includes('rate limit')) {
      return res.status(429).json({ 
        error: 'API rate limit exceeded. Please try again in a few minutes.' 
      });
    }
    
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

    let btcBalance = 0;
    let ethBalance = 0;

    // Check BTC balance if address exists
    if (user.cryptoAddresses && user.cryptoAddresses.bitcoin) {
      btcBalance = await getBitcoinAddressBalance(user.cryptoAddresses.bitcoin);
    }

    // Check ETH balance if address exists
    if (user.cryptoAddresses && user.cryptoAddresses.ethereum) {
      ethBalance = await getEthereumAddressBalance(user.cryptoAddresses.ethereum);
    }

    // Return mock data in development mode if enabled
    if (USE_MOCK_MODE) {
      // Generate some random small values for testing
      btcBalance = Math.random() * 0.01;
      ethBalance = Math.random() * 0.1;
    }

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
