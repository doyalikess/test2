const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const crypto = require('crypto');

// Define referral reward percentage constant
const REFERRAL_REWARD_PERCENT = 1; // 1% commission on wagers

const UserSchema = new mongoose.Schema({
  username: { 
    type: String, 
    unique: true, 
    required: true 
  },
  passwordHash: { 
    type: String, 
    required: true 
  },
  balance: { 
    type: Number, 
    default: 0 
  },
  // Crypto deposit addresses
  cryptoAddresses: {
    bitcoin: { type: String, default: null },
    ethereum: { type: String, default: null }
  },
  // Store webhook IDs for each address (to manage/delete later if needed)
  webhooks: {
    bitcoin: { type: String, default: null },
    ethereum: { type: String, default: null }
  },
  // Referral System Fields
  referralCode: { 
    type: String, 
    unique: true,
    default: function() {
      return crypto.randomBytes(4).toString('hex').toUpperCase();
    }
  },
  referredBy: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'User',
    default: null
  },
  pendingReferralChange: {
    newReferrer: { 
      type: mongoose.Schema.Types.ObjectId, 
      ref: 'User' 
    },
    expiresAt: { 
      type: Date 
    }
  },
  // Wagering Stats
  totalWagered: { 
    type: Number, 
    default: 0 
  },
  referralEarnings: { 
    type: Number, 
    default: 0 
  },
  // Track the number of referred users
  referralCount: {
    type: Number,
    default: 0
  },
  signupBonusReceived: { 
    type: Boolean, 
    default: false 
  },
  // Game stats
  gamesPlayed: {
    type: Number,
    default: 0
  },
  gamesWon: {
    type: Number,
    default: 0
  },
  gamesLost: {
    type: Number,
    default: 0
  },
  totalProfit: {
    type: Number,
    default: 0
  },
  highestWin: {
    type: Number,
    default: 0
  },
  // Timestamps
  createdAt: { 
    type: Date, 
    default: Date.now 
  },
  lastWagerTime: { 
    type: Date 
  },
  lastLoginTime: {
    type: Date
  }
});

// Password hashing method
UserSchema.methods.setPassword = async function(password) {
  this.passwordHash = await bcrypt.hash(password, 10);
};

// Password validation method
UserSchema.methods.validatePassword = async function(password) {
  return await bcrypt.compare(password, this.passwordHash);
};

// Generate a referral link method
UserSchema.methods.getReferralLink = function() {
  return `${process.env.BASE_URL || 'https://dgenrand0.vercel.app'}/signup?ref=${this.referralCode}`;
};

// Track a new wager
UserSchema.methods.trackWager = async function(amount, gameType) {
  this.totalWagered += amount;
  this.gamesPlayed += 1;
  this.lastWagerTime = new Date();
  
  // If user was referred, update referrer's earnings
  if (this.referredBy) {
    const referralReward = amount * (REFERRAL_REWARD_PERCENT / 100);
    
    // Find and update referrer
    const referrer = await mongoose.model('User').findById(this.referredBy);
    if (referrer) {
      referrer.referralEarnings += referralReward;
      await referrer.save();
    }
  }
  
  return this.save();
};

// Record game outcome
UserSchema.methods.recordGameOutcome = async function(win, profit) {
  if (win) {
    this.gamesWon += 1;
    this.totalProfit += profit;
    
    // Update highest win if this is a new record
    if (profit > this.highestWin) {
      this.highestWin = profit;
    }
  } else {
    this.gamesLost += 1;
    this.totalProfit -= Math.abs(profit);
  }
  
  return this.save();
};

// Set Bitcoin address for user
UserSchema.methods.setBitcoinAddress = function(address) {
  this.cryptoAddresses.bitcoin = address;
  return this.save();
};

// Set Ethereum address for user
UserSchema.methods.setEthereumAddress = function(address) {
  this.cryptoAddresses.ethereum = address;
  return this.save();
};

// Get statistics about referrals
UserSchema.methods.getReferralStats = async function() {
  // Get users referred by this user
  const referredUsers = await mongoose.model('User').find({ referredBy: this._id })
    .select('username totalWagered createdAt -_id');
    
  // Calculate potential earnings from total wagers of referred users
  const totalReferredWagered = referredUsers.reduce((sum, user) => sum + user.totalWagered, 0);
  const potentialEarnings = totalReferredWagered * (REFERRAL_REWARD_PERCENT / 100);
  
  // Calculate pending rewards (not yet added to referralEarnings)
  const pendingRewards = Math.max(0, potentialEarnings - this.referralEarnings);
  
  return {
    referralCode: this.referralCode,
    referralLink: this.getReferralLink(),
    totalReferrals: this.referralCount,
    referralEarnings: this.referralEarnings,
    pendingRewards: pendingRewards,
    referredUsers: referredUsers.map(u => ({
      username: u.username,
      totalWagered: u.totalWagered,
      joinedAt: u.createdAt,
      commission: (u.totalWagered * REFERRAL_REWARD_PERCENT / 100).toFixed(2)
    }))
  };
};

// Apply a referral code
UserSchema.statics.applyReferralCode = async function(userId, referralCode) {
  // Find the user who is being referred
  const user = await this.findById(userId);
  if (!user) throw new Error('User not found');
  
  // Check if user already has a referrer
  if (user.referredBy) throw new Error('User already has a referrer');
  
  // Find the referrer by referral code
  const referrer = await this.findOne({ referralCode });
  if (!referrer) throw new Error('Invalid referral code');
  
  // Make sure user isn't referring themselves
  if (referrer._id.toString() === userId) throw new Error('Cannot refer yourself');
  
  // Update user with referrer
  user.referredBy = referrer._id;
  await user.save();
  
  // Increment referrer's count
  referrer.referralCount += 1;
  await referrer.save();
  
  return { user, referrer };
};

// Indexes for better performance
UserSchema.index({ referralCode: 1 });
UserSchema.index({ referredBy: 1 });
UserSchema.index({ totalWagered: -1 });
UserSchema.index({ referralEarnings: -1 });
UserSchema.index({ referralCount: -1 });
UserSchema.index({ gamesPlayed: -1 });
UserSchema.index({ 'cryptoAddresses.bitcoin': 1 });
UserSchema.index({ 'cryptoAddresses.ethereum': 1 });

module.exports = mongoose.models.User || mongoose.model('User', UserSchema);
