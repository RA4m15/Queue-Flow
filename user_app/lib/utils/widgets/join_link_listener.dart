import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../join_link_service.dart';
import '../qr_payload_parser.dart';

/// Parks inbound App Link / Universal Link payloads for the queue join flow.
///
/// There is one queue-join flow, not two. A link opened from the phone camera
/// and a QR read by the in-app scanner both end up on the same id-bearing
/// queue-preview route, which re-reads the backend itself, and the only path to
/// a token is still an explicit tap on JOIN QUEUE.
///
/// ## Why this widget does not navigate
///
/// It is mounted above the router, in `MaterialApp.router.builder`, so it stays
/// alive across navigation. That position is also why it cannot navigate: a
/// `builder` context sits *above* the [Navigator] and its [Overlay], so
/// `GoRouter.of(context)` and `Overlay.of(context)` are both null there, and
/// calling either would throw. Pushing a route from here is not a matter of
/// finding the right ancestor — the router simply is not in scope.
///
/// So this widget only records the validated payload, and the two consumers
/// that *do* have a router context act on it:
///
///   * the router `redirect`, which turns a link parked before sign-in back
///     into the same centre and service after it (see `app_router.dart`), and
///   * [JoinLinkTransitScreen], the `/join` route's own screen, which hands a
///     warm link to the flow.
///
/// Both derive the destination with [joinRouteFor], so they cannot disagree.
///
/// It waits for authentication on purpose. Every route in this app redirects an
/// unauthenticated user to `/login`, so acting on the link immediately would
/// either fail the backend call or be discarded by the redirect. Holding the
/// link until the user is signed in is what makes "scan the QR, then log in"
/// work — the normal order for a first-time customer.
class JoinLinkListener extends ConsumerStatefulWidget {
  const JoinLinkListener({required this.child, super.key});

  final Widget child;

  @override
  ConsumerState<JoinLinkListener> createState() => _JoinLinkListenerState();
}

class _JoinLinkListenerState extends ConsumerState<JoinLinkListener> {
  StreamSubscription<QrJoinPayload>? _subscription;

  @override
  void initState() {
    super.initState();
    _subscription = joinLinkRouteObserver.joins.listen((payload) {
      // A platform route is an explicit user action (they just scanned a QR),
      // so it is safe to write provider state from the stream callback. This
      // also keeps a link that arrives on a *different* route from being
      // mistaken for one already being handled: parking is unconditional, and
      // only an authenticated consumer takes it.
      ref.read(pendingJoinLinkProvider.notifier).set(payload);
    });
  }

  @override
  void dispose() {
    _subscription?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => widget.child;
}
