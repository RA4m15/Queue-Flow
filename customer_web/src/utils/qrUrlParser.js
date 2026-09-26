/**
 * QueueFlow — QR & Web Join URL Parser
 * 
 * Supports both custom scheme and HTTPS web entry URLs:
 * - queueflow://join?centerId=<24hexId>&serviceId=<24hexId>
 * - queueflow://join?centerId=<24hexId>
 * - https://<domain>/join?centerId=<24hexId>&serviceId=<24hexId>
 * - Query parameters (?centerId=...&serviceId=...)
 *
 * Ensures IDs strictly match valid MongoDB 24-character hexadecimal format.
 * Client NEVER generates tokens here; this is purely routing parameter extraction.
 */

const MONGO_ID_REGEX = /^[a-fA-F0-9]{24}$/;

/**
 * Validates whether a given string is a valid 24-hex MongoDB ObjectId.
 * @param {string} id 
 * @returns {boolean}
 */
export function isValidMongoId(id) {
  if (!id || typeof id !== 'string') return false;
  return MONGO_ID_REGEX.test(id.trim());
}

/**
 * Parses raw input (URL, query string, or QR payload) into validated centerId and serviceId.
 * @param {string} input 
 * @returns {{ isValid: boolean, centerId: string|null, serviceId: string|null, error: string|null }}
 */
export function parseJoinUrl(input) {
  if (!input || typeof input !== 'string') {
    return {
      isValid: false,
      centerId: null,
      serviceId: null,
      error: 'Empty or invalid QR join data'
    };
  }

  const raw = input.trim();

  let params = null;

  try {
    if (raw.startsWith('queueflow://')) {
      // Custom scheme: queueflow://join?centerId=...
      const queryPart = raw.split('?')[1];
      if (queryPart) {
        params = new URLSearchParams(queryPart);
      }
    } else if (raw.startsWith('http://') || raw.startsWith('https://')) {
      // Web URL
      const url = new URL(raw);
      params = url.searchParams;
    } else if (raw.startsWith('?') || raw.includes('=')) {
      // Bare query string
      params = new URLSearchParams(raw.startsWith('?') ? raw.slice(1) : raw);
    } else {
      return {
        isValid: false,
        centerId: null,
        serviceId: null,
        error: 'Unrecognized QR code format. Please scan an official QueueFlow queue QR.'
      };
    }
  } catch (err) {
    return {
      isValid: false,
      centerId: null,
      serviceId: null,
      error: 'Malformed URL in QR code'
    };
  }

  if (!params) {
    return {
      isValid: false,
      centerId: null,
      serviceId: null,
      error: 'No join parameters found in QR code'
    };
  }

  const rawCenterId = params.get('centerId') || params.get('cid');
  const rawServiceId = params.get('serviceId') || params.get('sid');

  const centerId = rawCenterId ? rawCenterId.trim() : null;
  const serviceId = rawServiceId ? rawServiceId.trim() : null;

  if (!centerId) {
    return {
      isValid: false,
      centerId: null,
      serviceId: null,
      error: 'Missing required Service Center ID'
    };
  }

  if (!isValidMongoId(centerId)) {
    return {
      isValid: false,
      centerId: null,
      serviceId: null,
      error: 'Invalid Service Center ID format'
    };
  }

  if (serviceId && !isValidMongoId(serviceId)) {
    return {
      isValid: false,
      centerId,
      serviceId: null,
      error: 'Invalid Service ID format'
    };
  }

  return {
    isValid: true,
    centerId,
    serviceId: serviceId || null,
    error: null
  };
}
