'use strict';

const asyncHandler = require('../utils/asyncHandler');
const { sendSuccess, sendBadRequest, sendUnauthorized } = require('../utils/apiResponse');
const { channelManager } = require('../channels/channelManager');
const { generateAccountLinkingCode } = require('../services/channelIdentityService');

/**
 * GET /api/channels/whatsapp/webhook
 * Meta Cloud API verification challenge.
 */
const verifyWhatsAppWebhook = (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  const expectedToken = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;

  if (mode === 'subscribe' && token === expectedToken) {
    return res.status(200).send(challenge);
  }

  return res.status(403).json({ success: false, message: 'Verification failed' });
};

/**
 * POST /api/channels/whatsapp/webhook
 */
const handleWhatsAppWebhook = asyncHandler(async (req, res) => {
  try {
    const result = await channelManager.processIncomingMessage('WHATSAPP', req);
    return res.status(200).json(result);
  } catch (err) {
    if (err.status === 401) {
      return sendUnauthorized(res, err.message);
    }
    if (err.status === 400 || err.message?.includes('Malformed') || err.message?.includes('Invalid')) {
      return sendBadRequest(res, err.message);
    }
    throw err;
  }
});

/**
 * POST /api/channels/sms/webhook
 */
const handleSmsWebhook = asyncHandler(async (req, res) => {
  try {
    const result = await channelManager.processIncomingMessage('SMS', req);
    return res.status(200).json(result);
  } catch (err) {
    if (err.status === 401) {
      return sendUnauthorized(res, err.message);
    }
    if (err.status === 400 || err.message?.includes('Malformed') || err.message?.includes('Invalid')) {
      return sendBadRequest(res, err.message);
    }
    throw err;
  }
});

/**
 * POST /api/channels/telegram/webhook
 */
const handleTelegramWebhook = asyncHandler(async (req, res) => {
  try {
    const result = await channelManager.processIncomingMessage('TELEGRAM', req);
    return res.status(200).json(result);
  } catch (err) {
    if (err.status === 401) {
      return sendUnauthorized(res, err.message);
    }
    if (err.status === 400 || err.message?.includes('Malformed') || err.message?.includes('Invalid')) {
      return sendBadRequest(res, err.message);
    }
    throw err;
  }
});

/**
 * GET /api/channels/status
 * Returns external provider configuration and availability status.
 */
const getChannelStatus = asyncHandler(async (_req, res) => {
  const status = channelManager.getChannelStatus();
  return sendSuccess(res, { data: status });
});

/**
 * POST /api/channels/link
 * Generates an OTP linking code for the authenticated customer.
 */
const requestAccountLinking = asyncHandler(async (req, res) => {
  const { channel } = req.body;
  if (!['WHATSAPP', 'SMS', 'TELEGRAM'].includes(channel)) {
    return sendBadRequest(res, 'Valid channel is required (WHATSAPP, SMS, TELEGRAM)');
  }

  const { code, expires } = await generateAccountLinkingCode(req.user._id, channel);

  return sendSuccess(res, {
    message: 'Linking code generated',
    data: {
      channel,
      code,
      expiresAt: expires,
      instructions: `Send "LINK ${code}" from your ${channel} application to link your account.`,
    },
  });
});

module.exports = {
  verifyWhatsAppWebhook,
  handleWhatsAppWebhook,
  handleSmsWebhook,
  handleTelegramWebhook,
  getChannelStatus,
  requestAccountLinking,
};
