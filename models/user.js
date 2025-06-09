// This is an example of what your models/user.js file should look like
// with the referral and wagering tracking fields added.

const mongoose = require('mongoose');
const bcrypt = require('bcrypt');

const userSchema = new mongoose.Schema({
  username: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    minlength: 3,
    maxlength: 30
  },
  passwordHash: {
    type: String,
    required: true
  },
  balance: {
    type: Number,
    default: 0
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  lastLogin: {
    type: Date,
    default: Date.now
  },
  // New fields for referral system
  referralCode: {
    type: String,
    unique: true,
    sparse: true
  },
  referredBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  referralCount: {
    type: Number,
    default: 0
  },
  referralEarnings: {
    type: Number,
    default: 0
  },
  // Track total wagered amount
  totalWagered: {
    type: Number,
    default: 0
  }
});

// Method to set password
userSchema.methods.setPassword = async function(password) {
  this.passwordHash = await bcrypt.hash(password, 10);
};

// Method to validate password
userSchema.methods.validatePassword = async function(password) {
  return await bcrypt.compare(password, this.passwordHash);
};

// Generate unique referral code for user
userSchema.methods.generateReferralCode = function() {
  // Generate a code based on username and a random string
  const randomStr = Math.random().toString(36).substring(2, 8).toUpperCase();
  this.referralCode = `${this.username.substring(0, 3).toUpperCase()}${randomStr}`;
  return this.save();
};

const User = mongoose.model('User', userSchema);

module.exports = User;
