'use strict';

/**
 * BaseChannelAdapter
 * Abstract contract for multi-channel intake adapters (WhatsApp, SMS, Telegram).
 * Each concrete adapter implements channel-specific signature verification,
 * request parsing, message formatting, and outgoing delivery.
 */
class BaseChannelAdapter {
  constructor(channelName) {
    if (!channelName) throw new Error('channelName is required');
    this.channelName = channelName;
  }

  /**
   * Returns true if real provider credentials are fully configured in the environment.
   * If false, webhook verification and incoming message simulation/testing can run,
   * but real external API outgoing delivery is safely flagged as unconfigured.
   * @returns {boolean}
   */
  isConfigured() {
    throw new Error('isConfigured() must be implemented by subclass');
  }

  /**
   * Verifies the authenticity and signature of an incoming webhook HTTP request.
   * @param {import('express').Request} req
   * @returns {boolean}
   */
  verifyWebhookSignature(_req) {
    throw new Error('verifyWebhookSignature() must be implemented by subclass');
  }

  /**
   * Parses raw incoming webhook request into a canonical ChannelMessage object:
   *  {
   *    externalEventId: string, // Unique provider message ID (for idempotency)
   *    senderId: string,        // Sender phone or chat/user ID
   *    text: string,            // User command/text
   *    metadata: object,        // Provider metadata (displayName, etc.)
   *    rawPayload: object       // Raw provider payload for audit
   *  }
   * @param {import('express').Request} req
   * @returns {object}
   */
  parseIncomingRequest(_req) {
    throw new Error('parseIncomingRequest() must be implemented by subclass');
  }

  /**
   * Formats an authoritative success message containing real token details.
   * NEVER generates fake token numbers or queue positions.
   */
  formatTokenSuccessResponse(token, queue, center, service) {
    const centerName = center?.name || 'Service Center';
    const serviceName = service?.name || 'Service';
    const waitText = token.waitEstimateMinutes !== null && token.waitEstimateMinutes !== undefined
      ? `~${token.waitEstimateMinutes} min`
      : 'Calculating';

    return (
      `🎫 QUEUEFLOW TOKEN CONFIRMATION\n` +
      `──────────────────────────\n` +
      `Token: ${token.tokenCode}\n` +
      `Service: ${serviceName}\n` +
      `Center: ${centerName}\n` +
      `Status: ${token.status}\n` +
      `Queue Position: #${token.currentPosition ?? token.initialPosition}\n` +
      `Waiting Ahead: ${queue?.waitingCount !== undefined ? Math.max(0, queue.waitingCount - 1) : 0}\n` +
      `Estimated Wait: ${waitText}\n` +
      `Ticket ID: ${token._id}\n` +
      `Time: ${new Date(token.createdAt).toLocaleTimeString()}\n` +
      `──────────────────────────\n` +
      `Send STATUS anytime to check your live queue position.`
    );
  }

  /**
   * Formats an error or informational response for the customer.
   */
  formatErrorResponse(errorType, message) {
    return `⚠️ QueueFlow: ${message || 'Unable to process your request.'}`;
  }

  /**
   * Formats available service centers.
   */
  formatCentersResponse(centers) {
    if (!centers || centers.length === 0) {
      return `ℹ️ No open service centers available right now.`;
    }
    const lines = centers.map((c) => `• [${c.code}] ${c.name}`);
    return (
      `🏛️ Open Service Centers:\n` +
      lines.join('\n') +
      `\n\nTo view services, reply:\nSERVICES <CenterCode>`
    );
  }

  /**
   * Formats available services for a center.
   */
  formatServicesResponse(center, services) {
    if (!services || services.length === 0) {
      return `ℹ️ No active services found for ${center.name}.`;
    }
    const lines = services.map(
      (s) => `• [${s.tokenPrefix}] ${s.name} (~${s.avgServiceTimeMinutes}m)`
    );
    return (
      `📋 Services at ${center.name} (${center.code}):\n` +
      lines.join('\n') +
      `\n\nTo join a queue, reply:\nJOIN ${center.code} <Prefix>`
    );
  }

  /**
   * Formats current active token status.
   */
  formatStatusResponse(token, queue, center, service) {
    if (!token) {
      return `ℹ️ You do not currently have any active queue tokens.\nReply CENTERS to see open centers.`;
    }
    const centerName = center?.name || 'Service Center';
    const serviceName = service?.name || 'Service';
    const waitText = token.waitEstimateMinutes !== null && token.waitEstimateMinutes !== undefined
      ? `~${token.waitEstimateMinutes} min`
      : 'Calculating';

    return (
      `📍 LIVE QUEUE STATUS\n` +
      `──────────────────────────\n` +
      `Token: ${token.tokenCode}\n` +
      `Service: ${serviceName}\n` +
      `Center: ${centerName}\n` +
      `Status: ${token.status}\n` +
      `Queue Position: #${token.currentPosition ?? token.initialPosition}\n` +
      `Estimated Wait: ${waitText}\n` +
      `──────────────────────────`
    );
  }

  /**
   * Formats general help instructions.
   */
  formatHelpResponse() {
    return (
      `👋 Welcome to QueueFlow Queue System!\n` +
      `Commands:\n` +
      `• CENTERS — List all open service centers\n` +
      `• SERVICES <CenterCode> — View available services\n` +
      `• JOIN <CenterCode> <Prefix> — Join queue & get a token\n` +
      `• STATUS — Check your active token position\n` +
      `• HELP — Show this help message`
    );
  }

  /**
   * Sends an outgoing message to the external provider API.
   * Throws if provider is unconfigured.
   * @param {string} _to
   * @param {string} _message
   * @returns {Promise<object>}
   */
  async sendOutgoingMessage(_to, _message) {
    throw new Error('sendOutgoingMessage() must be implemented by subclass');
  }
}

module.exports = BaseChannelAdapter;
