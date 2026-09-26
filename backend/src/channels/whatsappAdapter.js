'use strict';

const crypto = require('crypto');
const axios = require('axios');
const BaseChannelAdapter = require('./baseChannelAdapter');

class WhatsAppAdapter extends BaseChannelAdapter {
  constructor() {
    super('WHATSAPP');
  }

  isConfigured() {
    return (
      process.env.WHATSAPP_ENABLED === 'true' &&
      Boolean(process.env.WHATSAPP_API_TOKEN) &&
      Boolean(process.env.WHATSAPP_PHONE_NUMBER_ID)
    );
  }

  /**
   * Verifies WhatsApp webhook signature.
   * Supports:
   *  1. Meta Cloud API: X-Hub-Signature-256 (HMAC-SHA256 of raw body against WHATSAPP_APP_SECRET)
   *  2. Shared Webhook Secret Token: X-WhatsApp-Secret-Token or verify token
   */
  verifyWebhookSignature(req) {
    const appSecret = process.env.WHATSAPP_APP_SECRET;
    const verifyToken = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;

    // Test bypass in explicit test environment with test flag
    if (process.env.NODE_ENV === 'test' && req.headers['x-test-bypass-signature'] === 'true') {
      return true;
    }

    // 1. Meta X-Hub-Signature-256
    const hubSignature = req.headers['x-hub-signature-256'];
    if (hubSignature && appSecret) {
      try {
        const rawBody = req.rawBody || JSON.stringify(req.body);
        const expected = `sha256=${crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex')}`;
        if (hubSignature.length !== expected.length) return false;
        return crypto.timingSafeEqual(Buffer.from(hubSignature), Buffer.from(expected));
      } catch {
        return false;
      }
    }

    // 2. Secret Token header check
    const secretHeader = req.headers['x-whatsapp-secret-token'];
    if (secretHeader && verifyToken) {
      if (secretHeader.length !== verifyToken.length) return false;
      return crypto.timingSafeEqual(Buffer.from(secretHeader), Buffer.from(verifyToken));
    }

    // If secrets are configured in env but request lacks valid signature, reject
    if (appSecret || verifyToken) {
      return false;
    }

    // If running in development without secrets configured, reject unless explicit dev mode
    return process.env.NODE_ENV === 'development';
  }

  /**
   * Parses WhatsApp incoming webhook payload.
   * Handles:
   *  - Meta Cloud API payload (entry[0].changes[0].value.messages[0])
   *  - Twilio WhatsApp payload (From, Body, MessageSid)
   */
  parseIncomingRequest(req) {
    const body = req.body;
    if (!body || typeof body !== 'object') {
      throw new Error('Malformed WhatsApp webhook payload: body must be an object');
    }

    // Case 1: Meta Cloud API format
    if (body.object === 'whatsapp_business_account' && Array.isArray(body.entry)) {
      const entry = body.entry[0];
      const change = entry?.changes?.[0]?.value;
      const message = change?.messages?.[0];
      const contact = change?.contacts?.[0];

      if (!message) {
        // May be a delivery status webhook (sent, delivered, read)
        return {
          isStatusUpdate: true,
          externalEventId: change?.statuses?.[0]?.id || `status_${Date.now()}`,
          status: change?.statuses?.[0]?.status,
        };
      }

      const senderId = message.from; // Phone number without '+'
      const text = message.text?.body || message.button?.text || message.interactive?.button_reply?.title || '';
      const externalEventId = message.id; // e.g. wamid.HBg...
      const displayName = contact?.profile?.name || '';

      if (!senderId || !externalEventId) {
        throw new Error('Invalid Meta WhatsApp payload: missing message ID or sender');
      }

      return {
        channel: 'WHATSAPP',
        externalEventId,
        senderId: senderId.startsWith('+') ? senderId : `+${senderId}`,
        text: text.trim(),
        metadata: { displayName, messageType: message.type },
        rawPayload: body,
      };
    }

    // Case 2: Twilio WhatsApp format (From: 'whatsapp:+14155552671', Body, MessageSid)
    if (body.MessageSid || body.SmsMessageSid) {
      const rawFrom = body.From || '';
      const senderPhone = rawFrom.replace(/^whatsapp:/i, '');
      const externalEventId = body.MessageSid || body.SmsMessageSid;
      const text = (body.Body || '').trim();

      if (!senderPhone || !externalEventId) {
        throw new Error('Invalid Twilio WhatsApp payload: missing MessageSid or From');
      }

      return {
        channel: 'WHATSAPP',
        externalEventId,
        senderId: senderPhone.startsWith('+') ? senderPhone : `+${senderPhone}`,
        text,
        metadata: { profileName: body.ProfileName || '' },
        rawPayload: body,
      };
    }

    // Case 3: Normalized direct test/API payload
    if (body.senderId && body.externalEventId) {
      return {
        channel: 'WHATSAPP',
        externalEventId: String(body.externalEventId),
        senderId: String(body.senderId),
        text: String(body.text || '').trim(),
        metadata: body.metadata || {},
        rawPayload: body,
      };
    }

    throw new Error('Unsupported WhatsApp payload structure');
  }

  /**
   * Delivers outgoing WhatsApp message to recipient.
   */
  async sendOutgoingMessage(to, message) {
    if (!this.isConfigured()) {
      const err = new Error('WhatsApp provider is not configured in environment (WHATSAPP_API_TOKEN or WHATSAPP_PHONE_NUMBER_ID missing)');
      err.code = 'PROVIDER_NOT_CONFIGURED';
      throw err;
    }

    const token = process.env.WHATSAPP_API_TOKEN;
    const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
    const cleanPhone = to.replace(/[^0-9]/g, '');

    const response = await axios.post(
      `https://graph.facebook.com/v18.0/${phoneId}/messages`,
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: cleanPhone,
        type: 'text',
        text: { preview_url: false, body: message },
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        timeout: 10000,
      }
    );

    return response.data;
  }
}

module.exports = WhatsAppAdapter;
