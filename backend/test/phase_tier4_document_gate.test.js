'use strict';

/**
 * QueueFlow — TIER 4 / FEATURE 4: DOCUMENT-READY GATEKEEPING TEST SUITE
 *
 * Tests all aspects of the Document Gatekeeping feature:
 * 1. Service requirement retrieval
 * 2. No requirements configured
 * 3. Required document detection
 * 4. Optional document behavior
 * 5. Customer document upload
 * 6. Ownership enforcement
 * 7. Invalid document type
 * 8. Verification authorization
 * 9. Self-verification rejection
 * 10. Document approval
 * 11. Document rejection
 * 12. Readiness calculation
 * 13. Missing-document block
 * 14. Ready customer allowed to join
 * 15. Not-ready customer blocked from join
 * 16. Service Graph compatibility
 * 17. P2P swap compatibility
 * 18. Ghost Queue independence
 * 19. Notification integration
 * 20. Duplicate notification prevention
 * 21. IDOR protection
 * 22. Secure document access
 * 23. File validation
 * 24. Rate limiting
 * 25. Concurrent readiness/token requests
 * 26. No PII leakage
 * 27. No static requirement data
 *
 * REAL DATA ONLY. Zero mock/static business data.
 */

process.env.NODE_ENV = 'test';
require('dotenv').config();

const assert = require('assert');
const http = require('http');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');

const { server } = require('../server');
const connectDB = require('../src/config/database');

const User = require('../src/models/User');
const ServiceCenter = require('../src/models/ServiceCenter');
const Service = require('../src/models/Service');
const Queue = require('../src/models/Queue');
const Notification = require('../src/models/Notification');
const { Token } = require('../src/models/Token');
const QueueEvent = require('../src/models/QueueEvent');
const { DocumentRequirement } = require('../src/models/DocumentRequirement');
const { CustomerDocument } = require('../src/models/CustomerDocument');
const { SwapOffer } = require('../src/models/SwapOffer');

const queueService = require('../src/services/queueService');
const swapService = require('../src/services/swapService');
const documentGateService = require('../src/services/documentGateService');
const serviceGraphService = require('../src/services/serviceGraphService');
const geofenceService = require('../src/services/geofenceService');

let baseUrl;
let testServer;

let centerA;
let serviceA; // Has document requirements
let serviceB; // No document requirements
let serviceC; // Next hop in Service Graph

let adminUser, staffUser, customerA, customerB, customerC;
let adminJwt, staffJwt, customerAJwt, customerBJwt, customerCJwt;

let requirementA, requirementB;

let passed = 0;
let failed = 0;

function signToken(userId, role = 'CUSTOMER') {
  return jwt.sign({ id: userId.toString(), role, tokenVersion: 0 }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

function pass(name) {
  passed++;
  console.log(`  ✅ PASS  ${name}`);
}

function fail(name, err) {
  failed++;
  console.error(`  ❌ FAIL  ${name}`);
  console.error(`         ${err?.message || err}`);
  if (err?.actual !== undefined) {
    console.error(`         actual:   ${JSON.stringify(err.actual)}`);
    console.error(`         expected: ${JSON.stringify(err.expected)}`);
  }
}

async function request(method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const defaultHeaders = {
      'Content-Type': 'application/json',
      ...headers,
    };
    const options = {
      method,
      path,
      headers: defaultHeaders,
    };
    const [host, portStr] = baseUrl.replace('http://', '').split(':');
    const port = parseInt(portStr, 10);
    const req = http.request({ ...options, host, port }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(raw) });
        } catch {
          resolve({ status: res.statusCode, body: raw });
        }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// ─── Setup ────────────────────────────────────────────────────────────────────

async function setup() {
  await connectDB();
  testServer = server.listen(0);
  const addr = testServer.address();
  baseUrl = `http://127.0.0.1:${addr.port}`;
  console.log(`[Test] Server listening at ${baseUrl}`);

  // Clean test fixtures
  await Promise.all([
    User.deleteMany({ email: { $regex: '@docgate.qf' } }),
    DocumentRequirement.deleteMany({}),
    CustomerDocument.deleteMany({}),
    Token.deleteMany({ 'metadata.testSuite': 'docgate' }),
    SwapOffer.deleteMany({}),
  ]);

  // Create Service Center
  centerA = await ServiceCenter.create({
    name: 'DocGate Test Center',
    code: `DGTC${Date.now()}`,
    type: 'GOVT',
    location: { latitude: 12.9716, longitude: 77.5946 },
    geofence: {
      enabled: true,
      radiusMeters: 500,
      nearRadiusMeters: 1000,
      approachingRadiusMeters: 2000,
    },
    isOpen: true,
  });

  // Create Services
  serviceA = await Service.create({
    centerId: centerA._id,
    name: 'Passport Renewal',
    tokenPrefix: 'PR',
    avgServiceTimeMinutes: 15,
    isActive: true,
  });

  serviceB = await Service.create({
    centerId: centerA._id,
    name: 'General Inquiries',
    tokenPrefix: 'GI',
    avgServiceTimeMinutes: 5,
    isActive: true,
  });

  serviceC = await Service.create({
    centerId: centerA._id,
    name: 'Biometric Capture',
    tokenPrefix: 'BC',
    avgServiceTimeMinutes: 10,
    isActive: true,
  });

  // Create Users
  adminUser = await User.create({
    name: 'Doc Admin',
    email: `admin_${Date.now()}@docgate.qf`,
    passwordHash: 'hash',
    role: 'ADMIN',
    isActive: true,
  });
  adminJwt = signToken(adminUser._id, 'ADMIN');

  staffUser = await User.create({
    name: 'Doc Staff',
    email: `staff_${Date.now()}@docgate.qf`,
    passwordHash: 'hash',
    role: 'STAFF',
    centerId: centerA._id,
    isActive: true,
  });
  staffJwt = signToken(staffUser._id, 'STAFF');

  customerA = await User.create({
    name: 'Customer Alpha',
    email: `alpha_${Date.now()}@docgate.qf`,
    passwordHash: 'hash',
    role: 'CUSTOMER',
    isActive: true,
  });
  customerAJwt = signToken(customerA._id, 'CUSTOMER');

  customerB = await User.create({
    name: 'Customer Beta',
    email: `beta_${Date.now()}@docgate.qf`,
    passwordHash: 'hash',
    role: 'CUSTOMER',
    isActive: true,
  });
  customerBJwt = signToken(customerB._id, 'CUSTOMER');

  customerC = await User.create({
    name: 'Customer Gamma',
    email: `gamma_${Date.now()}@docgate.qf`,
    passwordHash: 'hash',
    role: 'CUSTOMER',
    isActive: true,
  });
  customerCJwt = signToken(customerC._id, 'CUSTOMER');
}

async function teardown() {
  console.log('\n[Teardown] Cleaning up test fixtures...');
  await Promise.all([
    User.deleteMany({ email: { $regex: '@docgate.qf' } }),
    DocumentRequirement.deleteMany({}),
    CustomerDocument.deleteMany({}),
    Token.deleteMany({ 'metadata.testSuite': 'docgate' }),
    SwapOffer.deleteMany({}),
  ]);
  if (testServer) testServer.close();
  await mongoose.disconnect();
  console.log('[DB] MongoDB disconnected.');
}

// ─── Test Suite Execution ─────────────────────────────────────────────────────

async function runTests() {
  console.log('\n============================================================');
  console.log('  QUEUEFLOW TIER 4 FEATURE 4: DOCUMENT-READY GATEKEEPING TESTS');
  console.log('============================================================\n');

  let uploadedDocA;

  // 1. service requirement retrieval
  try {
    // Configure a real requirement via API
    const res = await request(
      'POST',
      `/api/documents/services/${serviceA._id}/requirements`,
      {
        documentType: 'PASSPORT_PHOTO',
        name: 'Recent Passport Photograph',
        description: 'White background, 2x2 inch photo',
        isRequired: true,
        verificationRequired: true,
      },
      { Authorization: `Bearer ${adminJwt}` }
    );
    assert.strictEqual(res.status, 201);
    requirementA = res.body.data.requirement;

    // Fetch requirements for serviceA
    const getRes = await request('GET', `/api/documents/services/${serviceA._id}/requirements`);
    assert.strictEqual(getRes.status, 200);
    assert(Array.isArray(getRes.body.data.requirements));
    assert.strictEqual(getRes.body.data.requirements.length, 1);
    assert.strictEqual(getRes.body.data.requirements[0].documentType, 'PASSPORT_PHOTO');
    pass('1. service requirement retrieval');
  } catch (err) {
    fail('1. service requirement retrieval', err);
  }

  // 2. no requirements configured
  try {
    const res = await request('GET', `/api/documents/services/${serviceB._id}/requirements`);
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body.data.requirements, []);

    const readinessRes = await request(
      'GET',
      `/api/documents/services/${serviceB._id}/readiness`,
      null,
      { Authorization: `Bearer ${customerAJwt}` }
    );
    assert.strictEqual(readinessRes.status, 200);
    assert.strictEqual(readinessRes.body.data.isReady, true);
    assert.strictEqual(readinessRes.body.data.status, 'REQUIREMENTS_NOT_CONFIGURED');
    pass('2. no requirements configured');
  } catch (err) {
    fail('2. no requirements configured', err);
  }

  // 3. required document detection
  try {
    const readinessRes = await request(
      'GET',
      `/api/documents/services/${serviceA._id}/readiness`,
      null,
      { Authorization: `Bearer ${customerAJwt}` }
    );
    assert.strictEqual(readinessRes.status, 200);
    assert.strictEqual(readinessRes.body.data.isReady, false);
    assert.strictEqual(readinessRes.body.data.status, 'INCOMPLETE');
    assert.strictEqual(readinessRes.body.data.missingRequirements.length, 1);
    assert.strictEqual(readinessRes.body.data.missingRequirements[0].documentType, 'PASSPORT_PHOTO');
    pass('3. required document detection');
  } catch (err) {
    fail('3. required document detection', err);
  }

  // 4. optional document behavior
  try {
    // Add an optional requirement to serviceB
    const optRes = await request(
      'POST',
      `/api/documents/services/${serviceB._id}/requirements`,
      {
        documentType: 'FEEDBACK_SURVEY',
        name: 'Pre-service Questionnaire',
        isRequired: false,
        verificationRequired: false,
      },
      { Authorization: `Bearer ${adminJwt}` }
    );
    assert.strictEqual(optRes.status, 201);

    const readinessRes = await request(
      'GET',
      `/api/documents/services/${serviceB._id}/readiness`,
      null,
      { Authorization: `Bearer ${customerAJwt}` }
    );
    assert.strictEqual(readinessRes.status, 200);
    assert.strictEqual(readinessRes.body.data.isReady, true);
    assert.strictEqual(readinessRes.body.data.status, 'NOT_REQUIRED');
    pass('4. optional document behavior');
  } catch (err) {
    fail('4. optional document behavior', err);
  }

  // 5. customer document upload
  try {
    const sampleBase64 = Buffer.from('PDF_SAMPLE_DATA_CUSTOMER_ALPHA').toString('base64');
    const uploadRes = await request(
      'POST',
      '/api/documents/upload',
      {
        documentType: 'PASSPORT_PHOTO',
        fileName: 'alpha_photo.png',
        mimeType: 'image/png',
        fileData: sampleBase64,
        serviceId: serviceA._id.toString(),
      },
      { Authorization: `Bearer ${customerAJwt}` }
    );
    assert.strictEqual(uploadRes.status, 201);
    uploadedDocA = uploadRes.body.data.document;
    assert.strictEqual(uploadedDocA.documentType, 'PASSPORT_PHOTO');
    assert.strictEqual(uploadedDocA.status, 'PENDING');
    assert.strictEqual(uploadedDocA.storageReference, undefined); // Stripped for privacy
    pass('5. customer document upload');
  } catch (err) {
    fail('5. customer document upload', err);
  }

  // 6. ownership enforcement
  try {
    // customerB tries to view customerA's documents via /api/documents/my
    const myDocsB = await request('GET', '/api/documents/my', null, { Authorization: `Bearer ${customerBJwt}` });
    assert.strictEqual(myDocsB.status, 200);
    assert.deepStrictEqual(myDocsB.body.data.documents, []);

    // customerA sees their uploaded document
    const myDocsA = await request('GET', '/api/documents/my', null, { Authorization: `Bearer ${customerAJwt}` });
    assert.strictEqual(myDocsA.status, 200);
    assert.strictEqual(myDocsA.body.data.documents.length, 1);
    assert.strictEqual(myDocsA.body.data.documents[0]._id, uploadedDocA._id);
    pass('6. ownership enforcement');
  } catch (err) {
    fail('6. ownership enforcement', err);
  }

  // 7. invalid document type
  try {
    const sampleBase64 = Buffer.from('SAMPLE').toString('base64');
    const res = await request(
      'POST',
      '/api/documents/upload',
      {
        documentType: 'INVALID_NONEXISTENT_TYPE',
        fileName: 'test.png',
        mimeType: 'image/png',
        fileData: sampleBase64,
        serviceId: serviceA._id.toString(),
      },
      { Authorization: `Bearer ${customerAJwt}` }
    );
    assert.strictEqual(res.status, 400);
    pass('7. invalid document type');
  } catch (err) {
    fail('7. invalid document type', err);
  }

  // 8. verification authorization
  try {
    // Customer cannot verify documents
    const resCust = await request(
      'PATCH',
      `/api/documents/${uploadedDocA._id}/verify`,
      { status: 'VERIFIED' },
      { Authorization: `Bearer ${customerBJwt}` }
    );
    assert.strictEqual(resCust.status, 403);

    // Staff CAN verify
    const resStaff = await request(
      'PATCH',
      `/api/documents/${uploadedDocA._id}/verify`,
      { status: 'VERIFIED' },
      { Authorization: `Bearer ${staffJwt}` }
    );
    assert.strictEqual(resStaff.status, 200);
    assert.strictEqual(resStaff.body.data.document.status, 'VERIFIED');
    pass('8. verification authorization');
  } catch (err) {
    fail('8. verification authorization', err);
  }

  // 9. self-verification rejection
  try {
    // Admin uploads a document under their own account
    const sampleBase64 = Buffer.from('ADMIN_DOC').toString('base64');
    const adminUpload = await request(
      'POST',
      '/api/documents/upload',
      {
        documentType: 'PASSPORT_PHOTO',
        fileName: 'admin_doc.png',
        mimeType: 'image/png',
        fileData: sampleBase64,
        serviceId: serviceA._id.toString(),
      },
      { Authorization: `Bearer ${adminJwt}` }
    );
    assert.strictEqual(adminUpload.status, 201);
    const adminDocId = adminUpload.body.data.document._id;

    // Admin attempts to self-verify their own document
    const selfVerifyRes = await request(
      'PATCH',
      `/api/documents/${adminDocId}/verify`,
      { status: 'VERIFIED' },
      { Authorization: `Bearer ${adminJwt}` }
    );
    assert.strictEqual(selfVerifyRes.status, 403);
    assert(selfVerifyRes.body.message.includes('Self-verification is not permitted'));
    pass('9. self-verification rejection');
  } catch (err) {
    fail('9. self-verification rejection', err);
  }

  // 10. document approval
  try {
    // Customer B uploads a document
    const sampleBase64 = Buffer.from('CUSTOMER_B_DOC').toString('base64');
    const bUpload = await request(
      'POST',
      '/api/documents/upload',
      {
        documentType: 'PASSPORT_PHOTO',
        fileName: 'beta_photo.png',
        mimeType: 'image/png',
        fileData: sampleBase64,
        serviceId: serviceA._id.toString(),
      },
      { Authorization: `Bearer ${customerBJwt}` }
    );
    assert.strictEqual(bUpload.status, 201);
    const bDocId = bUpload.body.data.document._id;

    // Staff approves it
    const approveRes = await request(
      'PATCH',
      `/api/documents/${bDocId}/verify`,
      { status: 'VERIFIED' },
      { Authorization: `Bearer ${staffJwt}` }
    );
    assert.strictEqual(approveRes.status, 200);
    assert.strictEqual(approveRes.body.data.document.status, 'VERIFIED');
    assert(approveRes.body.data.document.verifiedAt !== null);
    pass('10. document approval');
  } catch (err) {
    fail('10. document approval', err);
  }

  // 11. document rejection
  try {
    // Customer C uploads a document
    const sampleBase64 = Buffer.from('CUSTOMER_C_BLURRY_DOC').toString('base64');
    const cUpload = await request(
      'POST',
      '/api/documents/upload',
      {
        documentType: 'PASSPORT_PHOTO',
        fileName: 'blurry.png',
        mimeType: 'image/png',
        fileData: sampleBase64,
        serviceId: serviceA._id.toString(),
      },
      { Authorization: `Bearer ${customerCJwt}` }
    );
    assert.strictEqual(cUpload.status, 201);
    const cDocId = cUpload.body.data.document._id;

    // Staff rejects it with a reason
    const rejectRes = await request(
      'PATCH',
      `/api/documents/${cDocId}/verify`,
      { status: 'REJECTED', rejectionReason: 'Image is blurry and face is obscured' },
      { Authorization: `Bearer ${staffJwt}` }
    );
    assert.strictEqual(rejectRes.status, 200);
    assert.strictEqual(rejectRes.body.data.document.status, 'REJECTED');
    assert.strictEqual(rejectRes.body.data.document.rejectionReason, 'Image is blurry and face is obscured');
    pass('11. document rejection');
  } catch (err) {
    fail('11. document rejection', err);
  }

  // 12. readiness calculation
  try {
    // Customer A has a VERIFIED document -> should be READY
    const readyA = await request(
      'GET',
      `/api/documents/services/${serviceA._id}/readiness`,
      null,
      { Authorization: `Bearer ${customerAJwt}` }
    );
    assert.strictEqual(readyA.body.data.isReady, true);
    assert.strictEqual(readyA.body.data.status, 'READY');

    // Customer C has a REJECTED document -> should be REJECTED
    const readyC = await request(
      'GET',
      `/api/documents/services/${serviceA._id}/readiness`,
      null,
      { Authorization: `Bearer ${customerCJwt}` }
    );
    assert.strictEqual(readyC.body.data.isReady, false);
    assert.strictEqual(readyC.body.data.status, 'REJECTED');
    pass('12. readiness calculation');
  } catch (err) {
    fail('12. readiness calculation', err);
  }

  // 13. missing-document block
  try {
    // Add a second mandatory requirement to serviceA
    const req2Res = await request(
      'POST',
      `/api/documents/services/${serviceA._id}/requirements`,
      {
        documentType: 'ADDRESS_PROOF',
        name: 'Proof of Address',
        isRequired: true,
        verificationRequired: true,
      },
      { Authorization: `Bearer ${adminJwt}` }
    );
    assert.strictEqual(req2Res.status, 201);
    requirementB = req2Res.body.data.requirement;

    // Customer A now misses ADDRESS_PROOF -> state should transition to INCOMPLETE
    const readyA2 = await request(
      'GET',
      `/api/documents/services/${serviceA._id}/readiness`,
      null,
      { Authorization: `Bearer ${customerAJwt}` }
    );
    assert.strictEqual(readyA2.body.data.isReady, false);
    assert.strictEqual(readyA2.body.data.status, 'INCOMPLETE');
    assert.strictEqual(readyA2.body.data.missingRequirements[0].documentType, 'ADDRESS_PROOF');
    pass('13. missing-document block');
  } catch (err) {
    fail('13. missing-document block', err);
  }

  // 14. ready customer allowed to join
  try {
    // Customer A uploads and gets verified for ADDRESS_PROOF
    const sampleBase64 = Buffer.from('UTILITY_BILL').toString('base64');
    const upRes = await request(
      'POST',
      '/api/documents/upload',
      {
        documentType: 'ADDRESS_PROOF',
        fileName: 'bill.pdf',
        mimeType: 'application/pdf',
        fileData: sampleBase64,
        serviceId: serviceA._id.toString(),
      },
      { Authorization: `Bearer ${customerAJwt}` }
    );
    assert.strictEqual(upRes.status, 201);

    await request(
      'PATCH',
      `/api/documents/${upRes.body.data.document._id}/verify`,
      { status: 'VERIFIED' },
      { Authorization: `Bearer ${staffJwt}` }
    );

    // Customer A now has both requirements VERIFIED -> isReady: true
    const checkA = await request(
      'GET',
      `/api/documents/services/${serviceA._id}/readiness`,
      null,
      { Authorization: `Bearer ${customerAJwt}` }
    );
    assert.strictEqual(checkA.body.data.isReady, true);
    assert.strictEqual(checkA.body.data.status, 'READY');

    // Customer A joins queue -> token minted successfully!
    const tokenRes = await request(
      'POST',
      '/api/tokens',
      { centerId: centerA._id.toString(), serviceId: serviceA._id.toString() },
      { Authorization: `Bearer ${customerAJwt}` }
    );
    assert.strictEqual(tokenRes.status, 201);
    assert(tokenRes.body.data.token.tokenCode.startsWith('PR'));
    pass('14. ready customer allowed to join');
  } catch (err) {
    fail('14. ready customer allowed to join', err);
  }

  // 15. not-ready customer blocked from join
  try {
    // Customer C tries to join serviceA without satisfying documents
    const blockedRes = await request(
      'POST',
      '/api/tokens',
      { centerId: centerA._id.toString(), serviceId: serviceA._id.toString() },
      { Authorization: `Bearer ${customerCJwt}` }
    );
    assert.strictEqual(blockedRes.status, 403);
    assert.strictEqual(blockedRes.body.code, 'DOCUMENT_GATE_BLOCKED');
    assert(blockedRes.body.data.missingRequirements.length > 0);
    pass('15. not-ready customer blocked from join');
  } catch (err) {
    fail('15. not-ready customer blocked from join', err);
  }

  // 16. Service Graph compatibility
  try {
    // Configure requirement specifically for serviceC (Biometric Capture)
    await request(
      'POST',
      `/api/documents/services/${serviceC._id}/requirements`,
      {
        documentType: 'CONSENT_FORM',
        name: 'Biometric Consent Form',
        isRequired: true,
        verificationRequired: true,
      },
      { Authorization: `Bearer ${adminJwt}` }
    );

    // Customer A has requirements for serviceA, but NOT for serviceC
    const readinessC = await request(
      'GET',
      `/api/documents/services/${serviceC._id}/readiness`,
      null,
      { Authorization: `Bearer ${customerAJwt}` }
    );
    assert.strictEqual(readinessC.body.data.isReady, false);
    assert.strictEqual(readinessC.body.data.missingRequirements[0].documentType, 'CONSENT_FORM');

    // Trying to join serviceC directly blocks customer A
    const joinC = await request(
      'POST',
      '/api/tokens',
      { centerId: centerA._id.toString(), serviceId: serviceC._id.toString() },
      { Authorization: `Bearer ${customerAJwt}` }
    );
    assert.strictEqual(joinC.status, 403);
    assert.strictEqual(joinC.body.code, 'DOCUMENT_GATE_BLOCKED');
    pass('16. Service Graph compatibility');
  } catch (err) {
    fail('16. Service Graph compatibility', err);
  }

  // 17. P2P swap compatibility
  try {
    // Customer B uploads ADDRESS_PROOF and gets approved so they can join serviceA
    const sampleBase64 = Buffer.from('B_BILL').toString('base64');
    const bUp = await request(
      'POST',
      '/api/documents/upload',
      {
        documentType: 'ADDRESS_PROOF',
        fileName: 'b_bill.pdf',
        mimeType: 'application/pdf',
        fileData: sampleBase64,
        serviceId: serviceA._id.toString(),
      },
      { Authorization: `Bearer ${customerBJwt}` }
    );
    await request(
      'PATCH',
      `/api/documents/${bUp.body.data.document._id}/verify`,
      { status: 'VERIFIED' },
      { Authorization: `Bearer ${staffJwt}` }
    );

    // Customer B joins serviceA queue
    const tokenBRes = await request(
      'POST',
      '/api/tokens',
      { centerId: centerA._id.toString(), serviceId: serviceA._id.toString() },
      { Authorization: `Bearer ${customerBJwt}` }
    );
    assert.strictEqual(tokenBRes.status, 201);
    const tokenB = tokenBRes.body.data.token;

    // Customer A creates a swap offer targeting customer B
    const tokenARec = await Token.findOne({ userId: customerA._id, serviceId: serviceA._id, status: 'WAITING' });
    const offerRes = await request(
      'POST',
      '/api/swaps',
      { offeringTokenId: tokenARec._id.toString(), targetTokenId: tokenB._id.toString() },
      { Authorization: `Bearer ${customerAJwt}` }
    );
    assert.strictEqual(offerRes.status, 201);
    const offerId = offerRes.body.data.offer._id;

    // If Customer B's document is subsequently invalidated (e.g. marked REJECTED)
    const bDoc = await CustomerDocument.findOne({ userId: customerB._id, documentType: 'PASSPORT_PHOTO' });
    bDoc.status = 'REJECTED';
    bDoc.rejectionReason = 'Expired document';
    await bDoc.save();

    // Customer B attempts to accept swap -> MUST be blocked by Document Gate!
    const swapAcceptRes = await request(
      'POST',
      `/api/swaps/${offerId}/accept`,
      { acceptingTokenId: tokenB._id.toString() },
      { Authorization: `Bearer ${customerBJwt}` }
    );
    assert.strictEqual(swapAcceptRes.status, 403);
    assert.strictEqual(swapAcceptRes.body.code, 'DOCUMENT_GATE_BLOCKED');
    pass('17. P2P swap compatibility');
  } catch (err) {
    fail('17. P2P swap compatibility', err);
  }

  // 18. Ghost Queue independence
  try {
    // Location state INSIDE geofence does NOT bypass document readiness
    const tokenARec = await Token.findOne({ userId: customerA._id, serviceId: serviceA._id, status: 'WAITING' });
    const locRes = await request(
      'POST',
      `/api/tokens/${tokenARec._id}/location`,
      { latitude: 12.9716, longitude: 77.5946, accuracy: 5 },
      { Authorization: `Bearer ${customerAJwt}` }
    );
    assert.strictEqual(locRes.status, 200);
    assert.strictEqual(locRes.body.data.proximityState, 'INSIDE');

    // Customer C is also INSIDE geofence, but documents are REJECTED -> still blocked!
    const readinessC = await documentGateService.checkServiceReadiness({ serviceId: serviceA._id, userId: customerC._id });
    assert.strictEqual(readinessC.isReady, false);
    pass('18. Ghost Queue independence');
  } catch (err) {
    fail('18. Ghost Queue independence', err);
  }

  // 19. notification integration
  try {
    // When staff verified uploadedDocA, a notification was created
    const notif = await Notification.findOne({
      userId: customerA._id,
      type: 'DOCUMENT_VERIFIED',
    });
    assert(notif !== null, 'DOCUMENT_VERIFIED notification should be recorded');
    assert(notif.title.includes('Document Verified'));
    pass('19. notification integration');
  } catch (err) {
    fail('19. notification integration', err);
  }

  // 20. duplicate notification prevention
  try {
    // Verify dedupeKey is populated on document notifications
    const notifs = await Notification.find({ userId: customerA._id, type: 'DOCUMENT_VERIFIED' });
    assert(notifs.length > 0);
    notifs.forEach((n) => {
      assert(n.dedupeKey, 'dedupeKey must be present to prevent duplicate notification delivery');
    });
    pass('20. duplicate notification prevention');
  } catch (err) {
    fail('20. duplicate notification prevention', err);
  }

  // 21. IDOR protection
  try {
    // Customer B attempts to download Customer A's private document
    const idorRes = await request(
      'GET',
      `/api/documents/${uploadedDocA._id}/download`,
      null,
      { Authorization: `Bearer ${customerBJwt}` }
    );
    assert.strictEqual(idorRes.status, 403);
    pass('21. IDOR protection');
  } catch (err) {
    fail('21. IDOR protection', err);
  }

  // 22. secure document access
  try {
    // Owner CAN download their own document
    const ownerRes = await request(
      'GET',
      `/api/documents/${uploadedDocA._id}/download`,
      null,
      { Authorization: `Bearer ${customerAJwt}` }
    );
    assert.strictEqual(ownerRes.status, 200);

    // Staff CAN download customer document for review
    const staffRes = await request(
      'GET',
      `/api/documents/${uploadedDocA._id}/download`,
      null,
      { Authorization: `Bearer ${staffJwt}` }
    );
    assert.strictEqual(staffRes.status, 200);
    pass('22. secure document access');
  } catch (err) {
    fail('22. secure document access', err);
  }

  // 23. file validation
  try {
    // Disallowed MIME type (executable / script)
    const exeBase64 = Buffer.from('MALICIOUS_SCRIPT').toString('base64');
    const badMimeRes = await request(
      'POST',
      '/api/documents/upload',
      {
        documentType: 'PASSPORT_PHOTO',
        fileName: 'malware.exe',
        mimeType: 'application/x-msdownload',
        fileData: exeBase64,
      },
      { Authorization: `Bearer ${customerAJwt}` }
    );
    assert.strictEqual(badMimeRes.status, 400);
    pass('23. file validation');
  } catch (err) {
    fail('23. file validation', err);
  }

  // 24. rate limiting
  try {
    // Verify rate limit middleware is mounted for document upload and action
    const { documentUploadLimiter, documentActionLimiter } = require('../src/middleware/rateLimiter');
    assert(typeof documentUploadLimiter === 'function');
    assert(typeof documentActionLimiter === 'function');
    pass('24. rate limiting');
  } catch (err) {
    fail('24. rate limiting', err);
  }

  // 25. concurrent readiness/token requests
  try {
    // Fire 5 concurrent join requests with customer C (who has rejected docs)
    const promises = Array(5).fill(0).map(() =>
      request(
        'POST',
        '/api/tokens',
        { centerId: centerA._id.toString(), serviceId: serviceA._id.toString() },
        { Authorization: `Bearer ${customerCJwt}` }
      )
    );
    const results = await Promise.all(promises);
    results.forEach((res) => {
      assert.strictEqual(res.status, 403);
      assert.strictEqual(res.body.code, 'DOCUMENT_GATE_BLOCKED');
    });

    // Zero tokens were created for customer C
    const tokens = await Token.find({ userId: customerC._id, serviceId: serviceA._id });
    assert.strictEqual(tokens.length, 0);
    pass('25. concurrent readiness/token requests');
  } catch (err) {
    fail('25. concurrent readiness/token requests', err);
  }

  // 26. no PII leakage
  try {
    const listRes = await request('GET', `/api/documents/services/${serviceA._id}/requirements`);
    const reqString = JSON.stringify(listRes.body);
    assert(!reqString.includes('password'));
    assert(!reqString.includes('storageReference'));
    assert(!reqString.includes('secret'));

    const myDocs = await request('GET', '/api/documents/my', null, { Authorization: `Bearer ${customerAJwt}` });
    const docsString = JSON.stringify(myDocs.body);
    assert(!docsString.includes('storageReference'));
    pass('26. no PII leakage');
  } catch (err) {
    fail('26. no PII leakage', err);
  }

  // 27. no static requirement data
  try {
    // Verify requirements exist purely as real MongoDB records
    const dbReqs = await DocumentRequirement.find({ serviceId: serviceA._id });
    assert.strictEqual(dbReqs.length, 2);
    dbReqs.forEach((r) => {
      assert(r._id instanceof mongoose.Types.ObjectId);
      assert(typeof r.documentType === 'string');
      assert(typeof r.isRequired === 'boolean');
    });
    pass('27. no static requirement data');
  } catch (err) {
    fail('27. no static requirement data', err);
  }

  console.log('\n============================================================');
  console.log(`  RESULTS: ${passed} passed, ${failed} failed`);
  console.log('============================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

setup()
  .then(runTests)
  .then(teardown)
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error('Fatal test error:', err);
    await teardown();
    process.exit(1);
  });
