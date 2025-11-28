const mongoose = require('mongoose');

const tipSchema = new mongoose.Schema({
  fromUser: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  toUser: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  amount: {
    type: Number,
    required: true,
    min: 0
  },
  unwageredAmount: {
    type: Number,
    default: function() {
      return this.amount;
    }
  },
  wageringProgress: {
    totalWageredSinceTip: {
      type: Number,
      default: 0
    }
  },
  message: {
    type: String,
    default: ''
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

// Index for faster queries
tipSchema.index({ fromUser: 1, createdAt: -1 });
tipSchema.index({ toUser: 1, createdAt: -1 });
tipSchema.index({ createdAt: -1 });

// Virtual for remaining wagering requirement
tipSchema.virtual('remainingWagering').get(function() {
  return Math.max(0, this.unwageredAmount - this.wageringProgress.totalWageredSinceTip);
});

tipSchema.set('toJSON', { virtuals: true });
tipSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('Tip', tipSchema);
