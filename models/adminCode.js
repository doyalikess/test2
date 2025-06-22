const mongoose = require('mongoose');

const adminCodeSchema = new mongoose.Schema({
    code: { type: String, required: true, unique: true },
    description: { type: String, default: '' },
    isUsed: { type: Boolean, default: false },
    usedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    usedAt: { type: Date, default: null },
    createdAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, default: null }
});

const AdminCode = mongoose.model('AdminCode', adminCodeSchema);

module.exports = AdminCode;
