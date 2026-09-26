'use strict';

const mongoose = require('mongoose');
const ServiceCenter = require('../models/ServiceCenter');
const Service = require('../models/Service');
const { Token } = require('../models/Token');
const Queue = require('../models/Queue');
const ChannelEvent = require('../models/ChannelEvent');
const queueService = require('../services/queueService');
const channelIdentityService = require('../services/channelIdentityService');
const { logger } = require('../utils/logger');

const WhatsAppAdapter = require('./whatsappAdapter');
const SmsAdapter = require('./smsAdapter');
const TelegramAdapter = require('./telegramAdapter');

class ChannelManager {
  constructor() {
    this.adapters = {
      WHATSAPP: new WhatsAppAdapter(),
      SMS: new SmsAdapter(),
      TELEGRAM: new TelegramAdapter(),
    };
  }

  getAdapter(channel) {
    const adapter = this.adapters[channel.toUpperCase()];
    if (!adapter) throw new Error(`Unsupported channel: ${channel}`);
    return adapter;
  }

  /**
   * Returns current operational and configuration status for all external channels.
   */
  getChannelStatus() {
    return {
      whatsapp: {
        configured: this.adapters.WHATSAPP.isConfigured(),
        enabled: process.env.WHATSAPP_ENABLED === 'true',
        phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID ? 'Configured' : 'Missing',
      },
      sms: {
        configured: this.adapters.SMS.isConfigured(),
        enabled: process.env.SMS_ENABLED === 'true',
        provider: process.env.SMS_PROVIDER || 'twilio',
        fromNumber: process.env.SMS_FROM_NUMBER ? 'Configured' : 'Missing',
      },
      telegram: {
        configured: this.adapters.TELEGRAM.isConfigured(),
        enabled: process.env.TELEGRAM_ENABLED === 'true',
        botToken: process.env.TELEGRAM_BOT_TOKEN ? 'Configured' : 'Missing',
      },
    };
  }

  /**
   * Main entrypoint for incoming multi-channel requests.
   *
   * @param {'WHATSAPP'|'SMS'|'TELEGRAM'} channelName
   * @param {import('express').Request} req
   * @returns {Promise<object>}
   */
  async processIncomingMessage(channelName, req) {
    const adapter = this.getAdapter(channelName);

    // 1. Verify webhook signature
    const isValid = adapter.verifyWebhookSignature(req);
    if (!isValid) {
      const err = new Error('Invalid webhook signature or secret token');
      err.status = 401;
      throw err;
    }

    // 2. Parse incoming payload into normalized message
    const message = adapter.parseIncomingRequest(req);

    // Handle status receipts (delivery reports, etc.) without token side effects
    if (message.isStatusUpdate) {
      return { success: true, status: 'ACK_STATUS_UPDATE' };
    }

    const { externalEventId, senderId, text, metadata } = message;

    // 3. Enforce Idempotency — check if event has already been processed
    const existingEvent = await ChannelEvent.findOne({
      channel: channelName,
      externalEventId,
    });

    if (existingEvent) {
      if (existingEvent.status === 'PROCESSED') {
        logger.info('CHANNEL_IDEMPOTENT_HIT', {
          channel: channelName,
          externalEventId,
          tokenId: existingEvent.tokenId,
        });
        return {
          success: true,
          isDuplicate: true,
          responseText: existingEvent.responsePayload?.responseText,
          token: existingEvent.responsePayload?.token,
        };
      }
      if (existingEvent.status === 'PENDING') {
        return {
          success: true,
          isDuplicate: true,
          status: 'PENDING',
          message: 'Request is already being processed',
        };
      }
    }

    // Record pending event in database for atomic duplicate defense
    let channelEvent;
    try {
      channelEvent = await ChannelEvent.create({
        channel: channelName,
        externalEventId,
        status: 'PENDING',
      });
    } catch (dupErr) {
      if (dupErr.code === 11000) {
        // Concurrent duplicate event
        const found = await ChannelEvent.findOne({ channel: channelName, externalEventId });
        return {
          success: true,
          isDuplicate: true,
          responseText: found?.responsePayload?.responseText,
          token: found?.responsePayload?.token,
        };
      }
      throw dupErr;
    }

    try {
      // 4. Resolve external sender to canonical QueueFlow user
      const { user } = await channelIdentityService.resolveUserForChannel({
        channel: channelName,
        externalId: senderId,
        metadata,
      });

      // 5. Parse command and execute business logic
      const commandResult = await this._handleCommand({
        adapter,
        channelName,
        user,
        senderId,
        externalEventId,
        text,
      });

      // 6. Mark ChannelEvent as PROCESSED with response payload
      channelEvent.status = 'PROCESSED';
      channelEvent.tokenId = commandResult.token?._id || null;
      channelEvent.responsePayload = {
        responseText: commandResult.responseText,
        token: commandResult.token
          ? {
              _id: commandResult.token._id,
              tokenCode: commandResult.token.tokenCode,
              status: commandResult.token.status,
            }
          : null,
      };
      await channelEvent.save();

      // 7. Attempt outgoing response delivery if provider is configured
      if (adapter.isConfigured()) {
        try {
          await adapter.sendOutgoingMessage(senderId, commandResult.responseText);
        } catch (sendErr) {
          logger.warn('CHANNEL_OUTGOING_SEND_FAILED', {
            channel: channelName,
            recipient: senderId,
            error: sendErr.message,
          });
        }
      }

      return {
        success: true,
        channel: channelName,
        externalEventId,
        senderId,
        responseText: commandResult.responseText,
        token: commandResult.token || null,
        user: { _id: user._id, role: user.role },
      };
    } catch (procErr) {
      channelEvent.status = 'FAILED';
      channelEvent.errorMessage = procErr.message;
      await channelEvent.save().catch(() => {});
      throw procErr;
    }
  }

  /**
   * Internal command dispatcher.
   */
  async _handleCommand({ adapter, channelName, user, senderId, externalEventId, text }) {
    const trimmed = (text || '').trim();
    const parts = trimmed.split(/\s+/);
    const command = (parts[0] || '').replace(/^\//, '').toUpperCase();

    // ── Command: HELP / START / Empty ──
    if (!command || command === 'HELP' || command === 'START') {
      return {
        responseText: adapter.formatHelpResponse(),
        token: null,
      };
    }

    // ── Command: CENTERS ──
    if (command === 'CENTERS') {
      const centers = await ServiceCenter.find({ isOpen: true }).sort({ name: 1 }).lean();
      return {
        responseText: adapter.formatCentersResponse(centers),
        token: null,
      };
    }

    // ── Command: SERVICES <CenterCode> ──
    if (command === 'SERVICES') {
      const centerCode = parts[1];
      if (!centerCode) {
        return {
          responseText: adapter.formatErrorResponse(
            'BAD_REQUEST',
            'Please specify a center code. Example: SERVICES CITYHAL01'
          ),
          token: null,
        };
      }

      const center = await ServiceCenter.findOne({
        $or: [
          { code: centerCode.toUpperCase() },
          ...(mongoose.Types.ObjectId.isValid(centerCode) ? [{ _id: centerCode }] : []),
        ],
      }).lean();

      if (!center) {
        return {
          responseText: adapter.formatErrorResponse(
            'NOT_FOUND',
            `Service center "${centerCode}" not found. Reply CENTERS for open locations.`
          ),
          token: null,
        };
      }

      const services = await Service.find({ centerId: center._id, isActive: true })
        .sort({ order: 1, name: 1 })
        .lean();

      return {
        responseText: adapter.formatServicesResponse(center, services),
        token: null,
      };
    }

    // ── Command: STATUS ──
    if (command === 'STATUS') {
      const token = await Token.findOne({
        userId: user._id,
        status: { $in: ['WAITING', 'CALLED', 'SERVING'] },
      })
        .populate('centerId')
        .populate('serviceId');

      if (!token) {
        return {
          responseText: adapter.formatStatusResponse(null),
          token: null,
        };
      }

      const today = new Date().toISOString().slice(0, 10);
      const queue = await Queue.findOne({
        centerId: token.centerId._id,
        serviceId: token.serviceId._id,
        date: today,
      }).lean();

      return {
        responseText: adapter.formatStatusResponse(token, queue, token.centerId, token.serviceId),
        token,
      };
    }

    // ── Command: JOIN <CenterCode> <ServicePrefix> ──
    if (command === 'JOIN') {
      const centerCode = parts[1];
      const servicePrefix = parts[2];

      if (!centerCode || !servicePrefix) {
        return {
          responseText: adapter.formatErrorResponse(
            'BAD_REQUEST',
            'Please specify center and service. Example: JOIN CITYHAL01 A'
          ),
          token: null,
        };
      }

      // 1. Resolve Center
      const center = await ServiceCenter.findOne({
        $or: [
          { code: centerCode.toUpperCase() },
          ...(mongoose.Types.ObjectId.isValid(centerCode) ? [{ _id: centerCode }] : []),
        ],
      });

      if (!center) {
        return {
          responseText: adapter.formatErrorResponse(
            'NOT_FOUND',
            `Service center "${centerCode}" not found. Reply CENTERS for a list of open centers.`
          ),
          token: null,
        };
      }

      if (!center.isOpen) {
        return {
          responseText: adapter.formatErrorResponse(
            'CENTER_CLOSED',
            `Service center "${center.name}" is currently closed.`
          ),
          token: null,
        };
      }

      // 2. Resolve Service
      const service = await Service.findOne({
        centerId: center._id,
        $or: [
          { tokenPrefix: servicePrefix.toUpperCase() },
          { name: new RegExp(`^${servicePrefix}$`, 'i') },
          ...(mongoose.Types.ObjectId.isValid(servicePrefix) ? [{ _id: servicePrefix }] : []),
        ],
      });

      if (!service) {
        return {
          responseText: adapter.formatErrorResponse(
            'NOT_FOUND',
            `Service "${servicePrefix}" not found at ${center.name}. Reply SERVICES ${center.code} for available options.`
          ),
          token: null,
        };
      }

      if (!service.isActive) {
        return {
          responseText: adapter.formatErrorResponse(
            'SERVICE_INACTIVE',
            `Service "${service.name}" is currently unavailable.`
          ),
          token: null,
        };
      }

      // 3. Call Canonical Token Creation Authority
      try {
        const { token, queue } = await queueService.joinQueue({
          userId: user._id.toString(),
          centerId: center._id.toString(),
          serviceId: service._id.toString(),
          channel: channelName,
          channelMetadata: {
            externalMessageId: externalEventId,
            externalUserId: senderId,
          },
        });

        return {
          responseText: adapter.formatTokenSuccessResponse(token, queue, center, service),
          token,
        };
      } catch (queueErr) {
        if (queueErr.status === 409 || queueErr.code === 11000) {
          return {
            responseText: adapter.formatErrorResponse(
              'ACTIVE_TOKEN_EXISTS',
              `You already have an active ticket for ${service.name}. Reply STATUS to view your position.`
            ),
            token: null,
          };
        }
        return {
          responseText: adapter.formatErrorResponse('QUEUE_ERROR', queueErr.message),
          token: null,
        };
      }
    }

    // Unrecognized command
    return {
      responseText: adapter.formatErrorResponse(
        'UNKNOWN_COMMAND',
        `Unrecognized command "${parts[0]}".\nReply HELP for available commands.`
      ),
      token: null,
    };
  }
}

const channelManager = new ChannelManager();

module.exports = {
  ChannelManager,
  channelManager,
};
