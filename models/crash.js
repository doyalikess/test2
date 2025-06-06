const mongoose = require('mongoose');

const minesGameSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  betAmount: { type: Number, required: true },
  minesCount: { type: Number, required: true },
  gridSize: { type: Number, default: 5 }, // 5x5 grid
  minesPositions: { type: [Number], required: true },
  revealedPositions: { type: [Number], default: [] },
  cashoutMultiplier: { type: Number, default: 1 },
  status: { type: String, enum: ['ongoing', 'cashed_out', 'busted'], default: 'ongoing' },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('MinesGame', minesGameSchema);
