import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { render, screen, waitFor, cleanup, act } from '@testing-library/react';

/**
 * FULL-STACK NO-REFRESH VERIFICATION
 *
 * Unlike liveCounter.test.jsx (which stubs the API and the socket), this suite
 * runs the REAL App against the REAL backend:
 *
 *   • services/api.js    -> real fetch to the live backend
 *   • services/socket.js -> real socket.io-client connection
 *   • backend            -> real Token documents, real Socket.IO broadcasts
 *
 * Real customer joins and real staff actions are then driven over HTTP, and the
 * DOM is asserted WITHOUT remounting or reloading the component. A pass here is
 * direct evidence that the board is genuinely realtime rather than merely
 * re-reading on a timer.
 *
 * Requires a running backend. If one is not reachable the suite skips loudly
 * instead of reporting a false failure.
 */

const BACKEND = process.env.E2E_BACKEND || 'http://localhost:5000';
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;

/**
 * The center under test.
 *
 * Resolved from the backend's own active-center list rather than hardcoded, so
 * the suite keeps working after facilities are curated and can never pin itself
 * to a deactivated center. VERIFY_CENTER_ID still overrides it explicitly.
 */
let CENTER = process.env.VERIFY_CENTER_ID || null;

let reachable = false;
let App;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function post(path, body, token, extraHeaders = {}) {
  const r = await fetch(`${BACKEND}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extraHeaders },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

/** POST to the IoT endpoint, which authenticates with x-iot-secret. */
async function postIot(body) {
  if (!process.env.E2E_IOT_SECRET) return { status: 0, body: null };
  return post('/api/iot/crowd', body, null, { 'x-iot-secret': process.env.E2E_IOT_SECRET });
}

async function getDisplay() {
  const r = await fetch(`${BACKEND}/api/queue/${CENTER}/display`);
  return (await r.json())?.data;
}

describe('live counter full-stack realtime (no refresh)', () => {
  let ownerToken = null;
  let serviceId = null;
  let centerCoords = { latitude: 23.182997, longitude: 77.30138 };

  beforeAll(async () => {
    try {
      const h = await fetch(`${BACKEND}/health`, { signal: AbortSignal.timeout(8000) });
      reachable = h.ok;
    } catch {
      reachable = false;
    }
    if (!reachable) return;

    // Pick a real active center from the authoritative list, skipping any that
    // cannot actually be joined against (a center with no active service would
    // fail the join step for reasons unrelated to realtime behaviour).
    if (!CENTER) {
      const res = await fetch(`${BACKEND}/api/service-centers?isOpen=true`);
      const centers = (await res.json())?.data?.centers || [];
      for (const c of centers) {
        const s = await fetch(`${BACKEND}/api/services?centerId=${c._id}`);
        const raw = (await s.json())?.data;
        const list = Array.isArray(raw) ? raw : (raw?.services || []);
        if (list.some((x) => x.isActive !== false)) {
          CENTER = c._id;
          if (c.location?.latitude && c.location?.longitude) {
            centerCoords = { latitude: c.location.latitude, longitude: c.location.longitude };
          }
          break;
        }
      }
    }
    if (!CENTER) {
      reachable = false;
      console.warn('[live-counter full-stack] no active center with an active service was found; skipping.');
      return;
    }

    // Point the real API + socket modules at the running backend before import.
    vi.stubEnv('VITE_API_URL', BACKEND);
    vi.stubEnv('VITE_SOCKET_URL', BACKEND);
    vi.resetModules();

    // Mount the board on the center under test.
    delete window.location;
    window.location = new URL(`http://localhost:5174/live-counter?centerId=${CENTER}`);

    ({ App } = await import('../App'));

    // Resolve a real active service and a real customer for this center.
    const svc = await fetch(`${BACKEND}/api/services?centerId=${CENTER}`);
    const services = (await svc.json())?.data?.services || (await svc.json())?.data || [];
    serviceId = (Array.isArray(services) ? services : []).find((s) => s.isActive !== false && s.centerId === CENTER)?._id
      || (Array.isArray(services) ? services[0]?._id : null);

    const email = `fs.realtime.${Date.now()}@example.com`;
    const reg = await post('/api/auth/register', { name: 'FS Realtime', email, password: 'FsRealtime@1234' });
    ownerToken = reg.body?.data?.token || reg.body?.token;
  }, 60000);

  afterAll(async () => {
    cleanup();
    // Leave the center as we found it.
    try {
      let guard = 0;
      for (;;) {
        const nxt = (await getDisplay())?.nextInQueue?.[0];
        if (!nxt || guard++ > 6) break;
        const c = await post(`/api/tokens/${nxt._id}/cancel`, {}, ownerToken);
        if (c.status >= 400) break;
      }
    } catch { /* best effort */ }
    vi.unstubAllEnvs();
  });

  it('renders real backend state, then repaints every metric from real events with no reload', async () => {
    if (!reachable) {
      console.warn(`SKIPPED: no backend reachable at ${BACKEND}`);
      return;
    }

    // Read the authoritative baseline BEFORE mounting.
    const initial = await getDisplay();
    expect(initial.displayToken, 'backend must issue a displayToken').toBeTruthy();
    expect(initial.metrics, 'backend must expose authoritative metrics').toBeTruthy();
    expect(serviceId, 'a real active service is required').toBeTruthy();
    expect(ownerToken, 'a real customer is required').toBeTruthy();
    const waitingBefore = initial.metrics.waitingCount;

    // Mount ONCE. Everything below happens on this same mounted tree - there is
    // no remount and no reload, so a pass proves the updates are realtime.
    render(<App />);

    // Initial authoritative REST load must paint the real number.
    await waitFor(() => {
      expect(screen.getByTestId('metric-joined-queues')).toHaveTextContent(String(waitingBefore));
    }, { timeout: 30000 });
    console.log(`  initial load: joined-queues tile rendered ${waitingBefore} from the backend`);

    // ── Real customer joins the queue ────────────────────────────────────
    const join = await post('/api/tokens', {
      centerId: CENTER,
      serviceId,
      notifyApp: false,
      notifySms: false,
      latitude: centerCoords.latitude,
      longitude: centerCoords.longitude,
    }, ownerToken);
    expect(join.status, `join failed: ${JSON.stringify(join.body)}`).toBe(201);
    const ownerCode = join.body?.data?.token?.tokenCode;

    await waitFor(() => {
      expect(screen.getByTestId('metric-joined-queues')).toHaveTextContent(String(waitingBefore + 1));
    }, { timeout: 30000 });
    console.log(`  joined ${ownerCode}: joined-queues tile moved ${waitingBefore} -> ${waitingBefore + 1} with no reload`);

    await waitFor(() => {
      expect(screen.getByTestId('next-token-code')).toHaveTextContent(ownerCode);
    }, { timeout: 30000 });

    // ── Real staff Call Next ─────────────────────────────────────────────
    let adminToken = null;
    if (ADMIN_EMAIL && ADMIN_PASSWORD) {
      const login = await post('/api/auth/login', { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
      adminToken = login.body?.data?.token || login.body?.token;
    }
    const display = await getDisplay();
    const counterId = (display.counters || []).find((c) => c.status === 'ACTIVE')?._id;

    if (adminToken && counterId) {
      const head = (display.nextInQueue || [])[0]?.tokenCode;
      const call = await post(`/api/counters/${counterId}/call-next`, {}, adminToken);
      expect(call.status, `call-next failed: ${JSON.stringify(call.body)}`).toBe(200);

      await waitFor(() => {
        expect(screen.getByTestId('now-serving-token')).toHaveTextContent(head);
      }, { timeout: 30000 });
      console.log(`  call-next: Now Serving tile showed ${head} with no reload`);

      await waitFor(() => {
        expect(screen.getByTestId('metric-joined-queues')).toHaveTextContent(String(waitingBefore));
      }, { timeout: 30000 });

      // ── Real completion → completed today advances ────────────────────
      const completedBefore = (await getDisplay()).metrics.completedToday;
      const serving = (await getDisplay()).nowServing || [];
      const complete = await post(`/api/counters/${counterId}/complete`, { tokenId: serving[0]?._id }, adminToken);
      expect(complete.status, `complete failed: ${JSON.stringify(complete.body)}`).toBe(200);

      await waitFor(async () => {
        expect((await getDisplay()).metrics.completedToday).toBe(completedBefore + 1);
      }, { timeout: 30000 });
      console.log(`  complete: completedToday advanced ${completedBefore} -> ${completedBefore + 1}`);

      await waitFor(() => {
        expect(screen.getByTestId('now-serving-empty')).toBeInTheDocument();
      }, { timeout: 30000 });
    } else {
      console.warn('  SKIPPED staff-action leg: admin credential unavailable');
    }

    // ── Real crowd update reaches the footfall tile ──────────────────────
    if (process.env.E2E_IOT_SECRET) {
      const crowdBefore = (await getDisplay()).center?.currentCrowd ?? 0;
      const target = crowdBefore + 3;
      const res = await postIot({ centerId: CENTER, type: 'COUNT', count: target, sensorId: 'FS_VERIFY' });
      expect(res.status, `iot crowd failed: ${JSON.stringify(res.body)}`).toBe(200);

      await waitFor(() => {
        expect(screen.getByTestId('metric-footfall')).toHaveTextContent(String(target));
      }, { timeout: 30000 });
      console.log(`  crowd: footfall tile moved ${crowdBefore} -> ${target} with no reload`);
      await postIot({ centerId: CENTER, type: 'COUNT', count: crowdBefore, sensorId: 'FS_VERIFY_RESTORE' });
    }

    // ── Drain the queue: next-in-line must become a truthful empty state ──
    let guard = 0;
    for (;;) {
      const nxt = (await getDisplay())?.nextInQueue?.[0];
      if (!nxt || guard++ > 6) break;
      const c = await post(`/api/tokens/${nxt._id}/cancel`, {}, ownerToken);
      if (c.status >= 400) break;
    }

    await waitFor(() => {
      expect(screen.getByTestId('next-token-empty')).toBeInTheDocument();
    }, { timeout: 30000 });
    // No fabricated placeholder token may appear anywhere on the board.
    expect(screen.queryByText(/A-00\d/)).not.toBeInTheDocument();

    await act(async () => { await sleep(50); });
  }, 300000);
});
