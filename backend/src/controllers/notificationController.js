'use strict';

const { body } = require('express-validator');
const Notification = require('../models/Notification');
const { Token } = require('../models/Token');
const notificationService = require('../services/notificationService');
const asyncHandler = require('../utils/asyncHandler');
const { sendSuccess, sendBadRequest, sendNotFound } = require('../utils/apiResponse');

const broadcastValidation = [
  body('centerId').isMongoId().withMessage('Valid centerId is required'),
  body('title').trim().isString().notEmpty().isLength({ max: 120 }).withMessage('Title is required (max 120 chars)'),
  body('body').trim().isString().notEmpty().isLength({ max: 500 }).withMessage('Body is required (max 500 chars)'),
];

/**
 * GET /api/notifications
 * Get notifications for the authenticated user.
 */
const list = asyncHandler(async (req, res) => {
  const { unreadOnly } = req.query;

  let pageNum = parseInt(req.query.page, 10);
  if (isNaN(pageNum) || pageNum < 1) pageNum = 1;

  let limitNum = parseInt(req.query.limit, 10);
  if (isNaN(limitNum) || limitNum < 1) limitNum = 20;
  if (limitNum > 100) limitNum = 100;

  const filter = { userId: req.user._id };
  if (unreadOnly === 'true') filter.isRead = false;

  const skip = (pageNum - 1) * limitNum;
  const [notifications, total, unreadCount] = await Promise.all([
    Notification.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limitNum)
      .lean(),
    Notification.countDocuments(filter),
    Notification.countDocuments({ userId: req.user._id, isRead: false }),
  ]);

  return sendSuccess(res, {
    data: { notifications, unreadCount },
    meta: {
      total,
      page: pageNum,
      limit: limitNum,
      pages: Math.ceil(total / limitNum) || 1,
    },
  });
});

/**
 * PATCH /api/notifications/:id/read
 * Mark a single notification as read. Returns 404 if notification does not exist or belong to user.
 */
const markRead = asyncHandler(async (req, res) => {
  const notif = await Notification.findOneAndUpdate(
    { _id: req.params.id, userId: req.user._id },
    { isRead: true, readAt: new Date() },
    { new: true }
  );

  if (!notif) {
    return sendNotFound(res, 'Notification not found');
  }

  return sendSuccess(res, { message: 'Notification marked as read' });
});

/**
 * PATCH /api/notifications/read-all
 */
const markAllRead = asyncHandler(async (req, res) => {
  const result = await Notification.updateMany(
    { userId: req.user._id, isRead: false },
    { isRead: true, readAt: new Date() }
  );
  return sendSuccess(res, {
    message: 'All notifications marked as read',
    data: { updated: result.modifiedCount },
  });
});

/**
 * POST /api/notifications/broadcast
 * Admin sends a broadcast to all users with active tokens at a center.
 */
const broadcast = asyncHandler(async (req, res) => {
  const { centerId, title, body } = req.body;

  if (!centerId || !title || !body) {
    return sendBadRequest(res, 'centerId, title, and body are required');
  }

  // Get all users with active tokens at this center
  const activeTokens = await Token.find({
    centerId,
    status: { $in: ['WAITING', 'CALLED', 'SERVING'] },
  }).select('userId');

  const userIds = [...new Set(activeTokens.map((t) => t.userId.toString()))];

  const notifications = await notificationService.sendBroadcastNotification(
    userIds,
    centerId,
    title,
    body
  );

  return sendSuccess(res, {
    message: `Broadcast sent to ${userIds.length} user(s)`,
    data: { sent: userIds.length, notifications: notifications.length },
  });
});

module.exports = { list, markRead, markAllRead, broadcast, broadcastValidation };

