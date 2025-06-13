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
  
  // Free coins tracking (NEW)
  freeCoinsClaimedAt: {
    type: Date,
    default: null
  },
  freeCoinsHistory: [{
    amount: Number,
    casesAwarded: Number,
    claimedAt: Date,
    ipAddress: String
  }],
  
  // Case system (NEW)
  caseInventory: {
    type: Map,
    of: Number,
    default: new Map()
  },
  caseHistory: [{
    caseType: String,
    caseName: String,
    item: {
      name: String,
      type: String,
      value: Number,
      rarity: String,
      color: String
    },
    openedAt: Date,
    balanceBefore: Number,
    balanceAfter: Number
  }],
  
  // Level system enhancements (NEW)
  level: {
    current: { type: Number, default: 1 },
    name: String,
    color: String,
    progress: { type: Number, default: 0 },
    nextLevel: Number,
    nextLevelName: String,
    requiredWageringForNextLevel: Number,
    totalWagered: { type: Number, default: 0 }
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
  
  // Update level progress (NEW)
  if (!this.level) {
    this.level = {
      current: 1,
      totalWagered: 0
    };
  }
  this.level.totalWagered += amount;
  
  // If user was referred, update referrer's earnings
  if (this.referredBy) {
    const referralReward = amount * (REFERRAL_REWARD_PERCENT / 100);
    
    // Find and update referrer
    const referrer = await mongoose.model('User').findById(this.referredBy);
    if (referrer) {
      referrer.referralEarnings += referralReward;
      referrer.balance += referralReward; // Add commission to referrer's balance
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

// Check if user can claim free coins (NEW)
UserSchema.methods.canClaimFreeCoins = function() {
  return !this.freeCoinsClaimedAt;
};

// Claim free coins - one-time only (NEW)
UserSchema.methods.claimFreeCoins = async function(ipAddress = null) {
  if (this.freeCoinsClaimedAt) {
    throw new Error('Free coins already claimed');
  }
  
  const freeAmount = 3;
  const casesAwarded = 3;
  
  this.balance += freeAmount;
  this.freeCoinsClaimedAt = new Date();
  
  // Initialize free coins history if needed
  if (!this.freeCoinsHistory) {
    this.freeCoinsHistory = [];
  }
  
  this.freeCoinsHistory.push({
    amount: freeAmount,
    casesAwarded,
    claimedAt: new Date(),
    ipAddress: ipAddress
  });
  
  // Award cases to inventory
  if (!this.caseInventory) {
    this.caseInventory = new Map();
  }
  
  const currentCases = this.caseInventory.get('level_1') || 0;
  this.caseInventory.set('level_1', currentCases + casesAwarded);
  
  await this.save();
  
  return {
    amount: freeAmount,
    casesAwarded,
    newBalance: this.balance
  };
};

// Award cases based on level (NEW)
UserSchema.methods.awardLevelUpCases = async function(newLevel) {
  const getCaseTypeForLevel = (level) => {
    if (level >= 20) return 'level_3';
    if (level >= 10) return 'level_2';
    return 'level_1';
  };
  
  const CASE_NAMES = {
    'level_1': 'Bronze Case',
    'level_2': 'Silver Case', 
    'level_3': 'Gold Case'
  };
  
  const caseType = getCaseTypeForLevel(newLevel);
  
  // Calculate cases to award based on level
  let casesToAward = 1;
  if (newLevel >= 20) {
    casesToAward = Math.floor(newLevel / 10);
  } else if (newLevel >= 10) {
    casesToAward = 2;
  }
  
  // Initialize case inventory if needed
  if (!this.caseInventory) {
    this.caseInventory = new Map();
  }
  
  const currentCases = this.caseInventory.get(caseType) || 0;
  this.caseInventory.set(caseType, currentCases + casesToAward);
  
  await this.save();
  
  return {
    casesToAward,
    caseType,
    caseName: CASE_NAMES[caseType],
    newLevel
  };
};

// Open a case and get random item (NEW)
UserSchema.methods.openCase = async function(caseType) {
  // Check if user has this case type in inventory
  if (!this.caseInventory) {
    this.caseInventory = new Map();
  }

  const userCaseCount = this.caseInventory.get(caseType) || 0;
  if (userCaseCount <= 0) {
    throw new Error('No cases of this type available');
  }

  // Case types and their items
  const CASE_TYPES = {
    level_1: {
      name: 'Bronze Case',
      items: [
        { name: 'Common Coin Bonus', type: 'balance', value: 1, rarity: 'common', weight: 40 },
        { name: 'Small Coin Bonus', type: 'balance', value: 2, rarity: 'common', weight: 30 },
        { name: 'Medium Coin Bonus', type: 'balance', value: 5, rarity: 'uncommon', weight: 20 },
        { name: 'Large Coin Bonus', type: 'balance', value: 10, rarity: 'rare', weight: 8 },
        { name: 'Mega Coin Bonus', type: 'balance', value: 25, rarity: 'epic', weight: 2 }
      ]
    },
    level_2: {
      name: 'Silver Case',
      items: [
        { name: 'Small Coin Bonus', type: 'balance', value: 2, rarity: 'common', weight: 35 },
        { name: 'Medium Coin Bonus', type: 'balance', value: 5, rarity: 'common', weight: 30 },
        { name: 'Large Coin Bonus', type: 'balance', value: 10, rarity: 'uncommon', weight: 20 },
        { name: 'Mega Coin Bonus', type: 'balance', value: 25, rarity: 'rare', weight: 12 },
        { name: 'Super Coin Bonus', type: 'balance', value: 50, rarity: 'epic', weight: 3 }
      ]
    },
    level_3: {
      name: 'Gold Case',
      items: [
        { name: 'Medium Coin Bonus', type: 'balance', value: 5, rarity: 'common', weight: 30 },
        { name: 'Large Coin Bonus', type: 'balance', value: 10, rarity: 'common', weight: 25 },
        { name: 'Mega Coin Bonus', type: 'balance', value: 25, rarity: 'uncommon', weight: 25 },
        { name: 'Super Coin Bonus', type: 'balance', value: 50, rarity: 'rare', weight: 15 },
        { name: 'Ultra Coin Bonus', type: 'balance', value: 100, rarity: 'epic', weight: 4 },
        { name: 'Legendary Jackpot', type: 'balance', value: 500, rarity: 'legendary', weight: 1 }
      ]
    }
  };

  const RARITY_COLORS = {
    common: '#9ca3af',
    uncommon: '#22c55e',
    rare: '#3b82f6',
    epic: '#a855f7',
    legendary: '#f59e0b'
  };

  const caseData = CASE_TYPES[caseType];
  if (!caseData) {
    throw new Error('Invalid case type');
  }

  // Calculate total weight
  const totalWeight = caseData.items.reduce((sum, item) => sum + item.weight, 0);
  
  // Generate random number
  let random = Math.random() * totalWeight;
  
  // Select item based on weight
  let wonItem = null;
  for (const item of caseData.items) {
    if (random < item.weight) {
      wonItem = {
        ...item,
        color: RARITY_COLORS[item.rarity],
        caseName: caseData.name
      };
      break;
    }
    random -= item.weight;
  }
  
  // Fallback to last item if something goes wrong
  if (!wonItem) {
    const fallback = caseData.items[caseData.items.length - 1];
    wonItem = {
      ...fallback,
      color: RARITY_COLORS[fallback.rarity],
      caseName: caseData.name
    };
  }

  // Update user inventory
  this.caseInventory.set(caseType, userCaseCount - 1);

  // Apply the reward
  const balanceBefore = this.balance;
  if (wonItem.type === 'balance') {
    this.balance += wonItem.value;
  }

  // Record the case opening
  if (!this.caseHistory) {
    this.caseHistory = [];
  }

  const caseRecord = {
    caseType,
    caseName: wonItem.caseName,
    item: wonItem,
    openedAt: new Date(),
    balanceBefore: balanceBefore,
    balanceAfter: this.balance
  };

  this.caseHistory.unshift(caseRecord);

  // Keep only last 100 case openings
  if (this.caseHistory.length > 100) {
    this.caseHistory = this.caseHistory.slice(0, 100);
  }

  await this.save();

  return {
    item: wonItem,
    newBalance: this.balance,
    remainingCases: this.caseInventory.get(caseType),
    caseRecord
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
UserSchema.index({ freeCoinsClaimedAt: 1 });
UserSchema.index({ 'level.current': -1 });

module.exports = mongoose.models.User || mongoose.model('User', UserSchema);
