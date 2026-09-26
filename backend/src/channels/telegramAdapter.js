'use strict';

const crypto = require('crypto');
const axios = require('axios');
const BaseChannelAdapter = require('./baseChannelAdapter');

class TelegramAdapter extends BaseChannelAdapter {
  constructor() {
    super('TELEGRAM');
  }

  isConfigured() {
    return (
      process.env.TELEGRAM_ENABLED === 'true' &&
      Boolean(process.env.TELEGRAM_BOT_TOKEN)
    );
  }

  /**
   * Verifies Telegram webhook request.
   * Telegram Bot API sends the configured secret in X-Telegram-Bot-Api-Secret-Token.
   */
  verifyWebhookSignature(req) {
    const secret = process.env.TELEGRAM_WEBHOOK_SECRET;

    // Test bypass in explicit test environment with test flag
    if (process.env.NODE_ENV === 'test' && req.headers['x-test-bypass-signature'] === 'true') {
      return true;
    }

    const tokenHeader = req.headers['x-telegram-bot-api-secret-token'];
    if (tokenHeader && secret) {
      if (tokenHeader.length !== secret.length) return false;
      return crypto.timingSafeEqual(Buffer.from(tokenHeader), Buffer.from(secret));
    }

    if (secret) {
      return false;
    }

    return process.env.NODE_ENV === 'development';
  }

  /**
   * Parses Telegram webhook update payload.
   * Handles:
   *  - Telegram Update object (update_id, message.message_id, message.chat.id, message.text)
   *  - Telegram CallbackQuery (button click)
   *  - Direct normalized test payload
   */
  parseIncomingRequest(req) {
    const body = req.body;
    if (!body || typeof body !== 'object') {
      throw new Error('Malformed Telegram webhook payload: body must be an object');
    }

    // Telegram Bot API standard Update format
    if (body.update_id !== undefined && (body.message || body.callback_query)) {
      const message = body.message || body.callback_query?.message;
      const from = body.message?.from || body.callback_query?.from;
      const text = body.message?.text || body.callback_query?.data || '';
      const chatId = message?.chat?.id || from?.id;
      const externalEventId = String(body.update_id);

      if (!chatId || !externalEventId) {
        throw new Error('Invalid Telegram update: missing chat ID or update_id');
      }

      const displayName = [from?.first_name, from?.last_name].filter(Boolean).join(' ') || from?.username || '';

      return {
        channel: 'TELEGRAM',
        externalEventId,
        senderId: String(chatId),
        text: text.trim(),
        metadata: {
          username: from?.username || '',
          displayName,
          telegramUserId: from?.id,
          isBot: from?.is_bot || false,
        },
        rawPayload: body,
      };
    }

    // Direct normalized payload (testing / simulator)
    if (body.senderId && body.externalEventId) {
      return {
        channel: 'TELEGRAM',
        externalEventId: String(body.externalEventId),
        senderId: String(body.senderId),
        text: String(body.text || '').trim(),
        metadata: body.metadata || {},
        rawPayload: body,
      };
    }

    throw new Error('Unsupported Telegram update payload structure');
  }

  /**
   * Telegram-formatted token confirmation.
   */
  formatTokenSuccessResponse(token, queue, center, service) {
    const centerName = center?.name || 'Service Center';
    const serviceName = service?.name || 'Service';
    const waitText = token.waitEstimateMinutes !== null && token.waitEstimateMinutes !== undefined
      ? `~${token.waitEstimateMinutes} min`
      : 'Calculating';

    return (
      `🎫 *QueueFlow Token Confirmation*\n` +
      `━━━━━━━━━━━━━━━━━━━\n` +
      `*Token:* \`${token.tokenCode}\`\n` +
      `*Service:* ${serviceName}\n` +
      `*Center:* ${centerName}\n` +
      `*Status:* ${token.status}\n` +
      `*Queue Position:* #${token.currentPosition ?? token.initialPosition}\n` +
      `*Waiting Ahead:* ${queue?.waitingCount !== undefined ? Math.max(0, queue.waitingCount - 1) : 0}\n` +
      `*Estimated Wait:* ${waitText}\n` +
      `*Ticket ID:* \`${token._id}\`\n` +
      `━━━━━━━━━━━━━━━━━━━\n` +
      `Use /status anytime to track your position in line.`
    );
  }

  formatHelpResponse() {
    return (
      `👋 *QueueFlow Telegram Bot*\n\n` +
      `Available commands:\n` +
      `• /centers — List all open service centers\n` +
      `• /services <CenterCode> — View available services\n` +
      `• /join <CenterCode> <Prefix> — Take a queue token\n` +
      `• /status — Check your active token position\n` +
      `• /help — Show this help message`
    );
  }

  /**
   * Delivers outgoing Telegram message to chat.
   */
  async sendOutgoingMessage(to, message) {
    if (!this.isConfigured()) {
      const err = new Error('Telegram bot is not configured in environment (TELEGRAM_BOT_TOKEN missing)');
      err.code = 'PROVIDER_NOT_CONFIGURED';
      throw err;
    }

    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const response = await axios.post(
      `https://api.telegram.org/bot${botToken}/sendMessage`,
      {
        chat_id: to,
        text: message,
        parse_mode: 'Markdown',
      },
      { timeout: 10000 }
    );

    return response.data;
  }
}

module.exports = TelegramAdapter;
