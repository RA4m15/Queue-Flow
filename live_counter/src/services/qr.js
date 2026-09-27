import QRCode from 'qrcode';

/**
 * QueueFlow — Canonical Customer Queue QR
 *
 * There is exactly ONE customer queue QR format, and it is HTTPS:
 *
 *   https://<customer-web-domain>/join?centerId=<CENTER_ID>
 *   https://<customer-web-domain>/join?centerId=<CENTER_ID>&serviceId=<SERVICE_ID>
 *
 * One URL serves every case, which is why it is the format that gets encoded
 * into the QR image on the display:
 *
 *   - Phone camera, QueueFlow installed -> Android App Link / iOS Universal Link
 *     opens the app. Requires the domain to publish assetlinks.json /
 *     apple-app-site-association, which is outside this repository.
 *   - Phone camera, QueueFlow NOT installed -> the browser opens Customer Web
 *     on the same /join route. This is the guaranteed fallback.
 *   - In-app QR scanner -> recognises the identical string and routes
 *     internally.
 *
 * `queueflow://join?...` is still produced by buildJoinUrls() for backwards
 * compatibility with existing integrations, but it is never the primary QR
 * payload: a custom scheme is meaningless on a phone without the app.
 */

const configuredBase = (import.meta.env.VITE_CUSTOMER_WEB_URL || '').trim();

/** Base URL of the deployed Customer Web app. Never contains a trailing slash. */
export const CUSTOMER_WEB_BASE = (configuredBase || 'http://localhost:5173').replace(/\/$/, '');

/** Hosts that must never appear in a QR intended for a public display. */
const LOCAL_ONLY_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1']);

/**
 * Reserved / documentation-only TLDs (RFC 2606, RFC 6761). None of these can
 * ever be a real deployment, so a QR built from one of them is a configuration
 * mistake rather than a working link. The Android and iOS deep-link
 * configuration deliberately defaults to `.invalid` for exactly this reason:
 * a build that forgot to set the host must fail loudly here instead of
 * printing a plausible-looking dead code on a lobby screen.
 */
const RESERVED_TLDS = ['.invalid', '.test', '.example', '.localhost', '.local'];

/**
 * Whether the configured Customer Web base is a public, scannable URL.
 *
 * A QR pointing at localhost, a raw IP, or a reserved TLD is useless to a
 * customer standing in front of the display: their phone would try to reach
 * something that is not there. Callers use this to surface a configuration
 * error instead of silently printing a dead QR.
 */
export function isPublicCustomerWebBase(base = CUSTOMER_WEB_BASE) {
  let url;
  try {
    url = new URL(base);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;

  const host = url.hostname.toLowerCase();
  if (LOCAL_ONLY_HOSTS.has(host)) return false;
  if (RESERVED_TLDS.some((tld) => host === tld.slice(1) || host.endsWith(tld))) {
    return false;
  }
  // A bare IP address is scannable but not verifiable for App Links, and is
  // never a real deployment target for this project.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false;
  return true;
}

/**
 * Build the canonical HTTPS join URL for a real center (and optional service).
 *
 * IDs are always supplied by the caller from live backend data. Nothing is
 * hardcoded, and no credential of any kind is ever placed in the URL.
 *
 * @returns {string} the canonical join URL, or '' when there is no centerId.
 */
export function buildCanonicalJoinUrl(centerId, serviceId = null) {
  if (!centerId || typeof centerId !== 'string') return '';

  const params = new URLSearchParams();
  params.set('centerId', centerId);
  if (serviceId) {
    params.set('serviceId', serviceId);
  }

  return `${CUSTOMER_WEB_BASE}/join?${params.toString()}`;
}

/**
 * Build both join URLs from real backend identifiers.
 *
 * `webUrl` is the canonical HTTPS link and is what the QR encodes.
 * `deepLink` is the legacy custom scheme, returned for backwards compatibility.
 */
export function buildJoinUrls(centerId, serviceId = null) {
  if (!centerId) return { deepLink: '', webUrl: '' };

  const params = new URLSearchParams();
  params.set('centerId', centerId);
  if (serviceId) {
    params.set('serviceId', serviceId);
  }

  const queryStr = params.toString();
  const deepLink = `queueflow://join?${queryStr}`;
  const webUrl = `${CUSTOMER_WEB_BASE}/join?${queryStr}`;

  return { deepLink, webUrl };
}

/**
 * Resolve which payload the on-screen QR should encode.
 *
 * Prefers the canonical HTTPS link. Falls back to the legacy custom scheme only
 * when no Customer Web base has been configured at all, so an unconfigured dev
 * build still shows a working QR instead of an empty panel.
 */
export function resolveQrPayload(centerId, serviceId = null) {
  const { deepLink, webUrl } = buildJoinUrls(centerId, serviceId);
  if (webUrl) return webUrl;
  return deepLink;
}

/**
 * Generate high-contrast, scalable QR code image data URL for TV/screen display.
 */
export async function generateQrDataUrl(text, size = 300) {
  if (!text) return '';

  try {
    return await QRCode.toDataURL(text, {
      width: size,
      margin: 1,
      errorCorrectionLevel: 'M',
      color: {
        dark: '#050B18',
        light: '#FFFFFF',
      },
    });
  } catch (err) {
    console.error('Failed to generate QR code data URL:', err);
    return '';
  }
}
