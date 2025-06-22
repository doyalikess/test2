const mongoose = require('mongoose');

const promocodeSchema = new mongoose.Schema({
    code: { type: String, required: true, unique: true },
    type: { type: String, enum: ['balance', 'percentage', 'free_spins'], required: true },
    value: { type: Number, required: true },
    maxUses: { type: Number, default: -1 }, // -1 for unlimited
    usedCount: { type: Number, default: 0 },
    active: { type: Boolean, default: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    usedBy: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    expiresAt: { type: Date, default: null },
    createdAt: { type: Date, default: Date.now }
});

const Promocode = mongoose.model('Promocode', promocodeSchema);

module.exports = Promocode;
