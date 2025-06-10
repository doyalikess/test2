// This file handles interactions with the BlockCypher API for crypto address generation and monitoring
const axios = require('axios');

// Optional: Your BlockCypher API token if you have one
const BLOCKCYPHER_TOKEN = process.env.BLOCKCYPHER_TOKEN || '';

// Add token to URL if available
const appendToken = (url) => {
  if (BLOCKCYPHER_TOKEN) {
    return `${url}${url.includes('?') ? '&' : '?'}token=${BLOCKCYPHER_TOKEN}`;
  }
  return url;
};

// Implement retry logic with exponential backoff
const axiosWithRetry = async (config, retries = 3, delay = 1000) => {
  try {
    return await axios(config);
  } catch (error) {
    // If we've run out of retries or it's not a rate limit error, throw
    if (retries === 0 || (error.response && error.response.status !== 429)) {
      throw error;
    }
    
    console.log(`Rate limited. Retrying in ${delay}ms...`);
    await new Promise(resolve => setTimeout(resolve, delay));
    
    // Retry with exponential backoff
    return axiosWithRetry(config, retries - 1, delay * 2);
  }
};

/**
 * Generate a new Bitcoin address using BlockCypher API
 * @returns {Promise<Object>} The address data
 */
async function generateBitcoinAddress() {
  try {
    // Check local cache first (if you implement caching)
    
    // Use the API with retry logic
    const response = await axiosWithRetry({
      method: 'post',
      url: appendToken('https://api.blockcypher.com/v1/btc/main/addrs'),
      timeout: 10000 // 10 second timeout
    });
    
    return {
      address: response.data.address,
      privateKey: response.data.private, // IMPORTANT: Do not store this in your database
      publicKey: response.data.public
    };
  } catch (error) {
    // Specific error handling for rate limiting
    if (error.response && error.response.status === 429) {
      console.error('BlockCypher API rate limit exceeded. Please try again later.');
      throw new Error('API rate limit exceeded. Please try again in a few minutes.');
    }
    
    console.error('Error generating Bitcoin address:', error.response?.data || error.message);
    throw new Error('Failed to generate Bitcoin address');
  }
}

/**
 * Generate a new Ethereum address using BlockCypher API
 * @returns {Promise<Object>} The address data
 */
async function generateEthereumAddress() {
  try {
    // Use the API with retry logic
    const response = await axiosWithRetry({
      method: 'post',
      url: appendToken('https://api.blockcypher.com/v1/eth/main/addrs'),
      timeout: 10000 // 10 second timeout
    });
    
    return {
      address: response.data.address,
      privateKey: response.data.private, // IMPORTANT: Do not store this in your database
      publicKey: response.data.public
    };
  } catch (error) {
    // Specific error handling for rate limiting
    if (error.response && error.response.status === 429) {
      console.error('BlockCypher API rate limit exceeded. Please try again later.');
      throw new Error('API rate limit exceeded. Please try again in a few minutes.');
    }
    
    console.error('Error generating Ethereum address:', error.response?.data || error.message);
    throw new Error('Failed to generate Ethereum address');
  }
}

/**
 * Get balance for a Bitcoin address
 * @param {string} address - The Bitcoin address to check
 * @returns {Promise<number>} The balance in BTC
 */
async function getBitcoinAddressBalance(address) {
  try {
    // Use the API with retry logic
    const response = await axiosWithRetry({
      method: 'get',
      url: appendToken(`https://api.blockcypher.com/v1/btc/main/addrs/${address}/balance`),
      timeout: 10000
    });
    
    // Convert from satoshis to BTC
    return response.data.balance / 100000000;
  } catch (error) {
    // Don't throw on balance check errors, just log and return 0
    console.error('Error checking Bitcoin balance:', error.response?.data || error.message);
    return 0;
  }
}

/**
 * Get balance for an Ethereum address
 * @param {string} address - The Ethereum address to check
 * @returns {Promise<number>} The balance in ETH
 */
async function getEthereumAddressBalance(address) {
  try {
    // Use the API with retry logic
    const response = await axiosWithRetry({
      method: 'get',
      url: appendToken(`https://api.blockcypher.com/v1/eth/main/addrs/${address}/balance`),
      timeout: 10000
    });
    
    // Convert from wei to ETH
    return response.data.balance / 1000000000000000000;
  } catch (error) {
    // Don't throw on balance check errors, just log and return 0
    console.error('Error checking Ethereum balance:', error.response?.data || error.message);
    return 0;
  }
}

/**
 * Create a webhook for real-time notifications on address activities
 * @param {string} address - The cryptocurrency address to monitor
 * @param {string} url - The callback URL for notifications
 * @param {string} coin - The coin type (btc or eth)
 * @returns {Promise<Object>} The webhook data
 */
async function createAddressWebhook(address, url, coin = 'btc') {
  try {
    const coinPath = coin === 'eth' ? 'eth/main' : 'btc/main';
    
    // Use the API with retry logic
    const response = await axiosWithRetry({
      method: 'post',
      url: appendToken(`https://api.blockcypher.com/v1/${coinPath}/hooks`),
      data: {
        event: 'confirmed-tx',
        address: address,
        url: url
      },
      timeout: 10000
    });
    
    return response.data;
  } catch (error) {
    // Specific error handling for rate limiting
    if (error.response && error.response.status === 429) {
      console.error('BlockCypher API rate limit exceeded. Please try again later.');
      throw new Error('API rate limit exceeded. Please try again in a few minutes.');
    }
    
    console.error('Error creating webhook:', error.response?.data || error.message);
    throw new Error('Failed to create address webhook');
  }
}

// For testing/development - returns a mock address without calling the API
function generateMockBitcoinAddress() {
  return {
    address: `1Mock${Math.random().toString(36).substring(2, 10)}BitcoinAddress`,
    privateKey: 'mock_private_key_do_not_use',
    publicKey: 'mock_public_key'
  };
}

// For testing/development - returns a mock address without calling the API
function generateMockEthereumAddress() {
  return {
    address: `0x${Math.random().toString(36).substring(2, 10)}MockEthereumAddress`,
    privateKey: 'mock_private_key_do_not_use',
    publicKey: 'mock_public_key'
  };
}

module.exports = {
  generateBitcoinAddress,
  generateEthereumAddress,
  getBitcoinAddressBalance,
  getEthereumAddressBalance,
  createAddressWebhook,
  // Export mock functions for development/testing
  generateMockBitcoinAddress,
  generateMockEthereumAddress
};
