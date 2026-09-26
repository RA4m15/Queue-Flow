'use strict';

const router = require('express').Router();
const { protect, requireRole } = require('../middleware/auth');
const { channelLimiter } = require('../middleware/rateLimiter');
const {
  verifyWhatsAppWebhook,
  handleWhatsAppWebhook,
  handleSmsWebhook,
  handleTelegramWebhook,
  getChannelStatus,
  requestAccountLinking,
} = require('../controllers/channelController');

// ─── Operational Status (Public/Monitored) ───────────────────────────────────
router.get('/status', getChannelStatus);

// ─── WhatsApp Webhooks ────────────────────────────────────────────────────────
router.get('/whatsapp/webhook', verifyWhatsAppWebhook);
router.post('/whatsapp/webhook', channelLimiter, handleWhatsAppWebhook);

// ─── SMS Webhook ─────────────────────────────────────────────────────────────
router.post('/sms/webhook', channelLimiter, handleSmsWebhook);

// ─── Telegram Webhook ────────────────────────────────────────────────────────
router.post('/telegram/webhook', channelLimiter, handleTelegramWebhook);

// ─── Authenticated Customer Account Linking ──────────────────────────────────
router.post('/link', protect, requireRole('CUSTOMER', 'ADMIN'), requestAccountLinking);

module.exports = router;
