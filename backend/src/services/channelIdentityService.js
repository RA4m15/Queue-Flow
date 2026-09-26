'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const ExternalIdentity = require('../models/ExternalIdentity');

/**
 * Normalizes phone numbers to standard E.164-style representation.
 * Strips whitespace, dashes, and parentheses; preserves leading '+'.
 */
function normalizePhoneNumber(phone) {
  if (!phone || typeof phone !== 'string') return '';
  const cleaned = phone.replace(/[\s\-()]/g, '');
  if (cleaned.startsWith('+')) return cleaned;
  if (/^\d{10,15}$/.test(cleaned)) return `+${cleaned}`;
  return cleaned;
}

/**
 * Resolves an external channel sender (WhatsApp/SMS phone or Telegram ID)
 * to a verified QueueFlow User account.
 *
 * Guarantees:
 *  1. Every external channel caller maps to a valid User entity for canonical queueing.
 *  2. No password or JWT is ever created or transmitted through external messaging.
 *  3. External callers cannot impersonate users without matching identity verification.
 *
 * @param {object} params
 * @param {'WHATSAPP'|'SMS'|'TELEGRAM'} params.channel
 * @param {string} params.externalId
 * @param {object} [params.metadata]
 * @returns {Promise<{ user: User, identity: ExternalIdentity }>}
 */
async function resolveUserForChannel({ channel, externalId, metadata = {} }) {
  if (!['WHATSAPP', 'SMS', 'TELEGRAM'].includes(channel)) {
    throw new Error(`Invalid channel: ${channel}`);
  }
  if (!externalId || typeof externalId !== 'string') {
    throw new Error('Valid externalId is required');
  }

  const normalizedId = (channel === 'WHATSAPP' || channel === 'SMS')
    ? normalizePhoneNumber(externalId)
    : externalId.trim();

  // 1. Check existing ExternalIdentity mapping
  let identity = await ExternalIdentity.findOne({ channel, externalId: normalizedId });

  if (identity && identity.userId) {
    const user = await User.findById(identity.userId);
    if (user && user.isActive) {
      identity.lastMessageAt = new Date();
      if (metadata && Object.keys(metadata).length > 0) {
        identity.metadata = { ...identity.metadata, ...metadata };
      }
      await identity.save();
      return { user, identity };
    }
  }

  // 2. If phone-based channel (WhatsApp/SMS), check if an existing User registered with this phone
  let user = null;
  if (channel === 'WHATSAPP' || channel === 'SMS') {
    user = await User.findOne({ phone: normalizedId, isActive: true });
  }

  // 3. If no existing user, create a dedicated channel customer account
  if (!user) {
    const randomSecret = crypto.randomBytes(32).toString('hex');
    const passwordHash = await bcrypt.hash(randomSecret, 10);
    const last4 = normalizedId.slice(-4);
    let displayName;
    let emailPrefix;

    if (channel === 'WHATSAPP') {
      displayName = metadata.displayName ? `WhatsApp: ${metadata.displayName}` : `WhatsApp User ${last4}`;
      emailPrefix = `wa_${normalizedId.replace(/[^0-9]/g, '')}`;
    } else if (channel === 'SMS') {
      displayName = `SMS User ${last4}`;
      emailPrefix = `sms_${normalizedId.replace(/[^0-9]/g, '')}`;
    } else {
      displayName = metadata.displayName ? `Telegram: ${metadata.displayName}` : `Telegram User ${last4}`;
      emailPrefix = `tg_${normalizedId.replace(/[^0-9]/g, '')}`;
    }

    const email = `${emailPrefix}_${Date.now()}@channel.queueflow.dev`;

    user = await User.create({
      name: displayName,
      email,
      phone: (channel === 'WHATSAPP' || channel === 'SMS') ? normalizedId : undefined,
      passwordHash,
      role: 'CUSTOMER',
      isActive: true,
      preferences: {
        notifyApp: false,
        notifySms: channel === 'SMS' || channel === 'WHATSAPP',
      },
    });
  }

  // 4. Create or update the ExternalIdentity record
  if (!identity) {
    identity = await ExternalIdentity.create({
      channel,
      externalId: normalizedId,
      userId: user._id,
      isVerified: channel === 'WHATSAPP' || channel === 'SMS',
      metadata,
      lastMessageAt: new Date(),
    });
  } else {
    identity.userId = user._id;
    identity.lastMessageAt = new Date();
    await identity.save();
  }

  return { user, identity };
}

/**
 * Explicit account linking: generate a one-time verification code for an authenticated user.
 */
async function generateAccountLinkingCode(userId, channel) {
  const user = await User.findById(userId);
  if (!user) throw new Error('User not found');

  const code = crypto.randomInt(100000, 999999).toString();
  const hash = crypto.createHash('sha256').update(code).digest('hex');
  const expires = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

  return { code, hash, expires };
}

module.exports = {
  resolveUserForChannel,
  generateAccountLinkingCode,
  normalizePhoneNumber,
};
