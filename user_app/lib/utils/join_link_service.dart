import 'dart:async';

import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../core/config/join_config.dart';
import 'qr_payload_parser.dart';

/// Inbound customer queue-join links.
///
/// The canonical QR encodes a plain HTTPS URL:
///
///     HOST/join?centerId=ID[&serviceId=ID]
///
/// When the OS opens that URL in this app — Android App Link, iOS Universal
/// Link, or the legacy `queueflow://` scheme — the Flutter engine delivers it
/// as a *route*, never as an app-level callback:
///
///   * Cold start: it becomes
///     [WidgetsBinding.instance.platformDispatcher] `defaultRouteName`.
///   * While already running: the engine calls
///     [WidgetsBindingObserver.didPushRouteInformation].
///
/// This module reads both, classifies them with [classifyJoinLink] — which is
/// the **same** [parseQrPayload] the in-app QR scanner uses, so a link opened by
/// the phone camera and a QR read inside the app produce an identical result —
/// and republishes them so `JoinLinkListener` can act on them.
///
/// Reading the platform route directly is deliberate. go_router reconstructs a
/// matched route's URI relative to the app (`/join?centerId=…`, no host), so
/// validating the router's copy would silently drop the host check and let a
/// link from any domain through. The engine's copy is the only place the real
/// host survives.
class JoinLinkService {
  const JoinLinkService._();
}

/// Classify an inbound link into the same result the QR scanner produces.
///
/// Returns `null` when the link is not a customer queue-join link (a staff
/// check-in link, an unrelated deep link into another part of the app, or a
/// third-party URL). Callers treat `null` as "ignore silently" — opening the
/// app via a link must never interrupt the user with a QR error.
QrJoinPayload? classifyJoinLink(Uri? uri) {
  if (uri == null) return null;
  final result = parseQrPayload(uri.toString());
  if (result is QrJoinPayload) return result;
  return null;
}

/// A join link that has been received but not yet acted upon.
///
/// Held in a provider rather than in a widget so it survives route changes —
/// including the redirect to `/login` that every route in this app applies to
/// an unauthenticated user. Without this, "scan the QR, then sign in" would lose
/// the link and force the customer to find the screen and scan again.
class PendingJoinLink extends Notifier<QrJoinPayload?> {
  @override
  QrJoinPayload? build() => _initialJoinLink;

  void set(QrJoinPayload payload) => state = payload;

  void clear() => state = null;
}

final pendingJoinLinkProvider =
    NotifierProvider<PendingJoinLink, QrJoinPayload?>(PendingJoinLink.new);

/// The in-app route a join link maps onto.
///
/// The engine hands over the absolute URL, so what the router matches is its
/// path. The route exists purely so an inbound link does not render the 404
/// screen while the join flow runs.
String joinLinkLocation() => kCanonicalJoinPath;

// ─── Platform route capture ──────────────────────────────────────────────────

/// The link the OS handed the app at process start, if it was a join link.
QrJoinPayload? _initialJoinLink;

/// Watches for join links arriving from the platform. One instance per app.
final JoinLinkRouteObserver joinLinkRouteObserver = JoinLinkRouteObserver();

/// Read the cold-start route and start watching for later ones.
///
/// Call once from `main()` after `WidgetsFlutterBinding.ensureInitialized()`.
/// Must run before `runApp`, because go_router is given an explicit
/// `initialLocation` and would otherwise never see the launch route.
QrJoinPayload? captureInitialJoinLink() {
  WidgetsBinding.instance.addObserver(joinLinkRouteObserver);

  final routeName =
      WidgetsBinding.instance.platformDispatcher.defaultRouteName;
  final payload = classifyJoinLink(Uri.tryParse(routeName));
  _initialJoinLink = payload;
  return payload;
}

/// Observes platform routes and republishes any customer queue-join link.
///
/// Deliberately does nothing for routes that are not join links. A staff
/// check-in link, an unrelated deep link or a third-party URL leaves the app
/// exactly as it was — never an error sheet, never a "wrong QR" message.
class JoinLinkRouteObserver extends WidgetsBindingObserver {
  final StreamController<QrJoinPayload> _joins =
      StreamController<QrJoinPayload>.broadcast();

  QrJoinPayload? _lastHandled;

  /// Join links as the platform reports them.
  Stream<QrJoinPayload> get joins => _joins.stream;

  @override
  Future<bool> didPushRouteInformation(RouteInformation routeInformation) async {
    handle(routeInformation.uri);
    // False: the app has not "handled" the route in the sense of consuming it.
    // Returning true would stop the default handling, and go_router — which is
    // a separate observer on the same binding — must still see it so the
    // `/join` route matches instead of the 404 page.
    return false;
  }

  @override
  Future<bool> didPushRoute(String route) async {
    handle(Uri.tryParse(route));
    return false;
  }

  /// Classify [uri] and republish it when it is a customer queue-join link.
  ///
  /// Public so the behaviour is testable without a real platform channel.
  @visibleForTesting
  void handle(Uri? uri) {
    final payload = classifyJoinLink(uri);
    if (payload == null) return;

    // The same link can be reported twice on some platforms — once as the
    // initial route and again as a pushed route. Act on it once.
    if (_lastHandled != null &&
        _lastHandled!.centerId == payload.centerId &&
        _lastHandled!.serviceId == payload.serviceId) {
      return;
    }
    _lastHandled = payload;
    if (!_joins.isClosed) _joins.add(payload);
  }

  /// Forget the last handled link, so the next identical scan works.
  @visibleForTesting
  void reset() => _lastHandled = null;
}
