const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const crypto = require('crypto');

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
    ref: 'User' 
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
  signupBonusReceived: { 
    type: Boolean, 
    default: false 
  },
  // Timestamps
  createdAt: { 
    type: Date, 
    default: Date.now 
  },
  lastWagerTime: { 
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
  return `${process.env.BASE_URL}/signup?ref=${this.referralCode}`;
};

// Virtual for referral count (not stored in DB)
UserSchema.virtual('referralCount').get(async function() {
  return await mongoose.model('User').countDocuments({ referredBy: this._id });
});

// Indexes for better performance
UserSchema.index({ referralCode: 1 });
UserSchema.index({ referredBy: 1 });
UserSchema.index({ totalWagered: -1 });
UserSchema.index({ referralEarnings: -1 });

module.exports = mongoose.models.User || mongoose.model('User', UserSchema);
