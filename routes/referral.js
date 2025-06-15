const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const User = require('../models/user');
const Wager = require('../models/wager');

// Set referral reward percentage
const REFERRAL_REWARD_PERCENT = 1; // 1% of referred user's wagers

// Fixed Auth middleware
function authMiddleware(req, res, next) {
  const token = req.header('Authorization')?.replace('Bearer ', '');
  
  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.userId = decoded.userId || decoded.id;
    next();
  } catch (error) {
    res.status(401).json({ error: 'Invalid token' });
  }
}

// Get user's referral code
router.get('/code', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    res.json({ 
      referralCode: user.referralCode,
      referralLink: user.getReferralLink()
    });
  } catch (err) {
    console.error('Error getting referral code:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Regenerate referral code
router.post('/regenerate-code', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    
    // Generate a new random code
    user.referralCode = crypto.randomBytes(4).toString('hex').toUpperCase();
    await user.save();
    
    res.json({ 
      referralCode: user.referralCode,
      referralLink: user.getReferralLink()
    });
  } catch (err) {
    console.error('Error regenerating referral code:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get user's referral stats
router.get('/stats', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    
    // Get referral stats
    const referralStats = await user.getReferralStats();
    
    res.json(referralStats);
  } catch (err) {
    console.error('Error getting referral stats:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Apply a referral code
router.post('/apply', authMiddleware, async (req, res) => {
  const { referralCode } = req.body;
  
  if (!referralCode) {
    return res.status(400).json({ error: 'Referral code is required' });
  }
  
  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    
    // Check if user already has a referrer
    if (user.referredBy) {
      return res.status(400).json({ error: 'You already have a referrer' });
    }
    
    // Apply the referral code
    await User.applyReferralCode(req.userId, referralCode);
    
    res.json({ message: 'Referral code applied successfully' });
  } catch (err) {
    console.error('Error applying referral code:', err);
    res.status(400).json({ error: err.message || 'Failed to apply referral code' });
  }
});

// Get referral leaderboard
router.get('/leaderboard', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 10;
    
    // Get top referrers by count
    const topReferrers = await User.find()
      .sort({ referralCount: -1 })
      .limit(limit)
      .select('username referralCount referralEarnings -_id');
    
    res.json(topReferrers);
  } catch (err) {
    console.error('Error getting referral leaderboard:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Process referral rewards (typically called by a scheduled job)
router.post('/process-rewards', authMiddleware, async (req, res) => {
  try {
    res.json({
      message: 'Referral rewards are now processed instantly when bets are placed',
      totalProcessed: 0,
      totalRewards: 0
    });
  } catch (err) {
    console.error('Error in process-rewards endpoint:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Instant referral reward processing function
async function processInstantReferralReward(userId, wagerAmount, gameType) {
  try {
    const user = await User.findById(userId);
    if (!user || !user.referredBy) return;
    
    const rewardAmount = wagerAmount * (REFERRAL_REWARD_PERCENT / 100);
    if (rewardAmount <= 0) return;
    
    // Update referrer balance immediately - no pending rewards
    await User.findByIdAndUpdate(
      user.referredBy,
      { 
        $inc: { 
          balance: rewardAmount,
          referralEarnings: rewardAmount 
        } 
      }
    );
    
    console.log(`✅ Instant referral reward: $${rewardAmount.toFixed(2)} to referrer from ${userId}'s $${wagerAmount} ${gameType} wager`);
  } catch (error) {
    console.error('Error processing instant referral reward:', error);
  }
}

// Export both the router and the function
module.exports = router;
module.exports.processInstantReferralReward = processInstantReferralReward;

module.exports = router;
