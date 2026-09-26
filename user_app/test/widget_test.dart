import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:user_app/core/theme/app_theme.dart';
import 'package:user_app/widgets/token_status_badge.dart';
import 'package:user_app/widgets/crowd_indicator.dart';
import 'package:user_app/widgets/queue_progress_bar.dart';
import 'package:user_app/widgets/empty_state.dart';

void main() {
  Widget wrapWidget(Widget child) {
    return MaterialApp(
      theme: AppTheme.darkTheme,
      home: Scaffold(body: Center(child: child)),
    );
  }

  testWidgets('TokenStatusBadge renders correct status and styling', (WidgetTester tester) async {
    await tester.pumpWidget(wrapWidget(const TokenStatusBadge(status: 'WAITING')));
    expect(find.text('WAITING'), findsOneWidget);

    await tester.pumpWidget(wrapWidget(const TokenStatusBadge(status: 'CALLED')));
    expect(find.text('CALLED'), findsOneWidget);

    await tester.pumpWidget(wrapWidget(const TokenStatusBadge(status: 'SERVING')));
    expect(find.text('SERVING'), findsOneWidget);
  });

  testWidgets('CrowdIndicator displays status and counts', (WidgetTester tester) async {
    await tester.pumpWidget(
      wrapWidget(
        const CrowdIndicator(
          crowdStatus: 'MODERATE',
          currentCrowd: 45,
          capacity: 100,
        ),
      ),
    );

    expect(find.text('Moderate'), findsOneWidget);
    expect(find.text('45 / 100'), findsOneWidget);
  });

  testWidgets('QueueProgressBar renders progress percentage', (WidgetTester tester) async {
    await tester.pumpWidget(
      wrapWidget(
        const QueueProgressBar(
          initialPosition: 10,
          currentPosition: 5,
          status: 'WAITING',
        ),
      ),
    );

    expect(find.text('Queue Progress'), findsOneWidget);
    expect(find.byType(LinearProgressIndicator), findsOneWidget);
  });

  testWidgets('EmptyState renders title, message, and button', (WidgetTester tester) async {
    bool tapped = false;

    await tester.pumpWidget(
      wrapWidget(
        EmptyState(
          title: 'No tokens found',
          message: 'Please join a queue to receive a live token',
          actionLabel: 'Explore Centers',
          onAction: () => tapped = true,
        ),
      ),
    );

    expect(find.text('No tokens found'), findsOneWidget);
    expect(find.text('Please join a queue to receive a live token'), findsOneWidget);
    expect(find.text('Explore Centers'), findsOneWidget);

    await tester.tap(find.text('Explore Centers'));
    expect(tapped, true);
  });
}
