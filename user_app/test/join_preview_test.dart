import 'dart:async';
import 'dart:io';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:user_app/core/network/api_exception.dart';
import 'package:user_app/core/network/network_status.dart';
import 'package:user_app/models/join_preview_data.dart';
import 'package:user_app/models/operating_hours.dart';
import 'package:user_app/models/queue_status.dart';
import 'package:user_app/models/service.dart';
import 'package:user_app/models/service_center.dart';
import 'package:user_app/providers/app_providers.dart';
import 'package:user_app/providers/auth_provider.dart';
import 'package:user_app/providers/document_gate_provider.dart';
import 'package:user_app/providers/join_preview_provider.dart';
import 'package:user_app/providers/token_provider.dart';
import 'package:user_app/screens/queue/queue_preview_screen.dart';
import 'package:user_app/services/api_service.dart';
import 'package:user_app/services/socket_service.dart';
import 'package:user_app/widgets/join/join_confirmation_sheet.dart';
import 'package:user_app/widgets/join/join_success_overlay.dart';

import 'harness.dart';

/// Step 19 — the SCAN TO JOIN preview and its confirmation.
///
/// Three separate claims are under test here, and they are kept apart on
/// purpose:
///
///   1. **Where the data comes from.** Every number on the preview is a value
///      the backend returned. The load order matters: the centre, then the
///      centre's *own* active-service list, then the queue — so a QR that names
///      something the centre does not offer fails before any queue is read,
///      rather than rendering a plausible-looking empty queue.
///   2. **Where the countdown comes from.** Only `ServiceCenter.operatingHours`.
///      When no authoritative closing time exists the result is a plain status
///      and **no timer**; no default close time is ever substituted, because a
///      countdown nobody configured is a lie told to a customer in a queue.
///   3. **What the CTA refuses to do.** It is disabled only by an authoritative
///      signal — the Document Gate, the backend's own open/active/status
///      checks, connectivity for a mutation, or a configured window that has
///      passed. Crowd level is never a reason, because the backend does not
///      restrict joining by crowd.
void main() {
  late FakeApiService api;
  late NetworkStatus network;
  late TestAuthNotifier auth;
  late ProviderContainer container;

  /// A Wednesday at 14:00, used wherever a window has to be resolved against a
  /// fixed instant instead of the wall clock.
  final wednesday = DateTime(2026, 9, 23, 14);

  Service passport() => Service.fromJson(const {
        '_id': kServiceId,
        'name': 'Passport Services',
        'code': 'PASS',
        'centerId': kCenterId,
        'isActive': true,
        'tokenPrefix': 'P',
        'avgServiceTimeMinutes': 12,
      });

  ServiceCenter openCenter({List<Map<String, dynamic>> hours = const []}) =>
      ServiceCenter.fromJson(
        serviceCenterJson(
          name: 'Test Center',
          isOpen: true,
          operatingHours: hours,
        ),
      );

  JoinPreviewRequest request() =>
      const JoinPreviewRequest(centerId: kCenterId, serviceId: kServiceId);

  setUp(() {
    network = NetworkStatus();
    api = FakeApiService(Dio(), networkStatus: network);
    final storage = FakeStorageService();
    final socket = SocketService();
    auth = TestAuthNotifier(
      apiService: api,
      storageService: storage,
      socketService: socket,
    );
    api.centerDetails[kCenterId] = openCenter();
    api.services = [passport()];
    api.queueStatuses = [
      QueueStatus.fromJson(
        queueSummaryJson(
          serviceId: kServiceId,
          serviceName: 'Passport Services',
          waitingCount: 4,
          estimatedWaitMinutes: 18,
        ),
      ),
    ];
    api.queueDetails = serviceQueueJson(
      queueStatus: 'OPEN',
      waitingCount: 4,
      activeCount: 2,
      estimatedWaitMinutes: 18,
      waitingTokens: [queueTokenJson(tokenCode: 'P-021', tokenNumber: 21)],
      servingToken: queueTokenJson(
        id: '507f1f77bcf86cd7994390e1',
        tokenCode: 'P-018',
        tokenNumber: 18,
        status: 'SERVING',
      ),
      activeCounters: [activeCounterJson(currentToken: 'P-018')],
    );
    container = ProviderContainer(
      overrides: [
        storageServiceProvider.overrideWithValue(storage),
        apiServiceProvider.overrideWithValue(api),
        socketServiceProvider.overrideWithValue(socket),
        authProvider.overrideWith((ref) => auth),
      ],
    );
  });

  tearDown(() {
    container.dispose();
    network.dispose();
  });

  // ─── 1. The joining window: the only source of a countdown ─────────────────

  group('The joining window comes from configured hours, or not at all', () {
    test('a center with no configured hours shows no countdown at all', () {
      // The schema default: `operatingHours` is an optional array, so most
      // centers have none. That is the case a fake timer would be invented for.
      final window = OperatingHoursWindowResolver.resolve(null, wednesday);
      expect(window, isA<JoiningWindowUnconfigured>());
      expect(window.hasCountdown, isFalse);

      // `wednesday` really is a Wednesday, so the day that is *not* today has to
      // be named explicitly. A WED entry here would legitimately resolve.
      expect(
        OperatingHoursWindowResolver.resolve(
          [OperatingHoursDay.fromJson(operatingHoursDay(day: 'THU'))],
          wednesday,
        ),
        isA<JoiningWindowUnconfigured>(),
        reason: 'hours for a day that is not today are not today\'s window',
      );

      // And a center with an entry for every *other* day is still unconfigured.
      expect(
        OperatingHoursWindowResolver.resolve(
          [
            OperatingHoursDay.fromJson(operatingHoursDay(day: 'MON')),
            OperatingHoursDay.fromJson(operatingHoursDay(day: 'TUE')),
          ],
          wednesday,
        ),
        isA<JoiningWindowUnconfigured>(),
      );
    });

    test('configured hours for today resolve a real closing instant', () {
      final window = OperatingHoursWindowResolver.resolve(
        [
          OperatingHoursDay.fromJson(
            operatingHoursDay(day: 'WED', open: '09:00', close: '17:00'),
          ),
        ],
        wednesday,
      );

      expect(window, isA<JoiningWindowOpen>());
      final open = window as JoiningWindowOpen;
      expect(open.hasCountdown, isTrue);
      expect(open.opensAt, DateTime(2026, 9, 23, 9));
      expect(open.closesAt, DateTime(2026, 9, 23, 17));
      expect(open.remaining, const Duration(hours: 3));
      expect(open.remaining.isNegative, isFalse);
    });

    test('a day the center does not operate has no closing instant', () {
      final closed = OperatingHoursWindowResolver.resolve(
        [
          OperatingHoursDay.fromJson(
            operatingHoursDay(day: 'WED', isClosed: true),
          ),
        ],
        wednesday,
      );
      expect(closed, isA<JoiningWindowNotScheduled>());
      expect(closed.hasCountdown, isFalse, reason: 'a closed day has nothing to count down to');
      expect((closed as JoiningWindowNotScheduled).reason, contains('Wednesdays'));

      // A day with unusable times is equally not a deadline. The admin saved
      // something unparseable; that must not become a countdown.
      final broken = OperatingHoursWindowResolver.resolve(
        [
          OperatingHoursDay.fromJson(
            operatingHoursDay(day: 'WED', open: '9am', close: '5pm'),
          ),
        ],
        wednesday,
      );
      expect(broken, isA<JoiningWindowNotScheduled>());
      expect(broken.hasCountdown, isFalse);

      // Ambiguous data is refused rather than guessed.
      expect(
        OperatingHoursWindowResolver.resolve(
          [
            OperatingHoursDay.fromJson(operatingHoursDay(day: 'WED')),
            OperatingHoursDay.fromJson(operatingHoursDay(day: 'WED', open: '10:00')),
          ],
          wednesday,
        ),
        isA<JoiningWindowUnconfigured>(),
      );
    });

    test('a window that has already closed reports elapsed time, never negative', () {
      final window = OperatingHoursWindowResolver.resolve(
        [
          OperatingHoursDay.fromJson(
            operatingHoursDay(day: 'WED', open: '09:00', close: '12:00'),
          ),
        ],
        wednesday,
      );

      expect(window, isA<JoiningWindowClosedAfterClose>());
      final closed = window as JoiningWindowClosedAfterClose;
      expect(closed.closedAt, DateTime(2026, 9, 23, 12));
      expect(closed.elapsed, const Duration(hours: 2));
      expect(closed.hasCountdown, isTrue);

      // The window is open right up to the closing instant, and the closing
      // instant itself already counts as closed. Resolving 14:00 against a
      // 14:00 close is not a rounding case; it is a centre that has shut.
      final lastMinute = OperatingHoursWindowResolver.resolve(
        [
          OperatingHoursDay.fromJson(
            operatingHoursDay(day: 'WED', open: '09:00', close: '14:01'),
          ),
        ],
        wednesday,
      );
      expect(lastMinute, isA<JoiningWindowOpen>());
      expect((lastMinute as JoiningWindowOpen).remaining, const Duration(minutes: 1));

      final atClose = OperatingHoursWindowResolver.resolve(
        [
          OperatingHoursDay.fromJson(
            operatingHoursDay(day: 'WED', open: '09:00', close: '14:00'),
          ),
        ],
        wednesday,
      );
      expect(atClose, isA<JoiningWindowClosedAfterClose>());
      expect((atClose as JoiningWindowClosedAfterClose).elapsed, Duration.zero);
    });

    test('an overnight window counts down into the following day', () {
      // Close at or before open means the centre runs past midnight, so the
      // closing instant belongs to tomorrow. Reading it as 09:00 tonight would
      // report the window as already over.
      final night = OperatingHoursWindowResolver.resolve(
        [
          OperatingHoursDay.fromJson(
            operatingHoursDay(day: 'WED', open: '20:00', close: '02:00'),
          ),
        ],
        wednesday,
      );
      expect(night, isA<JoiningWindowOpen>());
      final open = night as JoiningWindowOpen;
      expect(open.closesAt, DateTime(2026, 9, 24, 2));
      expect(open.remaining, const Duration(hours: 12));

      // On the Thursday after, with no THU entry configured, the resolver has
      // nothing authoritative left to count to — and says exactly that. It does
      // not carry Wednesday's closing time into a day no admin configured, and
      // it does not invent an open/closed verdict either: whether the centre is
      // open at all is the backend's own `isOpen` flag, read separately.
      final after = OperatingHoursWindowResolver.resolve(
        [
          OperatingHoursDay.fromJson(
            operatingHoursDay(day: 'WED', open: '20:00', close: '02:00'),
          ),
        ],
        DateTime(2026, 9, 24, 3),
      );
      expect(after, isA<JoiningWindowUnconfigured>());
      expect(after.hasCountdown, isFalse);
    });
  });

  // ─── 2. The load: what the backend is asked, and in what order ─────────────

  group('The preview is assembled from the backend, in the order it can answer', () {
    test('a preview is the centre, the centre\'s own service, and the queue',
        () async {
      final data = await loadJoinPreview(api, request());

      expect(data.center.id, kCenterId);
      expect(data.service.id, kServiceId);
      // Every figure below came out of `GET /api/queue/:centerId/:serviceId`.
      expect(data.waitingCount, 4);
      expect(data.estimatedWaitMinutes, 18, reason: 'the backend EWT engine, verbatim');
      expect(data.queueStatus, 'OPEN');
      expect(data.activeCount, 2);
      expect(data.nowServingTokenCode, 'P-018');
      expect(data.nextTokenCode, 'P-021');
      expect(data.liveCounterCount, 1);
      expect(data.peopleAhead, 4, reason: 'first-come, first-served: nobody is ahead of an unissued token');
      expect(data.fetchedAt, isNotNull, reason: 'the snapshot is dated so staleness can be shown');

      // All three calls really happened, in the order the screen depends on.
      expect(api.centerDetailCalls, 1);
      expect(api.serviceListCalls, 1);
      expect(api.queuePreviewCalls, 1);
    });

    test('a service this center does not publish fails before the queue is read',
        () async {
      // The centre runs exactly one active service. The QR names a second one,
      // which is a real possibility: a printed code can outlive the service
      // menu it was generated from.
      api.services = [passport()];

      final failure = await _failureOf(
        api,
        const JoinPreviewRequest(centerId: kCenterId, serviceId: kTargetServiceId),
      );

      expect(failure, isA<JoinPreviewInvalidService>());
      expect(api.queuePreviewCalls, 0, reason: 'a queue the center does not run must not be read at all');
    });

    test('a service deactivated in the center\'s own list is reported inactive',
        () async {
      api.services = [
        Service.fromJson(const {
          '_id': kServiceId,
          'name': 'Passport Services',
          'centerId': kCenterId,
          'isActive': false,
        }),
      ];

      final failure = await _failureOf(api, request());

      expect(failure, isA<JoinPreviewServiceInactive>());
      expect((failure as JoinPreviewServiceInactive).service.name, 'Passport Services');
      expect(api.queuePreviewCalls, 0);
    });

    test('an unknown center is an invalid center, never a blank preview', () async {
      final failure = await _failureOf(
        api,
        const JoinPreviewRequest(centerId: '507f1f77bcf86cd7994390ff', serviceId: kServiceId),
      );

      expect(
        failure,
        isA<JoinPreviewInvalidCenter>(),
        reason: 'the endpoint 404s, and the QR points at a centre that is gone',
      );
      expect(api.serviceListCalls, 0, reason: 'the centre is checked first');
      expect(api.queuePreviewCalls, 0);
    });

    test('a closed center fails before the queue is read', () async {
      api.centerDetails[kCenterId] = ServiceCenter.fromJson(
        serviceCenterJson(name: 'Test Center', isOpen: false),
      );

      final failure = await _failureOf(api, request());

      expect(failure, isA<JoinPreviewCenterClosed>());
      expect(api.queuePreviewCalls, 0, reason: 'there is no queue worth showing for a closed centre');
    });

    test('a center-only request asks the customer to choose a service', () async {
      // The centre-only QR has no single queue to show. Inventing one — say, the
      // alphabetically first service — would put a customer in a queue they did
      // not choose.
      final failure = await _failureOf(
        api,
        const JoinPreviewRequest(centerId: kCenterId),
      );

      expect(failure, isA<JoinPreviewNoServiceSelected>());
      expect(api.queuePreviewCalls, 0);
    });
  });

  // ─── 3. Failure classification: the backend's own words survive ───────────

  group('A failure is reported as the failure it is', () {
    test('a 404 naming a service is an invalid service; a 404 that does not is an invalid centre',
        () {
      // The exact strings `queueService` throws, because guessing at the
      // backend's wording here would make the mapping wrong in production.
      expect(
        classifyJoinPreviewError(
          ApiException(message: 'Service not found', statusCode: 404),
        ),
        isA<JoinPreviewInvalidService>(),
      );
      expect(
        classifyJoinPreviewError(
          ApiException(message: 'Service center not found', statusCode: 404),
        ),
        isA<JoinPreviewInvalidCenter>(),
        reason: 'the backend\'s own wording for a missing centre contains the word "service"',
      );
      // A 404 that names neither is a missing centre, the only thing the QR
      // itself can have got wrong at this stage.
      expect(
        classifyJoinPreviewError(
          ApiException(message: 'Token not found', statusCode: 404),
        ),
        isA<JoinPreviewInvalidCenter>(),
      );
      expect(
        classifyJoinPreviewError(
          ApiException(message: 'Service is not currently available', statusCode: 400),
        ),
        isA<JoinPreviewInvalidService>(),
        reason: 'the backend refusing a deactivated service is that specific case',
      );
    });

    test('a transport failure is a network problem and a refusal keeps the server\'s words', () {
      final network_ = classifyJoinPreviewError(
        const SocketException('Failed host lookup: queue-flow-4308.onrender.com'),
      );
      expect(network_, isA<JoinPreviewNetworkError>());
      // The copy shown to the customer contains no exception text, so the flag
      // has to be carried rather than sniffed out of the message.
      expect((network_ as JoinPreviewNetworkError).isSocketIssue, isTrue);
      expect(network_.message, isNot(contains('host lookup')));

      expect(
        classifyJoinPreviewError(TimeoutException('no response')),
        isA<JoinPreviewNetworkError>(),
      );

      // A refusal is surfaced in the backend's own wording, not paraphrased into
      // something the backend never said — and not re-labelled as a bad service
      // either, which would send the customer back to the service list for a
      // queue that is only paused.
      final refused = classifyJoinPreviewError(
        ApiException(
          message: 'This queue is currently not accepting new tokens',
          statusCode: 400,
        ),
      );
      expect(refused, isA<JoinPreviewUnexpectedError>());
      expect(
        (refused as JoinPreviewUnexpectedError).message,
        'This queue is currently not accepting new tokens',
      );

      expect(
        classifyJoinPreviewError(
          ApiException(message: 'Service center is currently closed', statusCode: 400),
        ),
        isA<JoinPreviewUnexpectedError>(),
        reason: 'the load already read `center.isOpen`, so this has no state of its own to render',
      );

      // A duplicate active token is a join-time condition, not a load failure.
      expect(
        classifyJoinPreviewError(
          ApiException(message: 'You already have an active token', statusCode: 409, code: 'ACTIVE_TOKEN_EXISTS'),
        ),
        isA<JoinPreviewUnexpectedError>(),
      );
    });
  });

  // ─── 4. Data fidelity: nothing on screen is computed on the device ────────

  group('What the screen shows is what the server sent', () {
    test('a missing estimated wait stays missing and is never derived', () async {
      // The realistic case: the EWT engine has not settled for a fresh queue.
      // waitingCount x avgServiceTime would be a made-up number presented to a
      // customer deciding whether to walk home.
      api.queueDetails = serviceQueueJson(queueStatus: 'OPEN', waitingCount: 4);

      final data = await loadJoinPreview(api, request());

      expect(data.waitingCount, 4);
      expect(data.estimatedWaitMinutes, isNull);
      expect(data.resolveWindow(wednesday), isA<JoiningWindowUnconfigured>());

      // A real figure is passed through untouched, even an implausible one.
      api.queueDetails = serviceQueueJson(
        queueStatus: 'OPEN',
        waitingCount: 0,
        estimatedWaitMinutes: 0,
      );
      final zero = await loadJoinPreview(api, request());
      expect(zero.estimatedWaitMinutes, 0, reason: 'the server said zero, so zero is shown');

      api.queueDetails = serviceQueueJson(queueStatus: 'OPEN', waitingCount: 2, estimatedWaitMinutes: 240);
      final large = await loadJoinPreview(api, request());
      expect(large.estimatedWaitMinutes, 240, reason: 'never clamped away from a real value');
    });

    test('the next token is the server\'s own first waiting token', () async {
      api.queueDetails = serviceQueueJson(
        queueStatus: 'OPEN',
        waitingCount: 3,
        waitingTokens: [
          queueTokenJson(tokenCode: 'P-022', tokenNumber: 22),
          queueTokenJson(tokenCode: 'P-023', tokenNumber: 23),
        ],
        // No serving token, but the called list is present: the fallback is the
        // server's own ordering, not a guess.
        calledTokens: [queueTokenJson(tokenCode: 'P-019', tokenNumber: 19, status: 'SERVING')],
      );

      final data = await loadJoinPreview(api, request());

      expect(data.nextTokenCode, 'P-022', reason: 'waitingTokens[0], already ordered by the server');
      expect(data.nowServingTokenCode, 'P-019', reason: 'servingToken is absent, so calledTokens[0] is used');

      // An empty queue says so; it does not borrow a code from elsewhere.
      api.queueDetails = serviceQueueJson(queueStatus: 'OPEN', waitingCount: 0);
      final empty = await loadJoinPreview(api, request());
      expect(empty.nextTokenCode, isNull);
      expect(empty.nowServingTokenCode, isNull);
    });

    test('joinability follows the backend\'s own checks and never the crowd', () async {
      // A full hall is not a reason the backend refuses a join, so the client
      // must not invent one.
      api.centerDetails[kCenterId] = ServiceCenter.fromJson(
        serviceCenterJson(
          isOpen: true,
          currentCrowd: 100,
          capacity: 100,
          crowdStatus: 'FULL',
          crowdPercent: 100,
        ),
      );
      expect((await loadJoinPreview(api, request())).isServiceJoinable, isTrue);

      // Queue paused: still reported by the endpoint, so still a refusal.
      api.queueDetails = serviceQueueJson(queueStatus: 'PAUSED', waitingCount: 4);
      expect((await loadJoinPreview(api, request())).isServiceJoinable, isFalse);

      // An absent queue status is not read as "not open": the endpoint simply
      // had no Queue document yet, which is not the same as a refusal.
      api.queueDetails = serviceQueueJson(waitingCount: 4);
      expect((await loadJoinPreview(api, request())).isServiceJoinable, isTrue);

      // A closed centre and a deactivated service never reach a preview at all
      // — `loadJoinPreview` refuses both before reading the queue — so there is
      // no live screen carrying a disabled CTA for them. The predicate keeps
      // those two checks anyway, because the backend re-verifies them when the
      // customer finally taps JOIN and either can change in between.
      final closedCenter = JoinPreviewData(
        center: ServiceCenter.fromJson(serviceCenterJson(isOpen: false)),
        service: passport(),
        fetchedAt: wednesday,
        queueStatus: 'OPEN',
      );
      expect(closedCenter.isServiceJoinable, isFalse);

      final inactiveService = JoinPreviewData(
        center: openCenter(),
        service: Service.fromJson(const {
          '_id': kServiceId,
          'name': 'Passport Services',
          'centerId': kCenterId,
          'isActive': false,
        }),
        fetchedAt: wednesday,
        queueStatus: 'OPEN',
      );
      expect(inactiveService.isServiceJoinable, isFalse);
    });
  });

  // ─── 5. The centre-only chooser ────────────────────────────────────────────

  group('The service chooser lists what the centre actually runs', () {
    test('the chooser pairs each service with the live queue numbers for it', () async {
      api.services = [
        passport(),
        Service.fromJson(const {
          '_id': kNextServiceId,
          'name': 'Birth Certificate',
          'centerId': kCenterId,
          'isActive': true,
        }),
      ];
      api.queueStatuses = [
        QueueStatus.fromJson(
          queueSummaryJson(
            serviceId: kServiceId,
            serviceName: 'Passport Services',
            waitingCount: 4,
            estimatedWaitMinutes: 18,
          ),
        ),
        // Deliberately no entry for the second service: the backend filters
        // `isActive: true` server-side, and a service with no Queue document
        // yet is a real state. It must appear with no numbers, not with zeroes.
      ];

      final selection = await loadJoinServiceSelection(api, kCenterId);

      expect(selection.center.id, kCenterId);
      expect(selection.options.map((o) => o.service.name), [
        'Passport Services',
        'Birth Certificate',
      ]);
      expect(selection.options.first.waitingCount, 4);
      expect(selection.options.first.estimatedWaitMinutes, 18);
      // The backend filters `isActive: true` server-side, so a service with no
      // Queue document yet appears with no numbers rather than with zeroes.
      expect(selection.options.last.waitingCount, isNull);
      expect(selection.options.last.estimatedWaitMinutes, isNull);
    });

    test('an unreachable queue feed still lists the services, with no invented zero', () async {
      api.queueStatusError = ApiException(message: 'Queue service unavailable', statusCode: 503);

      final selection = await loadJoinServiceSelection(api, kCenterId);

      expect(api.queueStatusCalls, 1);
      expect(selection.options, hasLength(1));
      expect(selection.options.single.service.name, 'Passport Services');
      expect(
        selection.options.single.waitingCount,
        isNull,
        reason: '"0 waiting" would be a claim about a queue nobody asked',
      );
    });
  });

  // ─── 6. The screen: the sticky CTA, the confirmation, the success overlay ──

  group('The sticky CTA only ever refuses for an authoritative reason', () {
    /// Mounts the real preview screen on a surface tall enough to build it all.
    ///
    /// Hosted by a real [GoRouter] rather than a plain [MaterialApp], because
    /// the screen navigates with `context.go`/`context.pop` exactly as it does in
    /// the app — the success overlay's hand-over to the live-token screen runs
    /// through it, and a bare `MaterialApp` would throw there instead of
    /// testing anything.
    ///
    /// The container is the one this test owns, so the screen can be driven
    /// from the same providers the app uses. Unmounting is the caller's last
    /// statement: the container is disposed in `tearDown`, and disposing it
    /// while the tree is still mounted turns a real failure into a stray
    /// GlobalKey clash.
    ///
    /// Each call starts by unmounting whatever was there. `joinPreviewProvider`
    /// is `autoDispose`, so a re-pump over a still-mounted screen would keep the
    /// previous snapshot alive and quietly assert against stale data.
    Future<void> pumpPreview(
      WidgetTester tester, {
      ServiceCenter? center,
      Map<String, dynamic>? readiness,
    }) async {
      tester.view.physicalSize = const Size(1200, 3600);
      tester.view.devicePixelRatio = 3.0;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);

      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pump();

      api.centerDetails[kCenterId] = center ?? openCenter();
      if (readiness != null) api.readiness = readiness;

      // Invalidate the preview provider so the new screen re-fetches
      // the center from the updated api centerDetails instead of
      // using a stale autoDispose snapshot from the previous call.
      container.invalidate(joinPreviewProvider(request()));

      final router = GoRouter(
        initialLocation: '/join/preview',
        routes: [
          GoRoute(
            path: '/join/preview',
            builder: (context, state) => const QueuePreviewScreen(
              centerId: kCenterId,
              serviceId: kServiceId,
            ),
          ),
          GoRoute(
            path: '/join/services',
            builder: (context, state) => const Scaffold(body: Text('CHOOSER')),
          ),
          GoRoute(
            path: '/token/live',
            builder: (context, state) => const Scaffold(body: Text('LIVE TOKEN')),
          ),
        ],
      );
      addTearDown(router.dispose);

      await tester.pumpWidget(
        UncontrolledProviderScope(
          container: container,
          child: MaterialApp.router(routerConfig: router),
        ),
      );
      await tester.pumpAndSettle();

      // The Document Gate is app state, not per-screen state, exactly as in
      // production. It is therefore re-read from the backend here rather than
      // assumed to re-check itself on the new mount.
      if (readiness != null) {
        await container.read(documentGateProvider.notifier).check(kServiceId);
        await tester.pumpAndSettle();
      }
    }

    /// The label on the disabled sticky CTA, or null while it is live.
    ///
    /// Searched by descendant rather than by `ElevatedButton.child`, because the
    /// label is scaled down by a [FittedBox] to fit the widest refusal reason on
    /// a narrow phone — so the child is the `FittedBox`, not the [Text].
    String? ctaLabel(WidgetTester tester) {
      for (final element in find.byType(ElevatedButton).evaluate()) {
        final button = element.widget as ElevatedButton;
        if (button.onPressed != null) continue;
        final label = _firstTextData(element);
        if (label != null) return label;
      }
      return null;
    }

    testWidgets('with no configured hours the CTA is live and no timer is shown',
        (tester) async {
      await pumpPreview(tester);

      expect(
        tester
            .widget<ElevatedButton>(
              find.widgetWithText(ElevatedButton, 'JOIN QUEUE').first,
            )
            .onPressed,
        isNotNull,
        reason: 'open centre, active service, open queue, gate ready',
      );

      // The queue figures are the backend's, and nothing was created.
      expect(find.text('4'), findsWidgets, reason: 'queue.waitingCount');
      expect(find.text('~18 min'), findsWidgets, reason: 'estimatedWaitMinutes');
      expect(find.text('P-018'), findsWidgets, reason: 'servingToken');
      expect(find.text('P-021'), findsWidgets, reason: 'waitingTokens[0]');
      expect(api.joinCalls, 0, reason: 'viewing a queue is not joining it');

      // The truth contract: no configured closing time, so a plain status and
      // not one invented timer.
      expect(find.text('CENTER OPEN'), findsWidgets);
      expect(find.text('CLOSES IN'), findsNothing);
      expect(
        find.textContaining('No countdown is shown because the service center has no'),
        findsOneWidget,
      );

      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pump();
    });

    testWidgets('a closed window, an offline device and a document refusal each say why',
        (tester) async {
      // ── The configured window for today has already passed.
      final now = DateTime.now();
      final closesAgo = now.subtract(const Duration(minutes: 1));
      final closedHours = [
        operatingHoursDay(
          day: OperatingHoursDay.codeFor(now),
          open: '00:00',
          close: OperatingHoursDay.formatHhMm(closesAgo.hour * 60 + closesAgo.minute),
        ),
      ];
      // Stated as a precondition, so a pathological clock reads as such rather
      // than looking like a product failure.
      expect(
        openCenter(hours: closedHours).resolveJoiningWindow(now),
        isA<JoiningWindowClosedAfterClose>(),
        reason: 'the fixture must describe a window that really has closed',
      );

      await pumpPreview(tester, center: openCenter(hours: closedHours));
      expect(find.text('QUEUE JOINING CLOSED'), findsWidgets);
      expect(
        find.textContaining('Pull down to refresh status'),
        findsOneWidget,
        reason: 'a closed window is a status, not a dead end: it says how to re-check',
      );
      expect(ctaLabel(tester), 'QUEUE JOINING CLOSED');

      // ── The Document Gate is the only client-side document reason, and it is
      // the backend's own verdict rather than a client computation.
      await pumpPreview(
        tester,
        center: openCenter(),
        readiness: {
          'isReady': false,
          'status': 'INCOMPLETE',
          'checklist': [
            {
              'documentType': 'AADHAAR',
              'label': 'Aadhaar card',
              'isRequired': true,
              'isUploaded': false,
            },
          ],
          'missingRequirements': [
            {'documentType': 'AADHAAR', 'reason': 'Document not uploaded'},
          ],
        },
      );
      expect(api.readinessCalls, greaterThan(0));
      expect(ctaLabel(tester), 'DOCUMENTS REQUIRED');

      // It clears on the backend's next word, with no reload and no client guess.
      api.readiness = {
        'isReady': true,
        'status': 'READY',
        'checklist': [
          {
            'documentType': 'AADHAAR',
            'label': 'Aadhaar card',
            'isRequired': true,
            'isUploaded': true,
          },
        ],
        'missingRequirements': <dynamic>[],
      };
      await container.read(documentGateProvider.notifier).check(kServiceId);
      await tester.pumpAndSettle();
      expect(find.text('DOCUMENTS REQUIRED'), findsNothing);
      expect(ctaLabel(tester), isNull, reason: 'a satisfied gate re-enables joining');

      // ── Offline: a real transport failure means the centre cannot issue a
      // token, so joining is refused rather than faked.
      network.markUnreachable();
      await container.read(tokenProvider.notifier).fetchActiveToken();
      await tester.pumpAndSettle();
      expect(ctaLabel(tester), 'UNAVAILABLE OFFLINE');
      expect(
        find.textContaining('Joining needs a live connection'),
        findsOneWidget,
      );
      expect(api.joinCalls, 0, reason: 'no token is ever created while offline');

      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pump();
    });

    testWidgets('the confirmation sheet asks before anything is created', (tester) async {
      await pumpPreview(tester);

      await tester.tap(find.widgetWithText(ElevatedButton, 'JOIN QUEUE').first);
      await tester.pumpAndSettle();

      // The sheet restates exactly what the customer is committing to, from the
      // same backend snapshot the preview used.
      expect(find.byType(JoinConfirmationSheet), findsOneWidget);
      expect(find.text("You're joining:"), findsOneWidget);
      expect(find.text('Passport Services'), findsWidgets);
      expect(find.text('~18 min'), findsWidgets);
      expect(find.text('4'), findsWidgets);
      expect(find.text('CHANGE SERVICE'), findsOneWidget);
      expect(
        api.joinCalls,
        0,
        reason: 'nothing is created until the customer confirms in the sheet',
      );

      await tester.tap(find.widgetWithText(ElevatedButton, 'JOIN QUEUE').last);
      // `pump`, not `pumpAndSettle`: confirming opens the success overlay, which
      // holds an indeterminate spinner, so no frame ever settles.
      await tester.pump();
      await tester.pump();

      // One tap in the sheet, one request. `_isJoining` is the double-tap guard,
      // and the backend remains the only token authority.
      expect(api.joinCalls, 1);
      expect(find.text("YOU'RE IN THE QUEUE"), findsOneWidget);
      expect(find.text('A-014'), findsOneWidget, reason: 'the token the server issued');

      // The overlay auto-dismisses on a timer, and the container is disposed in
      // `tearDown`. Let that timer fire before unmounting, or the test framework
      // reports a pending timer rather than the behaviour under test.
      await tester.pump(const Duration(seconds: 3));
      expect(
        find.text('LIVE TOKEN'),
        findsOneWidget,
        reason: 'the hand-over goes to the app\'s own live-token screen, not a route of its own',
      );

      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pump();
    });

    testWidgets('the success overlay shows only what the backend returned', (tester) async {
      tester.view.physicalSize = const Size(1200, 3600);
      tester.view.devicePixelRatio = 3.0;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);

      /// Mounts a launcher that opens [JoinSuccessOverlay] and drives it for
      /// [for_] — pumping only, because the overlay holds an indeterminate
      /// spinner and no frame ever settles.
      ///
      /// A fresh `MaterialApp` with a fresh [UniqueKey] per invocation: the
      /// overlay is pushed on the app's `Navigator`, so a second one against the
      /// same navigator would sit on top of the first dialog rather than
      /// replacing it.
      Future<void> showOverlay({
        required Duration for_,
        String tokenCode = 'P-042',
        String serviceName = 'Passport Services',
        int? position,
        int? estimatedWaitMinutes,
        VoidCallback? onContinue,
      }) async {
        await tester.pumpWidget(
          MaterialApp(
            key: UniqueKey(),
            home: Builder(
              builder: (context) => Scaffold(
                body: Center(
                  child: ElevatedButton(
                    onPressed: () => JoinSuccessOverlay.show(
                      context,
                      // Exactly what the backend returned with the token.
                      tokenCode: tokenCode,
                      serviceName: serviceName,
                      position: position,
                      estimatedWaitMinutes: estimatedWaitMinutes,
                      displayDuration: const Duration(milliseconds: 300),
                      onContinue: onContinue ?? () {},
                    ),
                    child: const Text('SHOW'),
                  ),
                ),
              ),
            ),
          ),
        );
        await tester.tap(find.text('SHOW'));
        await tester.pump();
        await tester.pump(for_);
      }

      var continued = false;
      await showOverlay(
        for_: const Duration(milliseconds: 300),
        tokenCode: 'P-042',
        position: 7,
        estimatedWaitMinutes: 25,
        onContinue: () => continued = true,
      );

      expect(find.text("YOU'RE IN THE QUEUE"), findsOneWidget);
      expect(find.text('P-042'), findsOneWidget);
      expect(find.text('7'), findsOneWidget);
      expect(find.text('~25 min'), findsOneWidget);

      // The overlay hands over to the app's own live-token screen; it never
      // pushes a route itself.
      expect(continued, isTrue);

      // What the server did not send is stated, not filled in.
      await showOverlay(
        for_: const Duration(milliseconds: 500),
        tokenCode: 'P-043',
        serviceName: 'Birth Certificate',
      );

      expect(find.text('P-043'), findsOneWidget);
      expect(find.text('Being assigned'), findsOneWidget);
      expect(find.text('Not reported yet'), findsOneWidget);
    });
  });
}

/// The first [Text] label anywhere beneath [element], or null if it has none.
String? _firstTextData(Element element) {
  String? found;
  element.visitChildren((child) {
    if (found != null) return;
    final widget = child.widget;
    if (widget is Text) {
      found = widget.data;
    } else {
      found = _firstTextData(child);
    }
  });
  return found;
}

/// Runs a load and returns the classified failure it ended in.
///
/// The error is captured into a variable *outside* the `try` on purpose:
/// `fail()` throws a `TestFailure`, so a `fail()` raised inside the `try` would
/// be caught by its own `catch` and reported as a product failure.
Future<JoinPreviewFailure> _failureOf(
  ApiService api,
  JoinPreviewRequest request,
) async {
  Object? thrown;
  try {
    await loadJoinPreview(api, request);
  } catch (error) {
    thrown = error;
  }
  if (thrown == null) {
    fail('expected $request to fail, but it loaded');
  }
  return classifyJoinPreviewError(thrown);
}
