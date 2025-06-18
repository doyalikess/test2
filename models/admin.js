const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const {
  User,
  Wager,
  Deposit,
  Withdrawal,
  AdminLog,
  ReportedContent
} = require('../models'); // Adjust path as needed

const JWT_SECRET = process.env.JWT_SECRET;
const { sendAdminNotification } = require('../utils/notifications');

// ======================
//  ENHANCED ADMIN MIDDLEWARE
// ======================
async function adminAuth(req, res, next) {
  const token = req.cookies.admin_token || req.headers['x-admin-token'];
  
  if (!token) {
    return res.status(401).json({ 
      error: 'Access denied',
      code: 'ADMIN_AUTH_REQUIRED'
    });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const admin = await User.findOne({
      _id: decoded.userId,
      'roles': 'admin',
      'isActive': true
    }).select('+adminPermissions');

    if (!admin) {
      return res.status(403).json({
        error: 'Admin privileges revoked',
        code: 'ADMIN_DEACTIVATED'
      });
    }

    req.admin = {
      ...decoded,
      permissions: admin.adminPermissions
    };

    // Log admin access
    await AdminLog.create({
      adminId: admin._id,
      action: 'ACCESS_ROUTE',
      endpoint: req.originalUrl,
      ip: req.ip
    });

    next();
  } catch (err) {
    return res.status(401).json({
      error: 'Invalid token',
      code: 'INVALID_ADMIN_TOKEN'
    });
  }
}

function checkPermission(permission) {
  return (req, res, next) => {
    if (!req.admin.permissions.includes(permission)) {
      return res.status(403).json({
        error: `Missing ${permission} permission`,
        code: 'PERMISSION_DENIED'
      });
    }
    next();
  };
}

// ======================
//  ADMIN ROUTES
// ======================

// 1. USER MANAGEMENT
router.get('/users', adminAuth, checkPermission('VIEW_USERS'), async (req, res) => {
  try {
    const { page = 1, limit = 50, search = '' } = req.query;
    
    const query = {
      $or: [
        { username: new RegExp(search, 'i') },
        { email: new RegExp(search, 'i') },
        { _id: mongoose.Types.ObjectId.isValid(search) ? search : null }
      ].filter(Boolean)
    };

    const users = await User.find(query)
      .select('-password -twoFactorSecret')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(Number(limit));

    const count = await User.countDocuments(query);

    res.json({
      data: users,
      pagination: {
        total: count,
        page: Number(page),
        pages: Math.ceil(count / limit)
      }
    });
  } catch (err) {
    console.error('Admin user fetch error:', err);
    res.status(500).json({
      error: 'Failed to fetch users',
      code: 'SERVER_ERROR'
    });
  }
});

router.put('/users/:id/status', adminAuth, checkPermission('MODIFY_USERS'), async (req, res) => {
  try {
    const { action, reason } = req.body;
    const validActions = ['ban', 'unban', 'mute', 'verify'];

    if (!validActions.includes(action)) {
      return res.status(400).json({
        error: 'Invalid action',
        code: 'INVALID_USER_ACTION'
      });
    }

    const user = await User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({
        error: 'User not found',
        code: 'USER_NOT_FOUND'
      });
    }

    // Apply action
    switch (action) {
      case 'ban':
        user.isBanned = true;
        user.banReason = reason;
        break;
      case 'unban':
        user.isBanned = false;
        user.banReason = undefined;
        break;
      case 'mute':
        user.canChat = false;
        break;
      case 'verify':
        user.isVerified = true;
        break;
    }

    await user.save();

    // Log admin action
    await AdminLog.create({
      adminId: req.admin.userId,
      userId: user._id,
      action: `USER_${action.toUpperCase()}`,
      details: reason,
      ip: req.ip
    });

    // Notify user if banned/muted
    if (['ban', 'mute'].includes(action)) {
      await sendAdminNotification(user._id, {
        type: action,
        reason,
        admin: req.admin.username
      });
    }

    res.json({
      success: true,
      message: `User ${action} successful`
    });
  } catch (err) {
    console.error('Admin user update error:', err);
    res.status(500).json({
      error: 'Failed to update user',
      code: 'SERVER_ERROR'
    });
  }
});

// 2. FINANCIAL CONTROLS
router.get('/transactions', adminAuth, checkPermission('VIEW_TRANSACTIONS'), async (req, res) => {
  try {
    const { type, status, userId, page = 1 } = req.query;
    const limit = 100;
    
    let Model;
    switch (type) {
      case 'deposit': Model = Deposit; break;
      case 'withdrawal': Model = Withdrawal; break;
      case 'wager': Model = Wager; break;
      default: Model = null;
    }

    if (!Model) {
      return res.status(400).json({
        error: 'Invalid transaction type',
        code: 'INVALID_TRANSACTION_TYPE'
      });
    }

    const query = {};
    if (status) query.status = status;
    if (userId) query.userId = userId;

    const transactions = await Model.find(query)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .populate('userId', 'username');

    res.json(transactions);
  } catch (err) {
    console.error('Admin transactions error:', err);
    res.status(500).json({
      error: 'Failed to fetch transactions',
      code: 'SERVER_ERROR'
    });
  }
});

router.post('/transactions/:id/process', adminAuth, checkPermission('PROCESS_TRANSACTIONS'), async (req, res) => {
  try {
    const { action, adminNote } = req.body;
    const transaction = await Deposit.findById(req.params.id);

    if (!transaction) {
      return res.status(404).json({
        error: 'Transaction not found',
        code: 'TRANSACTION_NOT_FOUND'
      });
    }

    // Process transaction based on type
    switch (action) {
      case 'approve':
        transaction.status = 'completed';
        // Credit user balance
        await User.findByIdAndUpdate(transaction.userId, {
          $inc: { balance: transaction.amount }
        });
        break;
      
      case 'reject':
        transaction.status = 'rejected';
        break;
      
      default:
        return res.status(400).json({
          error: 'Invalid action',
          code: 'INVALID_TRANSACTION_ACTION'
        });
    }

    transaction.adminNote = adminNote;
    transaction.processedBy = req.admin.userId;
    await transaction.save();

    // Log admin action
    await AdminLog.create({
      adminId: req.admin.userId,
      action: `TRANSACTION_${action.toUpperCase()}`,
      targetId: transaction._id,
      details: adminNote,
      ip: req.ip
    });

    res.json({
      success: true,
      message: `Transaction ${action}d`
    });
  } catch (err) {
    console.error('Admin transaction processing error:', err);
    res.status(500).json({
      error: 'Failed to process transaction',
      code: 'SERVER_ERROR'
    });
  }
});

// 3. CONTENT MODERATION
router.get('/reported-content', adminAuth, checkPermission('MODERATE_CONTENT'), async (req, res) => {
  try {
    const reports = await ReportedContent.find({ status: 'pending' })
      .populate('reporterId', 'username')
      .populate('contentOwner', 'username')
      .sort({ createdAt: -1 });

    res.json(reports);
  } catch (err) {
    console.error('Admin reports error:', err);
    res.status(500).json({
      error: 'Failed to fetch reports',
      code: 'SERVER_ERROR'
    });
  }
});

router.post('/reported-content/:id/resolve', adminAuth, checkPermission('MODERATE_CONTENT'), async (req, res) => {
  try {
    const { action, penalty } = req.body;
    const report = await ReportedContent.findById(req.params.id);

    if (!report) {
      return res.status(404).json({
        error: 'Report not found',
        code: 'REPORT_NOT_FOUND'
      });
    }

    // Process report
    report.status = 'resolved';
    report.actionTaken = action;
    report.resolvedBy = req.admin.userId;
    await report.save();

    // Apply penalties if needed
    if (penalty) {
      await User.findByIdAndUpdate(report.contentOwner, {
        $inc: { reputation: -penalty }
      });
    }

    // Log admin action
    await AdminLog.create({
      adminId: req.admin.userId,
      action: 'REPORT_RESOLVED',
      targetId: report._id,
      details: action,
      ip: req.ip
    });

    res.json({
      success: true,
      message: 'Report resolved'
    });
  } catch (err) {
    console.error('Admin report resolution error:', err);
    res.status(500).json({
      error: 'Failed to resolve report',
      code: 'SERVER_ERROR'
    });
  }
});

// 4. SYSTEM MANAGEMENT
router.get('/system/stats', adminAuth, checkPermission('VIEW_STATS'), async (req, res) => {
  try {
    const [
      userStats,
      financialStats,
      moderationStats
    ] = await Promise.all([
      // User analytics
      User.aggregate([
        {
          $facet: {
            total: [{ $count: 'count' }],
            active: [{ $match: { lastLogin: { $gt: new Date(Date.now() - 7*24*60*60*1000) } } }, { $count: 'count' }],
            banned: [{ $match: { isBanned: true } }, { $count: 'count' }],
            byTier: [{ $group: { _id: '$tier', count: { $sum: 1 } } }]
          }
        },
        { $project: {
          total: { $arrayElemAt: ['$total.count', 0] },
          active: { $arrayElemAt: ['$active.count', 0] },
          banned: { $arrayElemAt: ['$banned.count', 0] },
          byTier: 1
        }}
      ]),

      // Financial analytics
      Promise.all([
        Deposit.aggregate([
          { $match: { status: 'completed' } },
          { $group: { _id: null, total: { $sum: '$amount' } } }
        ]),
        Withdrawal.aggregate([
          { $match: { status: 'completed' } },
          { $group: { _id: null, total: { $sum: '$amount' } } }
        ]),
        Wager.aggregate([
          { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }
        ])
      ]),

      // Moderation analytics
      AdminLog.aggregate([
        { $match: { createdAt: { $gt: new Date(Date.now() - 30*24*60*60*1000) } } },
        { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, count: { $sum: 1 } } },
        { $sort: { _id: 1 } }
      ])
    ]);

    res.json({
      users: userStats[0],
      finances: {
        deposits: financialStats[0][0]?.total || 0,
        withdrawals: financialStats[1][0]?.total || 0,
        wagered: financialStats[2][0]?.total || 0,
        wagerCount: financialStats[2][0]?.count || 0
      },
      moderation: moderationStats
    });
  } catch (err) {
    console.error('Admin stats error:', err);
    res.status(500).json({
      error: 'Failed to load system stats',
      code: 'SERVER_ERROR'
    });
  }
});

module.exports = router;
