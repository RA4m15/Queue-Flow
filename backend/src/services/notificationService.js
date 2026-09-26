'use strict';

const Notification = require('../models/Notification');
const User = require('../models/User');
const { emitToUser } = require('../config/socket');
const { logger } = require('../utils/logger');
function getChannelManager() {
  try {
    return require('../channels/channelManager').channelManager;
  } catch (_) {
    return null;
  }
}

/**
 * Send a notification for a token lifecycle event.
 * Stores in MongoDB with database-backed deduplication and delivers
 * across eligible channels based on user preferences and token source.
 *
 * NOTE: FCM server-side delivery not currently implemented.
 * The current application continues using MongoDB + Socket.IO for notification delivery.
 *
 * @param {object} token - Populated or raw Token document
 * @param {string} type  - Notification type (TOKEN_CREATED, TOKEN_APPROACHING, TOKEN_CALLED, NO_SHOW_WARNING, etc.)
 * @param {object} content
 * @param {string} content.title
 * @param {string} content.body
 * @param {string} [content.dedupeKey] - Stable idempotency key
 * @param {string} [content.channel]   - Target primary channel ('IN_APP', 'SMS', 'WHATSAPP', 'TELEGRAM')
 * @param {object} [content.metadata]  - Additional contextual payload
 * @returns {Promise<Notification|null>}
 */
async function sendTokenNotification(token, type, { title, body, dedupeKey = null, channel = 'IN_APP', metadata = {} }) {
  if (!token || !token.userId) {
    return null;
  }

  const userIdStr = token.userId._id ? token.userId._id.toString() : token.userId.toString();
  const tokenIdStr = token._id ? token._id.toString() : null;
  const centerIdStr = token.centerId ? (token.centerId._id ? token.centerId._id.toString() : token.centerId.toString()) : null;

  try {
    // 1. Database-backed deduplication check
    if (dedupeKey) {
      const existing = await Notification.findOne({ dedupeKey });
      if (existing) {
        logger.info('notification.deduplicated', {
          dedupeKey,
          type,
          userId: userIdStr,
          tokenId: tokenIdStr,
        });
        return existing;
      }
    }

    // 2. Fetch user preferences and contact info
    let user = null;
    try {
      user = await User.findById(userIdStr).select('preferences phone fcmToken email role isActive');
    } catch (_) {}

    // Check channel eligibility based on preferences
    const notifyApp = token.notifyApp !== false && (user?.preferences?.notifyApp !== false);
    const notifySms = (token.notifySms === true) || (user?.preferences?.notifySms === true);

    // 3. Create canonical notification record in MongoDB
    let notification;
    try {
      notification = await Notification.create({
        userId: userIdStr,
        centerId: centerIdStr,
        tokenId: tokenIdStr,
        type,
        title,
        body,
        dedupeKey: dedupeKey || undefined,
        channel,
        deliveredViaSocket: false,
        deliveredViaFcm: false,
        deliveredViaSms: false,
        deliveredViaWhatsApp: false,
        deliveredViaTelegram: false,
        metadata,
      });
    } catch (createErr) {
      // Handle E11000 duplicate key race condition safely
      if (createErr.code === 11000 && dedupeKey) {
        logger.info('notification.deduplicated', {
          dedupeKey,
          type,
          userId: userIdStr,
          tokenId: tokenIdStr,
        });
        return await Notification.findOne({ dedupeKey });
      }
      throw createErr;
    }

    logger.info('notification.created', {
      notificationId: notification._id.toString(),
      type,
      userId: userIdStr,
      tokenId: tokenIdStr,
      dedupeKey,
    });

    let deliveredAny = false;

    // 4. Socket.IO Delivery (Authenticated Private Room)
    if (notifyApp) {
      try {
        emitToUser(userIdStr, 'notification.created', {
          notification: {
            _id: notification._id,
            type,
            title,
            body,
            tokenId: tokenIdStr,
            centerId: centerIdStr,
            isRead: false,
            createdAt: notification.createdAt,
            metadata,
          },
        });
        notification.deliveredViaSocket = true;
        deliveredAny = true;
        logger.info('notification.delivery.success', {
          notificationId: notification._id.toString(),
          channel: 'SOCKET',
          userId: userIdStr,
        });
      } catch (sockErr) {
        logger.warn('notification.delivery.failure', {
          notificationId: notification._id.toString(),
          channel: 'SOCKET',
          error: sockErr.message,
        });
      }
    }

    // 5. SMS Outbound Delivery
    const chManager = getChannelManager();
    if (notifySms && user?.phone && chManager) {
      try {
        const smsAdapter = chManager.getAdapter('SMS');
        if (smsAdapter && smsAdapter.isConfigured()) {
          await smsAdapter.sendOutgoingMessage(user.phone, `${title}: ${body}`);
          notification.deliveredViaSms = true;
          deliveredAny = true;
          logger.info('notification.delivery.success', {
            notificationId: notification._id.toString(),
            channel: 'SMS',
          });
        } else {
          logger.info('notification.delivery.skipped', {
            channel: 'SMS',
            reason: 'PROVIDER_NOT_CONFIGURED',
          });
        }
      } catch (smsErr) {
        logger.warn('notification.delivery.failure', {
          notificationId: notification._id.toString(),
          channel: 'SMS',
          error: smsErr.message,
        });
      }
    }

    // 6. WhatsApp Outbound Delivery (if token originated from WhatsApp)
    if (token.channel === 'WHATSAPP' && token.channelMetadata?.senderId && chManager) {
      try {
        const waAdapter = chManager.getAdapter('WHATSAPP');
        if (waAdapter && waAdapter.isConfigured()) {
          await waAdapter.sendOutgoingMessage(token.channelMetadata.senderId, `*${title}*\n${body}`);
          notification.deliveredViaWhatsApp = true;
          deliveredAny = true;
          logger.info('notification.delivery.success', {
            notificationId: notification._id.toString(),
            channel: 'WHATSAPP',
          });
        } else {
          logger.info('notification.delivery.skipped', {
            channel: 'WHATSAPP',
            reason: 'PROVIDER_NOT_CONFIGURED',
          });
        }
      } catch (waErr) {
        logger.warn('notification.delivery.failure', {
          notificationId: notification._id.toString(),
          channel: 'WHATSAPP',
          error: waErr.message,
        });
      }
    }

    // 7. Telegram Outbound Delivery (if token originated from Telegram)
    if (token.channel === 'TELEGRAM' && token.channelMetadata?.senderId && chManager) {
      try {
        const tgAdapter = chManager.getAdapter('TELEGRAM');
        if (tgAdapter && tgAdapter.isConfigured()) {
          await tgAdapter.sendOutgoingMessage(token.channelMetadata.senderId, `*${title}*\n${body}`);
          notification.deliveredViaTelegram = true;
          deliveredAny = true;
          logger.info('notification.delivery.success', {
            notificationId: notification._id.toString(),
            channel: 'TELEGRAM',
          });
        } else {
          logger.info('notification.delivery.skipped', {
            channel: 'TELEGRAM',
            reason: 'PROVIDER_NOT_CONFIGURED',
          });
        }
      } catch (tgErr) {
        logger.warn('notification.delivery.failure', {
          notificationId: notification._id.toString(),
          channel: 'TELEGRAM',
          error: tgErr.message,
        });
      }
    }

    // 8. FCM Push Notification (if configured and token exists)
    if (user?.fcmToken && process.env.FCM_SERVER_KEY) {
      logger.info('notification.delivery.skipped', {
        channel: 'FCM',
        reason: 'FCM_SERVER_NOT_CONFIGURED',
      });
    }

    if (deliveredAny) {
      notification.deliveredAt = new Date();
      await notification.save();
    }

    return notification;
  } catch (err) {
    // Notification failure must never break core queue or token operations
    logger.error('[Notification] sendTokenNotification failed', {
      error: err.message,
      type,
      tokenId: tokenIdStr,
    });
    return null;
  }
}

/**
 * Evaluates queue position alerts for a waiting token.
 * Triggers:
 *  - Next In Line (peopleAhead === 0)
 *  - 5 Tokens Away (peopleAhead <= 5 and peopleAhead > 0)
 *
 * @param {object} params
 * @param {object} params.token
 * @param {number} params.position
 * @param {number} params.peopleAhead
 * @param {string} [params.serviceName]
 * @param {string} [params.centerName]
 */
async function evaluateQueuePositionAlerts({ token, position, peopleAhead, serviceName, centerName }) {
  if (!token || !token._id || token.status !== 'WAITING') {
    return null;
  }

  const tokenId = token._id.toString();

  // Rule 1: Next In Line (peopleAhead === 0 / position === 1)
  if (peopleAhead === 0 || position === 1) {
    const dedupeKey = `${tokenId}_NEXT_IN_LINE`;
    return await sendTokenNotification(token, 'TOKEN_APPROACHING', {
      title: "You're Next!",
      body: `You are next in line for token ${token.tokenCode}. Please be ready near the service counters.`,
      dedupeKey,
      metadata: { position: 1, peopleAhead: 0, isNext: true, serviceName, centerName },
    });
  }

  // Rule 2: 5 Tokens Away (peopleAhead <= 5)
  if (peopleAhead <= 5 && peopleAhead > 0) {
    const dedupeKey = `${tokenId}_5_TOKENS_AWAY`;
    return await sendTokenNotification(token, 'TOKEN_APPROACHING', {
      title: '5 Tokens Away',
      body: `You are 5 tokens away from being served. (Token ${token.tokenCode})`,
      dedupeKey,
      metadata: { position, peopleAhead, threshold: 5, serviceName, centerName },
    });
  }

  return null;
}

/**
 * Evaluates token called alert when a counter calls the token.
 *
 * @param {object} params
 * @param {object} params.token
 * @param {object} params.counter
 * @param {string} [params.serviceName]
 * @param {string} [params.centerName]
 */
async function evaluateTokenCalledAlert({ token, counter, serviceName, centerName }) {
  if (!token || !token._id) return null;

  const tokenId = token._id.toString();
  const counterLabel = counter?.displayLabel || counter?.name || (counter?.number ? `Counter ${counter.number}` : 'the service counter');
  const calledTimestamp = token.calledAt ? new Date(token.calledAt).getTime() : 'call';
  const dedupeKey = `${tokenId}_TOKEN_CALLED_${calledTimestamp}`;

  return await sendTokenNotification(token, 'TOKEN_CALLED', {
    title: 'Your Turn!',
    body: `Token ${token.tokenCode} — Please proceed to ${counterLabel}.`,
    dedupeKey,
    metadata: {
      counterId: counter?._id,
      counterName: counter?.name,
      counterNumber: counter?.number,
      serviceName,
      centerName,
    },
  });
}

/**
 * Evaluates no-show warning when a token has been called and approaches expiry.
 *
 * @param {object} params
 * @param {object} params.token
 * @param {object} params.counter
 * @param {object} params.center
 * @param {number} params.elapsedSeconds
 */
async function evaluateNoShowWarning({ token, counter, center, elapsedSeconds }) {
  if (!token || !token._id || token.status !== 'CALLED') return null;

  const tokenId = token._id.toString();
  const counterLabel = counter?.displayLabel || counter?.name || 'the service counter';
  const dedupeKey = `${tokenId}_NO_SHOW_WARNING`;

  return await sendTokenNotification(token, 'NO_SHOW_WARNING', {
    title: 'No-Show Warning',
    body: `Your token ${token.tokenCode} has been called. Please proceed to ${counterLabel}.`,
    dedupeKey,
    metadata: {
      counterName: counter?.name,
      counterNumber: counter?.number,
      elapsedSeconds,
      centerName: center?.name,
    },
  });
}

/**
 * Send a broadcast notification to multiple users (e.g. admin to all queued visitors).
 *
 * @param {string[]} userIds
 * @param {string} centerId
 * @param {string} title
 * @param {string} body
 */
async function sendBroadcastNotification(userIds, centerId, title, body) {
  const notifications = [];

  for (const userId of userIds) {
    try {
      const notification = await Notification.create({
        userId,
        centerId,
        type: 'BROADCAST',
        title,
        body,
        deliveredViaSocket: false,
      });

      emitToUser(userId.toString(), 'notification.created', {
        notification: {
          _id: notification._id,
          type: 'BROADCAST',
          title,
          body,
          isRead: false,
          createdAt: notification.createdAt,
        },
      });

      await Notification.findByIdAndUpdate(notification._id, { deliveredViaSocket: true });
      notifications.push(notification);
    } catch (err) {
      logger.error('[Notification] Failed to broadcast notification', {
        userId: String(userId),
        error: err.message,
        service: 'notification',
      });
    }
  }

  return notifications;
}

module.exports = {
  sendTokenNotification,
  evaluateQueuePositionAlerts,
  evaluateTokenCalledAlert,
  evaluateNoShowWarning,
  sendBroadcastNotification,
};
