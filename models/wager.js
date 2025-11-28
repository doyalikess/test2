const mongoose = require('mongoose');

// Define wager schema
const wagerSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  gameType: {
    type: String,
    enum: [
      'coinflip', 'jackpot', 'mines', 'limbo', 'upgrader', 'manual', 'deposit', 'withdrawal',
      'free_coins', 'case_opening', 'bonus', 'tip', 'referral_bonus', 'admin_tip'
    ],
    required: true
  },
  amount: {
    type: Number,
    required: true,
    min: 0
  },
  outcome: {
    type: String,
    enum: ['win', 'loss', 'pending'],
    default: 'pending'
  },
  profit: {
    type: Number,
    default: 0
  },
  multiplier: {
    type: Number,
    default: 1
  },
  
  // PROVABLY FAIR FIELDS - ADD THESE
  serverSeed: {
    type: String,
    default: null
  },
  clientSeed: {
    type: String,
    default: null
  },
  nonce: {
    type: Number,
    default: 0
  },
  resultHash: {
    type: String,
    default: null
  },
  
  gameData: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  meta: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  completedAt: {
    type: Date
  }
});

// Create indexes for better query performance
wagerSchema.index({ userId: 1, createdAt: -1 });
wagerSchema.index({ gameType: 1 });
wagerSchema.index({ outcome: 1 });
wagerSchema.index({ createdAt: -1 });

// Create and export Wager model
module.exports = mongoose.models.Wager || mongoose.model('Wager', wagerSchema);
