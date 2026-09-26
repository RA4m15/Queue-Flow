class ApiConstants {
  ApiConstants._();

  // Production Render backend ONLY - no localhost fallback anywhere
  static const String baseUrl = 'https://queue-flow-4308.onrender.com/api';
  static const String socketUrl = 'https://queue-flow-4308.onrender.com';

  // Auth Endpoints
  static const String authRegister = '/auth/register';
  static const String authLogin = '/auth/login';
  static const String authMe = '/auth/me';
  static const String authLogout = '/auth/logout';

  // Service Centers Endpoints
  static const String serviceCenters = '/service-centers';

  // Services Endpoints
  static const String services = '/services';

  // Queue Endpoints
  static const String queue = '/queue';

  // Tokens Endpoints
  static const String tokens = '/tokens';
  static const String tokensMy = '/tokens/my';
  static const String tokensActive = '/tokens/active';

  // Crowd Endpoints
  static const String crowd = '/crowd';

  // Notifications Endpoints
  static const String notifications = '/notifications';
  static const String notificationsReadAll = '/notifications/read-all';

  // Socket.IO Rooms & Events
  static const String roomJoinCenter = 'join:center';
  static const String roomJoinUser = 'join:user';

  static const String eventQueueUpdated = 'queue.updated';
  static const String eventTokenCreated = 'token.created';
  static const String eventTokenPositionUpdated = 'token.position_updated';
  static const String eventTokenCalled = 'token.called';
  static const String eventTokenServing = 'token.serving';
  static const String eventTokenCompleted = 'token.completed';
  static const String eventTokenSkipped = 'token.skipped';
  static const String eventTokenCancelled = 'token.cancelled';
  static const String eventTokenExpired = 'token.expired';
  static const String eventCounterUpdated = 'counter.updated';
  static const String eventCrowdUpdated = 'crowd.updated';
  static const String eventNotificationCreated = 'notification.created';

  // Timeout settings - accommodate Render cold starts gracefully
  static const Duration connectTimeout = Duration(seconds: 60);
  static const Duration receiveTimeout = Duration(seconds: 60);
}
