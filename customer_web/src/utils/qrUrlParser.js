/**
 * QueueFlow — QR & Web Join URL Parser
 * 
 * Supports both canonical HTTPS web entry URLs and legacy custom scheme:
 * - https://<allowed-host>/join?centerId=<24hexId>[&serviceId=<24hexId>]
 * - queueflow://join?centerId=<24hexId>[&serviceId=<24hexId>]
 * - Relative join path / query parameters (/join?centerId=... or ?centerId=...)
 *
 * Validation Rules:
 * - Ensures IDs strictly match valid MongoDB 24-character hexadecimal format.
 * - Rejects random QR codes, malformed URLs, and non-join strings.
 * - Rejects localhost (localhost, 127.0.0.1, 0.0.0.0, ::1).
 * - Rejects unsupported hosts and unapproved third-party domains.
 * - Rejects non-/join paths for web URLs.
 * - Rejects mismatched centerId == serviceId.
 * - Rejects staff HMAC check-in payloads.
 * - Client NEVER generates tokens here; this is purely routing parameter extraction.
 */

const MONGO_ID_REGEX = /^[a-fA-F0-9]{24}$/;

export const LOCAL_ONLY_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '::1',
  '[::1]',
]);

export const RESERVED_TLDS = ['.invalid', '.test', '.example', '.localhost', '.local'];

export const CANONICAL_JOIN_PATH = '/join';

export const DEFAULT_ALLOWED_HOSTS = new Set([
  'queueflow.app',
]);

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
 * Returns set of allowed hosts for canonical HTTPS join QR codes.
 * @returns {Set<string>}
 */
export function getAllowedJoinHosts() {
  const hosts = new Set(DEFAULT_ALLOWED_HOSTS);

  // Environment-configured allowed hosts
  try {
    const envHosts = import.meta.env?.VITE_ALLOWED_JOIN_HOSTS;
    if (envHosts && typeof envHosts === 'string') {
      envHosts.split(',').forEach((h) => {
        const trimmed = h.trim().toLowerCase();
        if (trimmed) hosts.add(trimmed);
      });
    }

    const envWebUrl = import.meta.env?.VITE_CUSTOMER_WEB_URL;
    if (envWebUrl) {
      try {
        const u = new URL(envWebUrl);
        if (u.hostname && !LOCAL_ONLY_HOSTS.has(u.hostname.toLowerCase())) {
          hosts.add(u.hostname.toLowerCase());
        }
      } catch (_) {}
    }
  } catch (_) {}

  // Current origin host if public
  if (typeof window !== 'undefined' && window.location?.hostname) {
    const cur = window.location.hostname.toLowerCase();
    if (!LOCAL_ONLY_HOSTS.has(cur) && !/^\d{1,3}(\.\d{1,3}){3}$/.test(cur)) {
      hosts.add(cur);
    }
  }

  return hosts;
}

/**
 * Checks if a host is allowed for canonical join URLs.
 * @param {string} hostname 
 * @returns {boolean}
 */
export function isAllowedHost(hostname) {
  if (!hostname || typeof hostname !== 'string') return false;
  const host = hostname.trim().toLowerCase();

  if (LOCAL_ONLY_HOSTS.has(host)) return false;
  if (RESERVED_TLDS.some((tld) => host === tld.slice(1) || host.endsWith(tld))) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false;

  const allowed = getAllowedJoinHosts();
  return allowed.has(host);
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

  // Hard length cap to reject giant payloads
  if (input.length > 512) {
    return {
      isValid: false,
      centerId: null,
      serviceId: null,
      error: 'QR payload exceeds maximum length'
    };
  }

  const raw = input.trim();
  if (!raw) {
    return {
      isValid: false,
      centerId: null,
      serviceId: null,
      error: 'Empty or invalid QR join data'
    };
  }

  // Reject staff HMAC check-in QR payload
  if (raw.startsWith('{') && raw.includes('"sig":') && (raw.includes('"tid":') || raw.includes('"pur":'))) {
    return {
      isValid: false,
      centerId: null,
      serviceId: null,
      error: 'Staff check-in QR cannot be used to join a customer queue'
    };
  }

  let params = null;

  try {
    if (raw.startsWith('queueflow://')) {
      // Custom scheme: queueflow://join?centerId=...
      const url = new URL(raw);
      if (url.host !== 'join') {
        return {
          isValid: false,
          centerId: null,
          serviceId: null,
          error: 'This QR code is not a valid QueueFlow join link.'
        };
      }
      params = url.searchParams;
    } else if (raw.startsWith('http://') || raw.startsWith('https://')) {
      // Web URL
      const url = new URL(raw);
      const host = url.hostname.toLowerCase();

      // Reject localhost and loopback addresses
      if (LOCAL_ONLY_HOSTS.has(host) || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
        return {
          isValid: false,
          centerId: null,
          serviceId: null,
          error: 'Localhost and IP address links are not valid for public QR scanning.'
        };
      }

      // Enforce HTTPS for public domain QR codes
      if (url.protocol !== 'https:') {
        return {
          isValid: false,
          centerId: null,
          serviceId: null,
          error: 'Insecure link. Public QueueFlow QR codes must use HTTPS.'
        };
      }

      // Check allowed host
      if (!isAllowedHost(host)) {
        return {
          isValid: false,
          centerId: null,
          serviceId: null,
          error: 'Unsupported host in QR code. Please scan an official QueueFlow queue QR.'
        };
      }

      // Check canonical path: must be /join or /join/
      const cleanPath = url.pathname.replace(/\/+$/, '');
      if (cleanPath !== CANONICAL_JOIN_PATH) {
        return {
          isValid: false,
          centerId: null,
          serviceId: null,
          error: 'Invalid QR link path. Must be a /join link.'
        };
      }

      params = url.searchParams;
    } else if (raw.startsWith('/join?') || raw.startsWith('join?') || raw.startsWith('?') || (raw.includes('centerId=') && !raw.includes(' '))) {
      // Internal relative URL or query string
      const qIndex = raw.indexOf('?');
      params = new URLSearchParams(qIndex >= 0 ? raw.slice(qIndex + 1) : raw);
    } else {
      return {
        isValid: false,
        centerId: null,
        serviceId: null,
        error: 'Unrecognized QR code format. Please scan an official QueueFlow queue QR.'
      };
    }
  } catch (_) {
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

  // Mismatched centerId == serviceId sanity guard
  if (serviceId && centerId.toLowerCase() === serviceId.toLowerCase()) {
    return {
      isValid: false,
      centerId,
      serviceId: null,
      error: 'QR link contains mismatched service and center references'
    };
  }

  return {
    isValid: true,
    centerId,
    serviceId: serviceId || null,
    error: null
  };
}
