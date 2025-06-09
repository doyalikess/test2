const mongoose = require('mongoose');
const bcrypt = require('bcrypt');

const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  passwordHash: { type: String, required: true },
  balance: { type: Number, default: 0 },
  referralCode: { type: String, unique: true },
  referredBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  totalWagered: { type: Number, default: 0 },
  referralEarnings: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now }
});

userSchema.methods.setPassword = async function(password) {
  this.passwordHash = await bcrypt.hash(password, 10);
};

userSchema.methods.validatePassword = async function(password) {
  return await bcrypt.compare(password, this.passwordHash);
};

userSchema.pre('save', function(next) {
  if (!this.referralCode) {
    this.referralCode = generateReferralCode(this.username);
  }
  next();
});

function generateReferralCode(username) {
  const hash = crypto.createHash('sha256').update(username + Date.now()).digest('hex');
  return hash.substring(0, 8).toUpperCase();
}

module.exports = mongoose.model('User', userSchema);
