'use strict';

const QRCode = require('qrcode');
const { generateSignedQRPayload } = require('./qrSecurity');

/**
 * Get today's date as YYYY-MM-DD in local time.
 * Used as the queue's date partition key.
 */
function getTodayDateString() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Format a token code from prefix and number.
 * e.g. ('A', 47) → 'A-047'
 * @param {string} prefix - Token prefix (e.g. 'A')
 * @param {number} number - Token number
 * @returns {string}
 */
function formatTokenCode(prefix, number) {
  return `${prefix.toUpperCase()}-${String(number).padStart(3, '0')}`;
}

/**
 * Generate a cryptographically signed QR payload for a token.
 * The QR contains a signed, short-lived, nonce-protected payload
 * that the backend can verify without trusting client-supplied data.
 *
 * PII NOT included: userId, email, phone, password, JWT.
 *
 * @param {string} tokenId   - MongoDB _id of the token
 * @param {string} centerId  - MongoDB _id of the service center
 * @param {string} serviceId - MongoDB _id of the service
 * @returns {{ qrData: string, nonce: string, issuedAt: Date }}
 *   qrData   — signed JSON string suitable for encoding into a QR image
 *   nonce    — UUID v4 (jti) — must be stored on the Token document for replay protection
 *   issuedAt — Date when the QR was issued — stored for audit trail
 * @throws {Error} if QR_SIGNING_SECRET is not configured
 */
function generateQRData(tokenId, centerId, serviceId) {
  const qrData = generateSignedQRPayload({ tokenId, centerId, serviceId });
  // Parse nonce and issuedAt from the payload so the caller can persist them
  const parsed = JSON.parse(qrData);
  return {
    qrData,
    nonce: parsed.jti,
    issuedAt: new Date(parsed.iat * 1000),
  };
}

/**
 * Generate a base64-encoded PNG QR code image from a data string.
 * @param {string} data
 * @returns {Promise<string>} data URL (data:image/png;base64,...)
 */
async function generateQRCodeImage(data) {
  return QRCode.toDataURL(data, {
    errorCorrectionLevel: 'M',
    margin: 2,
    width: 256,
    color: {
      dark: '#070b09',
      light: '#ffffff',
    },
  });
}

module.exports = {
  getTodayDateString,
  formatTokenCode,
  generateQRData,
  generateQRCodeImage,
};
