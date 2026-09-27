/// QueueFlow — Canonical Customer Queue-Join Configuration
///
/// There is exactly ONE canonical customer queue QR format, and it is HTTPS:
///
///     HOST/join?centerId=ID
///     HOST/join?centerId=ID&serviceId=ID
///
/// where HOST is the deployed Customer Web domain (scheme included) and ID is a
/// 24-character hex MongoDB ObjectId. `serviceId` is present only when the QR
/// is pinned to one service; without it the customer picks a service.
///
/// That single URL is the payload encoded into the QR image on the Live Counter
/// display. It is designed so that one scan works in every case:
///
///   * Phone camera, app installed  -> Android App Link / iOS Universal Link
///                                     opens the Flutter app (requires domain
///                                     verification — see report).
///   * Phone camera, app missing    -> normal browser opens Customer Web at
///                                     the very same `/join` route.
///   * In-app QR scanner            -> [parseQrPayload] recognises the exact
///                                     same HTTPS URL and routes internally.
///
/// The legacy `queueflow://join?...` custom scheme remains supported for
/// backwards compatibility with already-printed QR codes and existing deep
/// links, but it is no longer the primary format.
///
/// ## Configuring the production domain
///
/// The allowlist of trusted join hosts is supplied at build time:
///
///   flutter build apk --dart-define=QUEUEFLOW_JOIN_HOSTS=join.example.com
///
/// Comma-separated, host only (no scheme, no path). When it is not supplied the
/// app trusts only the local development hosts, so an unconfigured production
/// build cannot accidentally accept a QR from an arbitrary domain.
library;

/// The single canonical path for customer queue-join links.
const String kCanonicalJoinPath = '/join';

/// The legacy custom scheme, kept for backwards compatibility.
const String kLegacyJoinScheme = 'queueflow';

/// Hosts trusted during local development.
///
/// `10.0.2.2` is the Android emulator's alias for the host machine, so a QR
/// scanned in the emulator can point at a dev server running on the laptop.
const Set<String> kDevJoinHosts = <String>{
  'localhost',
  '127.0.0.1',
  '10.0.2.2',
};

/// Production join hosts, injected at build time.
///
/// Empty when the app was built without
/// `--dart-define=QUEUEFLOW_JOIN_HOSTS=<host>[,<host>...]`.
const String _joinHostsFromEnv = String.fromEnvironment('QUEUEFLOW_JOIN_HOSTS');

/// Whether this build has been given a production customer-web domain.
///
/// When false, an inbound link from a non-local host is rejected. This is a
/// deliberate fail-closed default: a mis-built release must not accept join
/// links from arbitrary domains.
final bool hasConfiguredProductionJoinHost = _joinHostsFromEnv.trim().isNotEmpty;

/// The effective allowlist of hosts that may carry a canonical join link.
final Set<String> queueflowJoinHosts = <String>{
  ...kDevJoinHosts,
  ..._parseHostList(_joinHostsFromEnv),
};

Set<String> _parseHostList(String raw) {
  final hosts = <String>{};
  for (final part in raw.split(',')) {
    final host = part.trim().toLowerCase();
    // Tolerate a full URL being pasted in as the define value, scheme and any
  // trailing path included, e.g. "https:" + "//join.example.com/".
    final withoutScheme = host.replaceFirst(RegExp(r'^https?://'), '');
    final hostOnly = withoutScheme.split('/').first.trim();
    if (hostOnly.isNotEmpty) hosts.add(hostOnly);
  }
  return hosts;
}

/// Whether [host] is a host this build is willing to accept a join link from.
bool isAllowedJoinHost(String? host) {
  if (host == null) return false;
  return queueflowJoinHosts.contains(host.trim().toLowerCase());
}

/// Whether a plain-HTTP scheme is acceptable for [host].
///
/// Cleartext HTTP is tolerated only for local development hosts. Production
/// join links must be HTTPS.
bool isAllowedJoinScheme(String scheme, String? host) {
  if (scheme == 'https') return true;
  if (scheme == 'http') return kDevJoinHosts.contains(host?.trim().toLowerCase());
  return false;
}
