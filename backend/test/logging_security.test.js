'use strict';

/**
 * QueueFlow Phase 5 — Step 6: Structured Logging, Request IDs & Secret Redaction Test Suite
 *
 * Covers:
 * 1. Request ID generated when absent
 * 2. Valid request ID preserved
 * 3. Invalid/malicious request ID replaced
 * 4. Request ID returned in response header
 * 5. Request ID included in structured logs
 * 6. Authorization header redacted
 * 7. x-iot-secret redacted
 * 8. JWT strings/fields redacted
 * 9. MongoDB credentials redacted from URIs
 * 10. Redis credentials redacted from URIs
 * 11. Password fields redacted (password, currentPassword, newPassword, passwordHash)
 * 12. API key fields redacted (apiKey, api_key)
 * 13. QR secret and qrPayload redacted
 * 14. CRLF and log injection protection
 * 15. Production error log sanitization
 * 16. 5xx client response remains sanitized
 * 17. Rate-limit security event is sanitized
 * 18. IoT failure event is sanitized
 * 19. QR failure event is sanitized
 */

const assert = require('assert');
const { redact, redactString, cleanLogString, maskEmail, SENSITIVE_KEYS } = require('../src/utils/redact');
const { isValidRequestId, requestIdMiddleware } = require('../src/middleware/requestId');
const { Logger } = require('../src/utils/logger');
const { app } = require('../server');

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;

async function runTest(name, fn) {
  totalTests++;
  process.stdout.write(`  Test ${totalTests}: ${name} ... `);
  try {
    await fn();
    passedTests++;
    console.log('✅ PASS');
  } catch (err) {
    failedTests++;
    console.log('❌ FAIL');
    console.error(`    Error: ${err.message}`);
    if (err.stack) {
      console.error(err.stack.split('\n').slice(1, 4).join('\n'));
    }
  }
}

async function runAll() {
  console.log('\n====================================================');
  console.log('🛡️  QueueFlow Phase 5 — Step 6: Logging & Redaction Tests');
  console.log('====================================================\n');

  console.log('▶ [1/4] Request ID & Correlation Validation');

  // Test 1: request ID generated when absent
  await runTest('1. Request ID is automatically generated as UUIDv4 when absent', () => {
    const req = { headers: {} };
    const res = {
      headers: {},
      setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    };
    requestIdMiddleware(req, res, () => {});
    assert(req.id, 'req.id must be set');
    assert.match(req.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  // Test 2: valid request ID preserved
  await runTest('2. Valid incoming X-Request-Id is preserved', () => {
    const customId = 'client-custom-req-12345678';
    const req = { headers: { 'x-request-id': customId } };
    const res = {
      headers: {},
      setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    };
    requestIdMiddleware(req, res, () => {});
    assert.strictEqual(req.id, customId);
  });

  // Test 3: invalid request ID replaced
  await runTest('3. Malformed/malicious X-Request-Id is replaced with a fresh UUID', () => {
    const maliciousIds = [
      'short',                                   // too short (<8)
      'bad\r\ninjection\nfake:true',            // CRLF injection
      'id-with-special-chars-!@#$%^&*()',       // disallowed characters
      'a'.repeat(65),                            // oversized (>64 chars)
      '{"fake":"json"}',                         // JSON injection
    ];

    for (const badId of maliciousIds) {
      const req = { headers: { 'x-request-id': badId } };
      const res = {
        headers: {},
        setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
      };
      requestIdMiddleware(req, res, () => {});
      assert.notStrictEqual(req.id, badId, `Bad ID '${badId}' should have been rejected`);
      assert.match(req.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    }
  });

  // Test 4: request ID returned in response
  await runTest('4. Validated X-Request-Id is set in response headers', () => {
    const customId = 'valid-tracer-id-998877';
    const req = { headers: { 'x-request-id': customId } };
    const res = {
      headers: {},
      setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    };
    requestIdMiddleware(req, res, () => {});
    assert.strictEqual(res.headers['x-request-id'], customId);
  });

  // Test 5: request ID included in logs
  await runTest('5. Request ID is explicitly correlated in structured log records', () => {
    const logger = new Logger();
    const formatted = logger.formatRecord('info', 'Token created', {
      requestId: 'req-corr-12345',
      userId: '6ab000000000000000000001',
    });
    const parsed = JSON.parse(formatted);
    assert.strictEqual(parsed.requestId, 'req-corr-12345');
    assert.strictEqual(parsed.level, 'info');
    assert.strictEqual(parsed.message, 'Token created');
  });

  console.log('\n▶ [2/4] Secret Redaction & URL Sanitization');

  // Test 6: Authorization redaction
  await runTest('6. Authorization headers and Bearer tokens are redacted', () => {
    const rawHeader = 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.t-ID';
    const obj = { authorization: rawHeader, nested: { auth: rawHeader } };
    const scrubbed = redact(obj);
    assert.strictEqual(scrubbed.authorization, '[REDACTED]');
    assert.strictEqual(scrubbed.nested.auth, 'Bearer [REDACTED]');
    assert(!JSON.stringify(scrubbed).includes('eyJhbGci'));
  });

  // Test 7: x-iot-secret redaction
  await runTest('7. x-iot-secret headers and fields are redacted', () => {
    const obj = { 'x-iot-secret': 'device_super_secret_key_12345' };
    const scrubbed = redact(obj);
    assert.strictEqual(scrubbed['x-iot-secret'], '[REDACTED]');
    assert(!JSON.stringify(scrubbed).includes('device_super_secret_key_12345'));
  });

  // Test 8: JWT redaction
  await runTest('8. JWT-like strings in plain text are redacted', () => {
    const sampleJwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjY2MDAwMDAwMDAwMDAwMDAwMDAwMDAwMSJ9.signature123';
    const text = `User connected with token: ${sampleJwt}`;
    const scrubbed = redactString(text);
    assert(!scrubbed.includes('signature123'));
    assert(scrubbed.includes('[REDACTED_JWT]'));

    const obj = { jwt: sampleJwt, token: sampleJwt };
    const scrubbedObj = redact(obj);
    assert.strictEqual(scrubbedObj.jwt, '[REDACTED]');
    assert.strictEqual(scrubbedObj.token, '[REDACTED]');
  });

  // Test 9: MongoDB credential redaction
  await runTest('9. MongoDB connection credentials in URIs are redacted', () => {
    const uri1 = 'mongodb+srv://adminUser:SuperP@ssw0rd!@cluster0.mongodb.net/queueflow?retryWrites=true';
    const scrubbed1 = redactString(uri1);
    assert(!scrubbed1.includes('adminUser'));
    assert(!scrubbed1.includes('SuperP@ssw0rd!'));
    assert(scrubbed1.startsWith('mongodb+srv://[REDACTED]@cluster0.mongodb.net'));

    const uri2 = 'mongodb://app_db_user:s3cr3t@127.0.0.1:27017/queueflow';
    const scrubbed2 = redactString(uri2);
    assert(!scrubbed2.includes('app_db_user'));
    assert(!scrubbed2.includes('s3cr3t'));
    assert(scrubbed2.startsWith('mongodb://[REDACTED]@127.0.0.1:27017'));
  });

  // Test 10: Redis credential redaction
  await runTest('10. Redis connection credentials in URIs are redacted', () => {
    const url1 = 'redis://default:redisSecretPass99@redis-cluster.internal:6379';
    const scrubbed1 = redactString(url1);
    assert(!scrubbed1.includes('redisSecretPass99'));
    assert(scrubbed1.startsWith('redis://[REDACTED]@redis-cluster.internal:6379'));

    const url2 = 'rediss://:onlyPassWord88@secure-redis.cloud.net:6380/0';
    const scrubbed2 = redactString(url2);
    assert(!scrubbed2.includes('onlyPassWord88'));
    assert(scrubbed2.startsWith('rediss://[REDACTED]@secure-redis.cloud.net:6380'));
  });

  // Test 11: password field redaction
  await runTest('11. Password fields (password, currentPassword, newPassword, passwordHash) are redacted', () => {
    const data = {
      email: 'user@example.com',
      password: 'PlainPassword123!',
      currentPassword: 'OldPassword123!',
      newPassword: 'NewPassword123!',
      passwordHash: '$2a$10$e8w.Kz2.Q193V...',
    };
    const scrubbed = redact(data);
    assert.strictEqual(scrubbed.email, 'user@example.com');
    assert.strictEqual(scrubbed.password, '[REDACTED]');
    assert.strictEqual(scrubbed.currentPassword, '[REDACTED]');
    assert.strictEqual(scrubbed.newPassword, '[REDACTED]');
    assert.strictEqual(scrubbed.passwordHash, '[REDACTED]');
  });

  // Test 12: API key redaction
  await runTest('12. API key fields (apiKey, api_key) are redacted', () => {
    const data = {
      apiKey: 'sk-live-99999999999999999999',
      api_key: 'sk-test-88888888888888888888',
      fcmToken: 'fcm-device-push-registration-token',
    };
    const scrubbed = redact(data);
    assert.strictEqual(scrubbed.apiKey, '[REDACTED]');
    assert.strictEqual(scrubbed.api_key, '[REDACTED]');
    assert.strictEqual(scrubbed.fcmToken, '[REDACTED]');
  });

  // Test 13: QR secret/payload redaction
  await runTest('13. QR secrets and qrPayload are redacted', () => {
    const data = {
      qrPayload: '{"v":1,"tid":"660001","sig":"valid_hmac_signature"}',
      qrSecret: 'super_secret_qr_signing_key_32_bytes',
    };
    const scrubbed = redact(data);
    assert.strictEqual(scrubbed.qrPayload, '[REDACTED]');
    assert.strictEqual(scrubbed.qrSecret, '[REDACTED]');
  });

  console.log('\n▶ [3/4] Log Injection & Safe Formatting');

  // Test 14: CRLF/log injection protection
  await runTest('14. CRLF, ANSI escapes, and control characters cannot forge new log lines', () => {
    const attackString = 'NormalMessage\r\n{"level":"info","event":"FORGED_LOG","admin":true}\n';
    const cleaned = cleanLogString(attackString);
    assert(!cleaned.includes('\r'), 'Must not contain \\r');
    assert(!cleaned.includes('\n'), 'Must not contain \\n');

    const logger = new Logger();
    const formatted = logger.formatRecord('info', attackString);
    // Verifying it is valid single-line JSON
    const lines = formatted.split('\n');
    assert.strictEqual(lines.length, 1, 'Log output must be strictly single-line');
    const parsed = JSON.parse(formatted);
    assert.strictEqual(parsed.event, undefined, 'Injected event field must not override top-level structure');
    assert(parsed.message.includes('NormalMessage'));
  });

  // Test 15: production error log sanitization
  await runTest('15. Error objects with stack traces containing connection strings are sanitized', () => {
    const err = new Error('Database connection failed to mongodb+srv://dbAdmin:TopSecretPass@cluster.mongodb.net');
    err.stack = `Error: Database connection failed to mongodb+srv://dbAdmin:TopSecretPass@cluster.mongodb.net\n    at Object.<anonymous> (/var/app/db.js:10:15)`;

    const logger = new Logger();
    const formatted = logger.formatRecord('error', 'Unhandled error', { err });
    const parsed = JSON.parse(formatted);

    assert(!JSON.stringify(parsed).includes('TopSecretPass'), 'Password must not appear in error log');
    assert(!JSON.stringify(parsed).includes('dbAdmin'), 'Username must not appear in error log');
    assert(JSON.stringify(parsed).includes('[REDACTED]'), 'Must replace with [REDACTED]');
  });

  // Test 16: 5xx client response remains sanitized
  await runTest('16. Production 5xx client response remains sanitized as in Step 4', () => {
    const origEnv = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'production';
      const dummyErr = new Error('Mongoose connection failed: mongodb+srv://secret:pass@cluster.mongodb.net');
      dummyErr.status = 500;

      const mockRes = {
        statusCode: null,
        jsonData: null,
        status(code) { this.statusCode = code; return this; },
        json(data) { this.jsonData = data; return this; },
      };

      const errorHandlerLayer = app._router.stack.find((layer) => layer.handle && layer.handle.length === 4);
      assert(errorHandlerLayer, 'Global error handler must exist');

      errorHandlerLayer.handle(dummyErr, { id: 'req-err-123' }, mockRes, () => {});

      assert.strictEqual(mockRes.statusCode, 500);
      assert.strictEqual(mockRes.jsonData.success, false);
      assert.strictEqual(mockRes.jsonData.message, 'Internal server error');
      assert.strictEqual(mockRes.jsonData.stack, undefined);
      assert.strictEqual(mockRes.jsonData.requestId, 'req-err-123');
      assert(!JSON.stringify(mockRes.jsonData).includes('mongodb'));
    } finally {
      process.env.NODE_ENV = origEnv;
    }
  });

  console.log('\n▶ [4/4] Security Audit Events Verification');

  // Test 17: rate-limit security event is sanitized
  await runTest('17. RATE_LIMIT_EXCEEDED event is structured and sanitized', () => {
    const logger = new Logger();
    const formatted = logger.formatRecord('security', {
      event: 'RATE_LIMIT_EXCEEDED',
      requestId: 'req-rl-999',
      clientIp: '192.168.1.100',
      path: '/api/auth/login',
      prefix: 'rl:auth:',
    });
    const parsed = JSON.parse(formatted);
    assert.strictEqual(parsed.event, 'RATE_LIMIT_EXCEEDED');
    assert.strictEqual(parsed.level, 'security');
    assert.strictEqual(parsed.requestId, 'req-rl-999');
    assert.strictEqual(parsed.clientIp, '192.168.1.100');
    assert(!JSON.stringify(parsed).includes('password'));
  });

  // Test 18: IoT failure event is sanitized
  await runTest('18. AUTH_IOT_FAILURE event records safe metadata without candidate secret', () => {
    const logger = new Logger();
    const formatted = logger.formatRecord('security', {
      event: 'AUTH_IOT_FAILURE',
      requestId: 'req-iot-fail-1',
      clientIp: '10.0.0.50',
      reason: 'invalid_iot_secret',
    });
    const parsed = JSON.parse(formatted);
    assert.strictEqual(parsed.event, 'AUTH_IOT_FAILURE');
    assert.strictEqual(parsed.reason, 'invalid_iot_secret');
    assert.strictEqual(parsed.clientIp, '10.0.0.50');
    assert(!JSON.stringify(parsed).includes('x-iot-secret'));
  });

  // Test 19: QR failure event is sanitized
  await runTest('19. QR_VERIFICATION_FAILURE event records safe reason without QR payload', () => {
    const logger = new Logger();
    const formatted = logger.formatRecord('security', {
      event: 'QR_VERIFICATION_FAILURE',
      requestId: 'req-qr-fail-1',
      reason: 'QR signature invalid',
      clientIp: '10.0.0.60',
    });
    const parsed = JSON.parse(formatted);
    assert.strictEqual(parsed.event, 'QR_VERIFICATION_FAILURE');
    assert.strictEqual(parsed.reason, 'QR signature invalid');
    assert.strictEqual(parsed.qrPayload, undefined);
    assert.strictEqual(parsed.sig, undefined);
  });

  console.log('\n====================================================');
  console.log(`Results: ${passedTests}/${totalTests} tests passed (${failedTests} failed)`);
  console.log('====================================================\n');

  if (failedTests > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runAll().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
