import 'package:flutter/foundation.dart';

import 'firebase_push_messaging_client.dart';
import 'push_messaging_client.dart';

/// Why a push transport could not be booted. Surfaced verbatim to the UI so
/// the app can tell the customer the truth instead of implying push works.
enum PushUnavailableReason {
  /// No Firebase project is configured for this build (no
  /// `google-services.json`, no `GoogleService-Info.plist`).
  notConfigured,

  /// Firebase is configured but the device cannot reach it (typically no
  /// Google Play Services on the device, or an emulator without them).
  deviceUnsupported,
}

extension PushUnavailableReasonX on PushUnavailableReason {
  String get message {
    switch (this) {
      case PushUnavailableReason.notConfigured:
        return 'Push notifications are not configured for this build.';
      case PushUnavailableReason.deviceUnsupported:
        return 'Push notifications are unavailable on this device.';
    }
  }
}

/// The outcome of a push transport boot attempt.
class PushTransportResolution {
  const PushTransportResolution.available(this.client) : reason = null;
  const PushTransportResolution.unavailable(this.reason) : client = null;

  /// The real transport, or null when push cannot be delivered.
  final PushMessagingClient? client;

  /// Why push is unavailable, or null when it is available.
  final PushUnavailableReason? reason;

  bool get isAvailable => client != null;

  /// The text handed to [UnavailablePushMessagingClient.reason] and surfaced
  /// in the UI.
  String get unavailableReason =>
      reason?.message ?? PushUnavailableReason.notConfigured.message;
}

/// Resolves the push transport for this build.
///
/// The whole point of this function is that it has exactly two honest
/// outcomes: a real, configured transport, or an explicit
/// [UnavailablePushMessagingClient]. There is no third path that pretends a
/// registration succeeded.
///
/// [attemptInitialize] is injected so the decision is unit-testable without a
/// Firebase SDK. In production it is
/// [FirebasePushMessagingClient.initialize], which returns `null` when no
/// Firebase project is configured.
Future<PushMessagingClient> resolvePushTransport({
  Future<FirebasePushMessagingClient?> Function() attemptInitialize =
      FirebasePushMessagingClient.initialize,
}) async {
  final client = await attemptInitialize();
  if (client != null) {
    return client;
  }
  return UnavailablePushMessagingClient(
    PushUnavailableReason.notConfigured.message,
  );
}

/// Runs [resolvePushTransport] and classifies the outcome for the UI.
Future<PushTransportResolution> bootPushTransport({
  Future<FirebasePushMessagingClient?> Function() attemptInitialize =
      FirebasePushMessagingClient.initialize,
}) async {
  final PushMessagingClient client;
  try {
    client = await resolvePushTransport(
      attemptInitialize: attemptInitialize,
    );
  } catch (error) {
    // FirebasePushMessagingClient.initialize() already swallows a missing or
    // invalid project and reports it as null. An exception reaching here is
    // genuinely anomalous, and is reported as an unavailable device rather than
    // being guessed at. This also guarantees a transport error can never crash
    // startup.
    debugPrint('[Push] transport boot failed: ${error.runtimeType}');
    return const PushTransportResolution.unavailable(
      PushUnavailableReason.deviceUnsupported,
    );
  }

  if (client is FirebasePushMessagingClient) {
    debugPrint('[Push] Firebase Cloud Messaging transport active');
    return PushTransportResolution.available(client);
  }

  debugPrint('[Push] transport unavailable for this build');
  return const PushTransportResolution.unavailable(
    PushUnavailableReason.notConfigured,
  );
}
