const mongoose = require('mongoose');

const adminLogSchema = new mongoose.Schema({
    action: { type: String, required: true },
    admin: { type: String, required: true },
    target: { type: String, default: '' },
    details: { type: String, default: '' },
    metadata: { type: Object, default: {} },
    timestamp: { type: Date, default: Date.now }
});

const AdminLog = mongoose.model('AdminLog', adminLogSchema);

module.exports = AdminLog;
