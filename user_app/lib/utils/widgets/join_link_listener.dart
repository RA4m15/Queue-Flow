import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../providers/auth_provider.dart';
import '../join_flow_controller.dart';
import '../join_link_service.dart';
import '../qr_payload_parser.dart';

/// Bridges inbound App Link / Universal Link URLs into the existing queue join
/// flow.
///
/// There is one queue-join flow, not two. A link opened from the phone camera
/// and a QR read by the in-app scanner both end up calling
/// [JoinFlowController.handleJoinPayload] with the same [QrJoinPayload], so the
/// resulting behaviour is identical by construction.
///
/// It is mounted above the router in `MaterialApp.router.builder` so it stays
/// alive across navigation and can act the moment the app is in a state where a
/// queue join makes sense.
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
      // so it is safe to write provider state from the stream callback.
      ref.read(pendingJoinLinkProvider.notifier).set(payload);
    });
  }

  @override
  void dispose() {
    _subscription?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final QrJoinPayload? pending = ref.watch(pendingJoinLinkProvider);
    final isAuthenticated = ref.watch(authProvider).isAuthenticated;

    if (pending != null && isAuthenticated) {
      // Clear synchronously so a rebuild cannot start a second identical run;
      // the flow itself pops a loading sheet and navigates.
      ref.read(pendingJoinLinkProvider.notifier).clear();
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted) return;
        joinFlowController(ref).handleJoinPayload(context, pending);
      });
    }

    return widget.child;
  }
}
