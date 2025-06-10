// This file handles interactions with the BlockCypher API for crypto address generation and monitoring
const axios = require('axios');

/**
 * Generate a new Bitcoin address using BlockCypher API
 * @returns {Promise<Object>} The address data
 */
async function generateBitcoinAddress() {
  try {
    const response = await axios.post('https://api.blockcypher.com/v1/btc/main/addrs');
    return {
      address: response.data.address,
      privateKey: response.data.private, // IMPORTANT: Do not store this in your database
      publicKey: response.data.public
    };
  } catch (error) {
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
    const response = await axios.post('https://api.blockcypher.com/v1/eth/main/addrs');
    return {
      address: response.data.address,
      privateKey: response.data.private, // IMPORTANT: Do not store this in your database
      publicKey: response.data.public
    };
  } catch (error) {
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
    const response = await axios.get(`https://api.blockcypher.com/v1/btc/main/addrs/${address}/balance`);
    // Convert from satoshis to BTC
    return response.data.balance / 100000000;
  } catch (error) {
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
    const response = await axios.get(`https://api.blockcypher.com/v1/eth/main/addrs/${address}/balance`);
    // Convert from wei to ETH
    return response.data.balance / 1000000000000000000;
  } catch (error) {
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
    const response = await axios.post(`https://api.blockcypher.com/v1/${coinPath}/hooks`, {
      event: 'confirmed-tx',
      address: address,
      url: url
    });
    return response.data;
  } catch (error) {
    console.error('Error creating webhook:', error.response?.data || error.message);
    throw new Error('Failed to create address webhook');
  }
}

module.exports = {
  generateBitcoinAddress,
  generateEthereumAddress,
  getBitcoinAddressBalance,
  getEthereumAddressBalance,
  createAddressWebhook
};
