'use strict';

/**
 * QueueFlow — Centralized Environment & Configuration Security Test Suite
 * Phase 5 — Step 5: Startup Security Validation
 *
 * Validates:
 *   1.  Valid development config passes
 *   2.  Valid test config passes
 *   3.  Valid production config passes
 *   4.  Invalid NODE_ENV values (prod, staging, Production, empty) fail
 *   5.  Missing JWT_SECRET in production fails
 *   6.  Weak JWT_SECRET (< 32 chars) in production fails
 *   7.  Placeholder JWT_SECRET (from .env.example) fails in production
 *   8.  Missing QR_SIGNING_SECRET in production fails
 *   9.  Weak QR_SIGNING_SECRET in production fails
 *   10. QR_SIGNING_SECRET identical to JWT_SECRET fails in production
 *   11. Missing IOT_SECRET in production fails
 *   12. Weak IOT_SECRET (< 16 chars or placeholder) fails in production
 *   13. MongoDB URI with invalid scheme fails
 *   14. MongoDB URI containing template placeholders (<username>, <password>) fails
 *   15. Missing Redis configuration in production fails
 *   16. REDIS_ENABLED=false in production fails
 *   17. Malformed ALLOWED_ORIGINS (invalid URL/scheme) fails
 *   18. Wildcard '*' ALLOWED_ORIGINS in production fails
 *   19. Invalid PORT (negative, out of bounds, non-numeric) fails
 *   20. DEV_SIMULATOR_ENABLED=true in production fails
 *   21. Secret values NEVER appear in validation error messages or exceptions
 */

process.env.NODE_ENV = 'test';

const assert = require('assert');
const { validateEnv, ConfigValidationError } = require('../src/config/env');

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;

function runTest(name, fn) {
  totalTests++;
  process.stdout.write(`  Test ${totalTests}: ${name} ... `);
  try {
    fn();
    passedTests++;
    console.log('✅ PASS');
  } catch (err) {
    failedTests++;
    console.log('❌ FAIL');
    console.error(`    Error: ${err.message}`);
  }
}

// ─── Base Mock Generators ─────────────────────────────────────────────────────

function createValidProductionEnv(overrides = {}) {
  return {
    NODE_ENV: 'production',
    PORT: '5000',
    MONGODB_URI: 'mongodb+srv://dbuser_prod:K9#mQ2$vL8@prod-cluster.pr2xsb8.mongodb.net/queueflow_prod?retryWrites=true&w=majority',
    JWT_SECRET: 'd8f93a1c8b2e4f7a9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b',
    QR_SIGNING_SECRET: '9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f',
    IOT_SECRET: '9f8e7d6c5b4a3210fedcba9876543210',
    REDIS_URL: 'redis://default:SecureP@ssw0rd!@prod-redis.internal:6379',
    ALLOWED_ORIGINS: 'https://queue-flow-4308.onrender.com,https://admin.queueflow.com',
    DEV_SIMULATOR_ENABLED: 'false',
    ...overrides,
  };
}

function createValidDevelopmentEnv(overrides = {}) {
  return {
    NODE_ENV: 'development',
    PORT: '5000',
    MONGODB_URI: 'mongodb+srv://devuser:devpass@dev-cluster.mongodb.net/queueflow_dev',
    JWT_SECRET: 'any-secret-for-development-mode-testing',
    QR_SIGNING_SECRET: 'any-dev-qr-secret-for-testing',
    IOT_SECRET: 'dev-iot-secret',
    ...overrides,
  };
}

function createValidTestEnv(overrides = {}) {
  return {
    NODE_ENV: 'test',
    PORT: '5000',
    MONGODB_URI: 'mongodb://127.0.0.1:27017/queueflow_test',
    ...overrides,
  };
}

// ─── Execute Test Suites ──────────────────────────────────────────────────────

console.log('====================================================');
console.log('🛡️  QueueFlow Phase 5 — Step 5: Environment Config Tests');
console.log('====================================================\n');

// ─── Valid Configurations ─────────────────────────────────────────────────────
console.log('▶ [1/4] Baseline Valid Environments');

runTest('1. Valid development configuration passes with normalized defaults', () => {
  const env = createValidDevelopmentEnv();
  const config = validateEnv(env);
  assert.strictEqual(config.NODE_ENV, 'development');
  assert.strictEqual(config.isDevelopment, true);
  assert.strictEqual(config.isProduction, false);
  assert.strictEqual(config.PORT, 5000);
});

runTest('2. Valid test configuration passes without requiring external Redis', () => {
  const env = createValidTestEnv();
  const config = validateEnv(env);
  assert.strictEqual(config.NODE_ENV, 'test');
  assert.strictEqual(config.isTest, true);
  assert.strictEqual(config.isProduction, false);
});

runTest('3. Valid production configuration passes all cryptographic and connectivity checks', () => {
  const env = createValidProductionEnv();
  const config = validateEnv(env);
  assert.strictEqual(config.NODE_ENV, 'production');
  assert.strictEqual(config.isProduction, true);
  assert.strictEqual(config.ALLOWED_ORIGINS.length >= 2, true);
  assert.strictEqual(config.DEV_SIMULATOR_ENABLED, false);
});

// ─── Environment & Server Parameters ──────────────────────────────────────────
console.log('\n▶ [2/4] NODE_ENV, PORT & MONGODB_URI Enforcement');

runTest('4. Invalid NODE_ENV values (prod, staging, Production, empty, undefined) fail startup', () => {
  const invalidValues = ['prod', 'prd', 'Production', 'staging', 'PRODUCTION', '', undefined, null];
  for (const val of invalidValues) {
    const env = createValidProductionEnv({ NODE_ENV: val });
    assert.throws(
      () => validateEnv(env),
      (err) => err instanceof ConfigValidationError && err.message.includes('NODE_ENV'),
      `NODE_ENV="${val}" must be rejected`
    );
  }
});

runTest('13. MongoDB URI with wrong scheme (http://, postgres://) is rejected', () => {
  const badSchemes = [
    'http://localhost:27017/queueflow',
    'postgres://user:pass@localhost:5432/db',
    'ftp://mongodb.example.com',
  ];
  for (const uri of badSchemes) {
    const env = createValidProductionEnv({ MONGODB_URI: uri });
    assert.throws(
      () => validateEnv(env),
      (err) => err instanceof ConfigValidationError && err.message.includes('MONGODB_URI'),
      `Scheme for "${uri}" must be rejected`
    );
  }
});

runTest('14. MongoDB URI containing unreplaced template placeholders is rejected', () => {
  const templateUris = [
    'mongodb+srv://<username>:<password>@cluster.mongodb.net/queueflow',
    'mongodb+srv://realuser:<password>@cluster.mongodb.net/queueflow',
    'mongodb+srv://<username>:realpass@cluster.mongodb.net/queueflow',
  ];
  for (const uri of templateUris) {
    const env = createValidProductionEnv({ MONGODB_URI: uri });
    assert.throws(
      () => validateEnv(env),
      (err) => err instanceof ConfigValidationError && err.message.includes('template placeholders'),
      `Template URI "${uri}" must be rejected`
    );
  }
});

runTest('19. Invalid PORT values (negative, non-numeric, >65535) are rejected', () => {
  const invalidPorts = ['-1', '0', '65536', '99999', 'abc', '5000.5'];
  for (const p of invalidPorts) {
    const env = createValidProductionEnv({ PORT: p });
    assert.throws(
      () => validateEnv(env),
      (err) => err instanceof ConfigValidationError && err.message.includes('PORT'),
      `Port "${p}" must be rejected`
    );
  }
});

// ─── Secret Entropy & Key Separation ──────────────────────────────────────────
console.log('\n▶ [3/4] Cryptographic Secret Strength & Anti-Placeholder');

runTest('5. Missing JWT_SECRET in production fails validation', () => {
  const env = createValidProductionEnv({ JWT_SECRET: '' });
  delete env.JWT_SECRET;
  assert.throws(
    () => validateEnv(env),
    (err) => err instanceof ConfigValidationError && err.message.includes('JWT_SECRET')
  );
});

runTest('6. Weak JWT_SECRET (< 32 chars or low entropy) in production fails validation', () => {
  const weakSecrets = [
    'short-key',
    '123456789012345678901234567890', // 30 chars
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', // 40 chars but no entropy
  ];
  for (const s of weakSecrets) {
    const env = createValidProductionEnv({ JWT_SECRET: s });
    assert.throws(
      () => validateEnv(env),
      (err) => err instanceof ConfigValidationError && err.message.includes('JWT_SECRET'),
      `Weak secret "${s}" must be rejected`
    );
  }
});

runTest('7. Placeholder JWT_SECRET (from .env.example) fails validation in production', () => {
  const env = createValidProductionEnv({
    JWT_SECRET: 'your_super_secret_jwt_key_change_this_in_production',
  });
  assert.throws(
    () => validateEnv(env),
    (err) => err instanceof ConfigValidationError && err.message.includes('JWT_SECRET')
  );
});

runTest('8. Missing QR_SIGNING_SECRET in production fails validation', () => {
  const env = createValidProductionEnv({ QR_SIGNING_SECRET: '' });
  delete env.QR_SIGNING_SECRET;
  assert.throws(
    () => validateEnv(env),
    (err) => err instanceof ConfigValidationError && err.message.includes('QR_SIGNING_SECRET')
  );
});

runTest('9. Weak QR_SIGNING_SECRET in production fails validation', () => {
  const env = createValidProductionEnv({ QR_SIGNING_SECRET: 'weak_qr_secret_too_short' });
  assert.throws(
    () => validateEnv(env),
    (err) => err instanceof ConfigValidationError && err.message.includes('QR_SIGNING_SECRET')
  );
});

runTest('10. QR_SIGNING_SECRET identical to JWT_SECRET fails key-isolation policy', () => {
  const sharedKey = 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';
  const env = createValidProductionEnv({
    JWT_SECRET: sharedKey,
    QR_SIGNING_SECRET: sharedKey,
  });
  assert.throws(
    () => validateEnv(env),
    (err) => err instanceof ConfigValidationError && err.message.includes('identical to JWT_SECRET')
  );
});

runTest('11. Missing IOT_SECRET in production fails validation', () => {
  const env = createValidProductionEnv({ IOT_SECRET: '' });
  delete env.IOT_SECRET;
  assert.throws(
    () => validateEnv(env),
    (err) => err instanceof ConfigValidationError && err.message.includes('IOT_SECRET')
  );
});

runTest('12. Weak or placeholder IOT_SECRET fails validation in production', () => {
  const badIot = ['short', 'your_iot_device_secret_key', '12345678'];
  for (const s of badIot) {
    const env = createValidProductionEnv({ IOT_SECRET: s });
    assert.throws(
      () => validateEnv(env),
      (err) => err instanceof ConfigValidationError && err.message.includes('IOT_SECRET')
    );
  }
});

// ─── Redis, Origins, Simulator & Secret Non-Disclosure ────────────────────────
console.log('\n▶ [4/4] Redis, Origins, Simulator & Non-Disclosure');

runTest('15. Missing Redis configuration in production fails validation', () => {
  const env = createValidProductionEnv({ REDIS_URL: '', REDIS_HOST: '' });
  delete env.REDIS_URL;
  delete env.REDIS_HOST;
  assert.throws(
    () => validateEnv(env),
    (err) => err instanceof ConfigValidationError && err.message.includes('REDIS')
  );
});

runTest('16. REDIS_ENABLED=false in production fails validation', () => {
  const env = createValidProductionEnv({ REDIS_ENABLED: 'false' });
  assert.throws(
    () => validateEnv(env),
    (err) => err instanceof ConfigValidationError && err.message.includes('REDIS_ENABLED')
  );
});

runTest('17. Malformed ALLOWED_ORIGINS fails validation', () => {
  const malformed = ['ftp://bad-origin', 'no-protocol-host.com', 'http//broken.com'];
  for (const origin of malformed) {
    const env = createValidProductionEnv({ ALLOWED_ORIGINS: origin });
    assert.throws(
      () => validateEnv(env),
      (err) => err instanceof ConfigValidationError && err.message.includes('ALLOWED_ORIGINS')
    );
  }
});

runTest('18. Wildcard ALLOWED_ORIGINS (*) is strictly prohibited in production', () => {
  const env = createValidProductionEnv({ ALLOWED_ORIGINS: '*' });
  assert.throws(
    () => validateEnv(env),
    (err) => err instanceof ConfigValidationError && err.message.includes('Wildcard origin')
  );
});

runTest('20. DEV_SIMULATOR_ENABLED=true in production fails validation', () => {
  const env = createValidProductionEnv({ DEV_SIMULATOR_ENABLED: 'true' });
  assert.throws(
    () => validateEnv(env),
    (err) => err instanceof ConfigValidationError && err.message.includes('DEV_SIMULATOR_ENABLED')
  );
});

runTest('21. Secret values NEVER appear in validation error messages or exceptions', () => {
  const secretLeakedIfPresent = 'TopSecretPassword9876543210ABCDEF';
  const env = createValidProductionEnv({
    JWT_SECRET: secretLeakedIfPresent, // Weak because low length/entropy or test placeholder
    QR_SIGNING_SECRET: secretLeakedIfPresent,
    MONGODB_URI: `mongodb+srv://admin:${secretLeakedIfPresent}@cluster.mongodb.net/<password>`,
    REDIS_URL: `redis://:${secretLeakedIfPresent}@redis.internal:6379`,
  });

  try {
    validateEnv(env);
    assert.fail('Should have thrown validation error');
  } catch (err) {
    const errorString = err.message + (err.stack || '');
    assert(
      !errorString.includes(secretLeakedIfPresent),
      'Validation error MUST NEVER contain the actual secret value or credentials'
    );
  }
});

console.log('\n====================================================');
console.log(`Results: ${passedTests}/${totalTests} tests passed (${failedTests} failed)`);
console.log('====================================================\n');

if (failedTests > 0) {
  process.exit(1);
} else {
  process.exit(0);
}
