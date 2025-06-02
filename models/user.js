const mongoose = require('mongoose');
const bcrypt = require('bcrypt');

const UserSchema = new mongoose.Schema({
  username: { type: String, unique: true, required: true },
  passwordHash: { type: String, required: true },
  balance: { type: Number, default: 0 },
});

// Method to set the user's password
UserSchema.methods.setPassword = async function (password) {
  this.passwordHash = await bcrypt.hash(password, 10);
};

// Method to validate password
UserSchema.methods.validatePassword = async function (password) {
  return await bcrypt.compare(password, this.passwordHash);
};

module.exports = mongoose.model('User', UserSchema);
