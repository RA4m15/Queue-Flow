'use strict';

const crypto = require('crypto');
const axios = require('axios');
const BaseChannelAdapter = require('./baseChannelAdapter');

class SmsAdapter extends BaseChannelAdapter {
  constructor() {
    super('SMS');
  }

  isConfigured() {
    return (
      process.env.SMS_ENABLED === 'true' &&
      Boolean(process.env.SMS_ACCOUNT_SID) &&
      Boolean(process.env.SMS_AUTH_TOKEN) &&
      Boolean(process.env.SMS_FROM_NUMBER)
    );
  }

  /**
   * Verifies SMS webhook signature.
   * Supports:
   *  1. Twilio X-Twilio-Signature validation
   *  2. Webhook Secret Token header (X-SMS-Secret-Token)
   */
  verifyWebhookSignature(req) {
    const secret = process.env.SMS_WEBHOOK_SECRET || process.env.SMS_AUTH_TOKEN;

    // Test bypass in explicit test environment with test flag
    if (process.env.NODE_ENV === 'test' && req.headers['x-test-bypass-signature'] === 'true') {
      return true;
    }

    // 1. Shared secret token header
    const tokenHeader = req.headers['x-sms-secret-token'];
    if (tokenHeader && secret) {
      if (tokenHeader.length !== secret.length) return false;
      return crypto.timingSafeEqual(Buffer.from(tokenHeader), Buffer.from(secret));
    }

    // 2. Twilio Signature HMAC validation
    const twilioSignature = req.headers['x-twilio-signature'];
    if (twilioSignature && process.env.SMS_AUTH_TOKEN) {
      try {
        const url = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
        const params = req.body || {};
        const sortedKeys = Object.keys(params).sort();
        let data = url;
        for (const key of sortedKeys) {
          data += key + params[key];
        }
        const expected = crypto.createHmac('sha1', process.env.SMS_AUTH_TOKEN).update(data).digest('base64');
        if (twilioSignature.length !== expected.length) return false;
        return crypto.timingSafeEqual(Buffer.from(twilioSignature), Buffer.from(expected));
      } catch {
        return false;
      }
    }

    // If secrets configured but request has no matching auth, reject
    if (secret) {
      return false;
    }

    return process.env.NODE_ENV === 'development';
  }

  /**
   * Parses standard SMS incoming webhook payload.
   */
  parseIncomingRequest(req) {
    const body = req.body;
    if (!body || typeof body !== 'object') {
      throw new Error('Malformed SMS webhook payload: body must be an object');
    }

    // Standard Twilio / Telco format
    const senderId = body.From || body.from || body.senderId;
    const externalEventId = body.MessageSid || body.SmsMessageSid || body.SmsSid || body.messageId || body.externalEventId;
    const text = (body.Body || body.body || body.text || '').trim();

    if (!senderId || !externalEventId) {
      throw new Error('Invalid SMS webhook payload: missing From or MessageSid');
    }

    return {
      channel: 'SMS',
      externalEventId: String(externalEventId),
      senderId: String(senderId).startsWith('+') ? String(senderId) : `+${senderId}`,
      text,
      metadata: { to: body.To || body.to },
      rawPayload: body,
    };
  }

  /**
   * Compact SMS token response (optimized for SMS character limits).
   */
  formatTokenSuccessResponse(token, queue, center, service) {
    const waitText = token.waitEstimateMinutes !== null && token.waitEstimateMinutes !== undefined
      ? `~${token.waitEstimateMinutes}m`
      : 'Calculating';

    return (
      `QueueFlow Token: ${token.tokenCode}\n` +
      `Service: ${service?.name || 'Service'}\n` +
      `Center: ${center?.name || 'Center'}\n` +
      `Pos: #${token.currentPosition ?? token.initialPosition} (Wait: ${waitText})\n` +
      `Reply STATUS to check live position.`
    );
  }

  /**
   * Delivers outgoing SMS via Twilio API.
   */
  async sendOutgoingMessage(to, message) {
    if (!this.isConfigured()) {
      const err = new Error('SMS provider is not configured in environment (SMS_ACCOUNT_SID or SMS_AUTH_TOKEN missing)');
      err.code = 'PROVIDER_NOT_CONFIGURED';
      throw err;
    }

    const accountSid = process.env.SMS_ACCOUNT_SID;
    const authToken = process.env.SMS_AUTH_TOKEN;
    const from = process.env.SMS_FROM_NUMBER;

    const authHeader = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
    const params = new URLSearchParams();
    params.append('To', to);
    params.append('From', from);
    params.append('Body', message);

    const response = await axios.post(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
      params.toString(),
      {
        headers: {
          Authorization: `Basic ${authHeader}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        timeout: 10000,
      }
    );

    return response.data;
  }
}

module.exports = SmsAdapter;
