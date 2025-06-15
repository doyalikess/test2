const mongoose = require('mongoose');

const referralRewardSchema = new mongoose.Schema({
  referralOwner: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  referredUser: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  amount: {
    type: Number,
    required: true,
    min: 0
  },
  wagerAmount: {
    type: Number,
    required: true,
    min: 0
  },
  gameType: {
    type: String,
    required: true
  },
  processed: {
    type: Boolean,
    default: false
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  processedAt: {
    type: Date
  }
}, {
  timestamps: true
});

// Index for efficient queries
referralRewardSchema.index({ referralOwner: 1, processed: 1 });
referralRewardSchema.index({ referredUser: 1 });
referralRewardSchema.index({ createdAt: -1 });

module.exports = mongoose.model('ReferralReward', referralRewardSchema);
