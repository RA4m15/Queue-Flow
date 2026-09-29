import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:user_app/core/network/network_status.dart';
import 'package:user_app/models/token.dart';
import 'package:user_app/providers/app_providers.dart';
import 'package:user_app/providers/token_provider.dart';
import 'package:user_app/screens/token/live_token_screen.dart';
import 'package:user_app/services/socket_service.dart';
import 'harness.dart';

void main() {
  testWidgets('LiveTokenScreen mounts cleanly without modifying provider during build or dispose', (tester) async {
    final network = NetworkStatus();
    final api = FakeApiService(Dio(), networkStatus: network);
    final storage = FakeStorageService();
    final socket = SocketService();

    final notifier = TokenNotifier(
      apiService: api,
      socketService: socket,
      storageService: storage,
    );

    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          apiServiceProvider.overrideWithValue(api),
          tokenProvider.overrideWith((ref) => notifier),
        ],
        child: const MaterialApp(
          home: LiveTokenScreen(),
        ),
      ),
    );

    // Initial frame pump (runs initState and mounts widgets)
    await tester.pump();
    expect(find.byType(LiveTokenScreen), findsOneWidget);

    // Flush any pending post-frame callbacks
    await tester.pump(const Duration(milliseconds: 100));

    // Shows empty state when no active token exists
    expect(find.text('No Active Token'), findsOneWidget);

    // Provide an active called token
    final activeToken = TokenModel.fromJson(tokenJson(
      tokenCode: 'A-042',
      status: 'CALLED',
      centerName: 'Downtown Branch',
      serviceName: 'General Inquiry',
      counterName: 'Counter 02',
      currentPosition: 1,
      initialPosition: 5,
      waitEstimateMinutes: 0,
    ));

    notifier.state = TokenState(
      activeToken: activeToken,
      connectionStatus: 'LIVE',
    );

    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));

    expect(find.text('A-042'), findsOneWidget);
    expect(find.text('Downtown Branch'), findsOneWidget);
    expect(find.text('YOUR TURN!'), findsOneWidget);

    // Unmount to verify dispose() runs without lifecycle exceptions
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          apiServiceProvider.overrideWithValue(api),
          tokenProvider.overrideWith((ref) => notifier),
        ],
        child: const MaterialApp(
          home: Scaffold(body: Text('Unmounted View')),
        ),
      ),
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));

    expect(find.text('Unmounted View'), findsOneWidget);

    network.dispose();
  });
}
