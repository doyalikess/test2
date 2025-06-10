// services/crypto-service.js
const axios = require('axios');
const crypto = require('crypto');
const User = require('../models/user');

const API_KEY = process.env.NOWPAYMENTS_API_KEY;
const API_URL = 'https://api.nowpayments.io/v1';

// Generate a deposit address for a user
async function generateAddress(userId, currency) {
  try {
    const response = await axios.post(`${API_URL}/deposit`, {
      ipn_callback_url: `https://your-server.com/api/crypto/${currency.toLowerCase()}-webhook`,
      currency: currency.toUpperCase()
    }, {
      headers: {
        'x-api-key': API_KEY,
        'Content-Type': 'application/json'
      }
    });

    // Store the address in the user's account
    const user = await User.findById(userId);
    if (!user.cryptoAddresses) {
      user.cryptoAddresses = {};
    }
    user.cryptoAddresses[currency.toLowerCase()] = response.data.address;
    await user.save();

    return response.data.address;
  } catch (error) {
    console.error(`Error generating ${currency} address:`, error);
    throw new Error(`Failed to generate ${currency} address`);
  }
}

// Check balance of an address
async function checkBalance(address, currency) {
  try {
    const response = await axios.get(`${API_URL}/balance/${currency.toLowerCase()}/${address}`, {
      headers: {
        'x-api-key': API_KEY
      }
    });
    return response.data.balance;
  } catch (error) {
    console.error(`Error checking ${currency} balance:`, error);
    throw new Error(`Failed to check ${currency} balance`);
  }
}

module.exports = { generateAddress, checkBalance };
