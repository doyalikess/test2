const mongoose = require('mongoose');

const chatBanSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  adminId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  type: {
    type: String,
    enum: ['mute', 'ban'],
    required: true
  },
  reason: String,
  duration: Number, // in minutes
  expiresAt: Date,
  createdAt: {
    type: Date,
    default: Date.now
  }
});

module.exports = mongoose.model('ChatBan', chatBanSchema);
