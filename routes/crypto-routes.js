const express = require('express');
const router = express.Router();
const User = require('../models/updated-user');
const { 
  generateBitcoinAddress, 
  generateEthereumAddress,
  getBitcoinAddressBalance,
  getEthereumAddressBalance,
  createAddressWebhook
} = require('../services/crypto-service');

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
  } catch {
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
    if (user.cryptoAddresses.bitcoin) {
      return res.json({ 
        address: user.cryptoAddresses.bitcoin,
        message: 'You already have a Bitcoin address'
      });
    }

    // Generate a new Bitcoin address
    const addressData = await generateBitcoinAddress();
    
    // Store only the public address in database (NEVER store private keys in DB)
    await user.setBitcoinAddress(addressData.address);
    
    // Create a webhook for this address if a webhook URL is configured
    if (process.env.WEBHOOK_CALLBACK_URL) {
      try {
        const webhook = await createAddressWebhook(
          addressData.address,
          `${process.env.WEBHOOK_CALLBACK_URL}/api/crypto/btc-webhook`,
          'btc'
        );
        
        // Store the webhook ID for future reference
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
    res.status(500).json({ error: 'Server error' });
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
    if (user.cryptoAddresses.ethereum) {
      return res.json({ 
        address: user.cryptoAddresses.ethereum,
        message: 'You already have an Ethereum address'
      });
    }

    // Generate a new Ethereum address
    const addressData = await generateEthereumAddress();
    
    // Store only the public address in database
    await user.setEthereumAddress(addressData.address);
    
    // Create a webhook for this address if a webhook URL is configured
    if (process.env.WEBHOOK_CALLBACK_URL) {
      try {
        const webhook = await createAddressWebhook(
          addressData.address,
          `${process.env.WEBHOOK_CALLBACK_URL}/api/crypto/eth-webhook`,
          'eth'
        );
        
        // Store the webhook ID for future reference
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
    res.status(500).json({ error: 'Server error' });
  }
});

// Get all crypto addresses for the authenticated user
router.get('/addresses', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({
      bitcoin: user.cryptoAddresses.bitcoin,
      ethereum: user.cryptoAddresses.ethereum
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
    if (user.cryptoAddresses.bitcoin) {
      btcBalance = await getBitcoinAddressBalance(user.cryptoAddresses.bitcoin);
    }

    // Check ETH balance if address exists
    if (user.cryptoAddresses.ethereum) {
      ethBalance = await getEthereumAddressBalance(user.cryptoAddresses.ethereum);
    }

    res.json({
      bitcoin: {
        address: user.cryptoAddresses.bitcoin,
        balance: btcBalance
      },
      ethereum: {
        address: user.cryptoAddresses.ethereum,
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
