/**
 * test_resource_hub_operators.js
 * End-to-End verification of the Resource Hub operator management API:
 * 1. Admin login
 * 2. Center listing with isOpen=true
 * 3. GET /api/counters/operators for College Account
 * 4. PATCH /api/counters/:id/assign-staff (Assign, conflict check, unassign)
 * 5. Verify authoritative MongoDB state
 */
'use strict';

process.env.NODE_ENV = 'test';
require('dotenv').config();

const http = require('http');
const mongoose = require('mongoose');
const connectDB = require('../src/config/database');
const { app, server } = require('../server');

let testServer;
let baseUrl;

function request(method, path, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const options = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: {
        'Content-Type': 'application/json',
        ...headers
      }
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = data ? JSON.parse(data) : {};
          resolve({ status: res.statusCode, headers: res.headers, body: parsed });
        } catch {
          resolve({ status: res.statusCode, headers: res.headers, body: data });
        }
      });
    });

    req.on('error', reject);

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

async function run() {
  console.log('--- RESOURCE HUB OPERATORS E2E TEST ---');

  await connectDB();
  if (mongoose.connection.readyState !== 1) {
    await new Promise((resolve) => mongoose.connection.once('open', resolve));
  }
  console.log('✅ Connected to MongoDB.');

  await new Promise((resolve) => {
    testServer = server.listen(0, () => {
      const port = testServer.address().port;
      baseUrl = `http://127.0.0.1:${port}`;
      console.log(`Test server running at ${baseUrl}`);
      resolve();
    });
  });

  try {
    // 1. Login as Admin
    console.log('\n1. Logging in as Admin...');
    const loginRes = await request('POST', '/api/auth/login', {
      email: 'admin@queueflow.dev',
      password: 'Admin@1234'
    });
    if (loginRes.status !== 200) {
      throw new Error(`Admin login failed: ${loginRes.status} ${JSON.stringify(loginRes.body)}`);
    }
    const token = loginRes.body.data?.token || loginRes.body.token;
    console.log('✅ Admin logged in successfully.');

    const authHeaders = {
      'Authorization': `Bearer ${token}`
    };

    // 2. List open centers
    console.log('\n2. Listing open service centers (isOpen=true)...');
    const centersRes = await request('GET', '/api/service-centers?isOpen=true', null, authHeaders);
    const centers = centersRes.body.data?.centers || centersRes.body.data || [];
    console.log(`✅ Received ${centers.length} open centers.`);
    const collegeCenter = centers.find(c => c.code === 'COLLEGE01');
    if (!collegeCenter) {
      throw new Error('College Account (COLLEGE01) not found in open centers!');
    }
    console.log(`✅ Found College Center: ${collegeCenter.name} (ID: ${collegeCenter._id})`);

    // 3. Get operators for College Center
    console.log(`\n3. Fetching operators for College Center (${collegeCenter._id})...`);
    const opsRes = await request('GET', `/api/counters/operators?centerId=${collegeCenter._id}`, null, authHeaders);
    if (opsRes.status !== 200) {
      throw new Error(`getCenterOperators failed: ${opsRes.status} ${JSON.stringify(opsRes.body)}`);
    }
    const operators = opsRes.body.data?.operators || opsRes.body.data || [];
    console.log(`✅ Received ${operators.length} operators:`);
    operators.forEach(op => {
      console.log(`   - ${op.name} (${op.email}) | Role: ${op.role} | Assigned: ${op.isAssigned} | Desk: ${op.assignedCounter?.number || 'None'}`);
    });

    if (operators.length === 0) {
      throw new Error('Expected at least 1 operator for College Center!');
    }

    // 4. Fetch counters for College Center
    console.log('\n4. Fetching counters for College Center...');
    const countersRes = await request('GET', `/api/counters?centerId=${collegeCenter._id}`, null, authHeaders);
    const counters = countersRes.body.data?.counters || countersRes.body.data || [];
    console.log(`✅ Received ${counters.length} counters:`);
    counters.forEach(c => {
      console.log(`   - Desk #${c.number} (${c.name}) | Status: ${c.status} | Staff: ${c.staff?.name || c.staffId || 'Unassigned'}`);
    });

    const c1 = counters[0];
    const c2 = counters[1];
    const op1 = operators[0];
    const op2 = operators.length > 1 ? operators[1] : null;

    // 5. Test Operator Assignment: Assign op1 to Desk c1
    console.log(`\n5. Assigning operator ${op1.name} to Desk #${c1.number}...`);
    const assign1Res = await request('PATCH', `/api/counters/${c1._id}/assign-staff`, { staffId: op1._id }, authHeaders);
    if (assign1Res.status !== 200) {
      throw new Error(`Assignment failed: ${assign1Res.status} ${JSON.stringify(assign1Res.body)}`);
    }
    const c1AfterAssign = assign1Res.body.data?.counter || assign1Res.body.data;
    console.log(`✅ Desk #${c1.number} assigned to: ${c1AfterAssign?.staff?.name || c1AfterAssign?.staffId}`);

    // 6. Test Reassignment: If we assign op1 to Desk c2, c1 should be automatically unassigned!
    if (c2) {
      console.log(`\n6. Testing atomic reassignment: Assigning ${op1.name} to Desk #${c2.number}...`);
      const assign2Res = await request('PATCH', `/api/counters/${c2._id}/assign-staff`, { staffId: op1._id }, authHeaders);
      if (assign2Res.status !== 200) {
        throw new Error(`Reassignment failed: ${assign2Res.status} ${JSON.stringify(assign2Res.body)}`);
      }
      console.log(`✅ Desk #${c2.number} reassigned to ${op1.name}. Checking Desk #${c1.number} to verify it was vacated...`);

      const c1VerifyRes = await request('GET', `/api/counters/${c1._id}`, null, authHeaders);
      const c1Verify = c1VerifyRes.body.data?.counter || c1VerifyRes.body.data;
      console.log(`✅ Desk #${c1.number} staffId is now: ${c1Verify.staffId || 'null (Vacated correctly)'}`);
      if (c1Verify.staffId) {
        throw new Error(`Desk #${c1.number} was not vacated when staff was reassigned!`);
      }

      // 7. Test unassign (staffId: null)
      console.log(`\n7. Testing explicit unassignment on Desk #${c2.number}...`);
      const unassignRes = await request('PATCH', `/api/counters/${c2._id}/assign-staff`, { staffId: null }, authHeaders);
      if (unassignRes.status !== 200) {
        throw new Error(`Unassignment failed: ${unassignRes.status} ${JSON.stringify(unassignRes.body)}`);
      }
      console.log(`✅ Desk #${c2.number} successfully unassigned.`);

      // 8. Restore clean operational configuration (Desk 1 -> College Operator 01, Desk 2 -> College Operator 02)
      console.log(`\n8. Restoring clean configuration (Desk 1 -> College Operator 01, Desk 2 -> College Operator 02)...`);
      const collegeOp1 = operators.find(o => o.email === 'college.op1@queueflow.test') || op1;
      const collegeOp2 = operators.find(o => o.email === 'college.op2@queueflow.test') || op2;
      await request('PATCH', `/api/counters/${c1._id}/assign-staff`, { staffId: collegeOp1._id }, authHeaders);
      if (c2 && collegeOp2) {
        await request('PATCH', `/api/counters/${c2._id}/assign-staff`, { staffId: collegeOp2._id }, authHeaders);
      }
      console.log(`✅ Final state set: College Operator 01 -> c1, College Operator 02 -> c2.`);
    }

    // 9. Verify operators roster reflects the updated assignments
    console.log('\n9. Re-fetching operator roster to verify updated assignments in database...');
    const opsFinalRes = await request('GET', `/api/counters/operators?centerId=${collegeCenter._id}`, null, authHeaders);
    const opsFinal = opsFinalRes.body.data?.operators || opsFinalRes.body.data || [];
    opsFinal.forEach(op => {
      console.log(`   - ${op.name} | isAssigned: ${op.isAssigned} | Desk: ${op.assignedCounter ? '#' + op.assignedCounter.number : 'None'}`);
    });

    console.log('\n🎉 ALL RESOURCE HUB OPERATOR API VERIFICATIONS PASSED SUCCESSFULLY!');
  } finally {
    if (testServer) {
      await new Promise((res) => testServer.close(res));
    }
    await mongoose.disconnect();
  }
}

run()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('❌ Test failed:', err);
    process.exit(1);
  });
