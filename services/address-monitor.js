// This file provides functionality to monitor crypto addresses for deposits
const User = require('../models/updated-user');
const { 
  getBitcoinAddressBalance,
  getEthereumAddressBalance
} = require('./crypto-service');

/**
 * Monitor all Bitcoin addresses in the system for deposits
 * This can be run periodically as a fallback in case webhooks fail
 */
async function monitorBitcoinAddresses() {
  console.log('Starting Bitcoin address monitoring...');
  
  try {
    // Find all users with Bitcoin addresses
    const users = await User.find({ 'cryptoAddresses.bitcoin': { $ne: null } });
    console.log(`Found ${users.length} Bitcoin addresses to monitor`);
    
    for (const user of users) {
      const address = user.cryptoAddresses.bitcoin;
      
      try {
        // Get the address balance
        const balance = await getBitcoinAddressBalance(address);
        
        if (balance > 0) {
          console.log(`Detected Bitcoin balance of ${balance} BTC for user ${user.username} (${user._id})`);
          
          // Add balance to user account
          // In production, you would need more sophisticated logic to track
          // which deposits have already been processed
          user.balance += balance;
          await user.save();
          
          console.log(`Updated balance for user ${user.username}: ${user.balance}`);
        }
      } catch (error) {
        console.error(`Error checking balance for Bitcoin address ${address}:`, error);
      }
    }
    
    console.log('Bitcoin address monitoring completed');
  } catch (error) {
    console.error('Error in Bitcoin address monitoring:', error);
  }
}

/**
 * Monitor all Ethereum addresses in the system for deposits
 * This can be run periodically as a fallback in case webhooks fail
 */
async function monitorEthereumAddresses() {
  console.log('Starting Ethereum address monitoring...');
  
  try {
    // Find all users with Ethereum addresses
    const users = await User.find({ 'cryptoAddresses.ethereum': { $ne: null } });
    console.log(`Found ${users.length} Ethereum addresses to monitor`);
    
    for (const user of users) {
      const address = user.cryptoAddresses.ethereum;
      
      try {
        // Get the address balance
        const balance = await getEthereumAddressBalance(address);
        
        if (balance > 0) {
          console.log(`Detected Ethereum balance of ${balance} ETH for user ${user.username} (${user._id})`);
          
          // Add balance to user account
          // In production, you would need more sophisticated logic to track
          // which deposits have already been processed
          user.balance += balance;
          await user.save();
          
          console.log(`Updated balance for user ${user.username}: ${user.balance}`);
        }
      } catch (error) {
        console.error(`Error checking balance for Ethereum address ${address}:`, error);
      }
    }
    
    console.log('Ethereum address monitoring completed');
  } catch (error) {
    console.error('Error in Ethereum address monitoring:', error);
  }
}

/**
 * Monitor all crypto addresses in the system
 * This can be scheduled to run periodically (e.g., every hour)
 */
async function monitorAllAddresses() {
  await monitorBitcoinAddresses();
  await monitorEthereumAddresses();
}

module.exports = {
  monitorBitcoinAddresses,
  monitorEthereumAddresses,
  monitorAllAddresses
};
