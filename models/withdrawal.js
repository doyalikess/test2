const mongoose = require('mongoose');

const withdrawalSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    username: { type: String, required: true },
    amount: { type: Number, required: true },
    method: { type: String, required: true }, // 'BTC', 'ETH', 'LTC', 'USDT'
    address: { type: String, required: true },
    status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
    adminNotes: { type: String, default: '' },
    processedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    processedAt: { type: Date, default: null },
    transactionHash: { type: String, default: '' },
    createdAt: { type: Date, default: Date.now }
});

const Withdrawal = mongoose.model('Withdrawal', withdrawalSchema);

module.exports = Withdrawal;
