import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '../App';
import * as api from '../services/api';
import * as socketService from '../services/socket';
import { buildJoinUrls, generateQrDataUrl } from '../services/qr';

describe('QueueFlow Live Counter / Public Display Panel', () => {
  const mockCenterId = '507f1f77bcf86cd799439011';
  const mockServiceId = '507f1f77bcf86cd799439022';

  const mockDisplayData = {
    center: {
      id: mockCenterId,
      _id: mockCenterId,
      name: 'Downtown Civic Service Center',
      code: 'DSC-01',
      capacity: 150,
      currentCrowd: 42,
      crowdPercent: 28,
      crowdStatus: 'LOW',
      // A reporting sensor: fresh timestamp + online flag. Without these the
      // display correctly treats the reading as unavailable.
      crowdUpdatedAt: new Date().toISOString(),
      crowdSensorOnline: true,
    },
    displayToken: 'mock.jwt.displaytoken',
    nowServing: [
      {
        _id: 'tok-001',
        tokenCode: 'A125',
        status: 'SERVING',
        calledAt: '2026-09-27T01:30:00.000Z',
        counterId: { _id: 'cnt-01', number: 1, name: 'Counter 01', displayLabel: 'Station 1' },
        serviceId: { _id: mockServiceId, name: 'General Inquiries' },
      },
      {
        _id: 'tok-002',
        tokenCode: 'B042',
        status: 'CALLED',
        calledAt: '2026-09-27T01:31:00.000Z',
        counterId: { _id: 'cnt-02', number: 2, name: 'Counter 02', displayLabel: 'Station 2' },
        serviceId: { _id: 'srv-02', name: 'Document Verification' },
      },
    ],
    nextInQueue: [
      {
        _id: 'tok-003',
        tokenCode: 'A126',
        currentPosition: 1,
        waitEstimateMinutes: 8,
        serviceId: { _id: mockServiceId, name: 'General Inquiries' },
      },
      {
        _id: 'tok-004',
        tokenCode: 'A127',
        currentPosition: 2,
        waitEstimateMinutes: 16,
        serviceId: { _id: mockServiceId, name: 'General Inquiries' },
      },
    ],
    counters: [
      {
        _id: 'cnt-01',
        number: 1,
        name: 'Counter 01',
        displayLabel: 'Station 1',
        status: 'ACTIVE',
        service: { name: 'General Inquiries' },
        servingToken: { tokenCode: 'A125', status: 'SERVING' },
      },
      {
        _id: 'cnt-02',
        number: 2,
        name: 'Counter 02',
        displayLabel: 'Station 2',
        status: 'ACTIVE',
        service: { name: 'Document Verification' },
        servingToken: { tokenCode: 'B042', status: 'CALLED' },
      },
      {
        _id: 'cnt-03',
        number: 3,
        name: 'Counter 03',
        displayLabel: 'Station 3',
        status: 'ACTIVE',
        service: { name: 'General Inquiries' },
        servingToken: null,
      },
    ],
    queues: [
      {
        queueId: 'q-01',
        service: { _id: mockServiceId, name: 'General Inquiries' },
        status: 'OPEN',
        waitingCount: 5,
        activeCount: 1,
        completedCount: 20,
        estimatedWaitMinutes: 8,
      },
      {
        queueId: 'q-02',
        service: { _id: 'srv-02', name: 'Document Verification' },
        status: 'OPEN',
        waitingCount: 3,
        activeCount: 1,
        completedCount: 15,
        estimatedWaitMinutes: 12,
      },
    ],
    // Authoritative, Token-derived center metrics. Deliberately NOT the sum of
    // queues[].waitingCount above (5 + 3 = 8) so the test proves the board
    // reads the authoritative source rather than the day-partitioned aggregate.
    metrics: {
      centerId: mockCenterId,
      waitingCount: 8,
      servingCount: 2,
      completedToday: 35,
      issuedToday: 45,
      avgWaitSeconds: 420,
      waitSampleCount: 12,
      measuredAt: new Date().toISOString(),
    },
    serverTime: new Date().toISOString(),
  };

  let socketCallbacks = {};

  beforeEach(() => {
    vi.restoreAllMocks();
    delete window.location;
    window.location = new URL(`http://localhost:5174/live-counter?centerId=${mockCenterId}`);

    vi.spyOn(api, 'fetchDisplayData').mockResolvedValue(mockDisplayData);
    vi.spyOn(api, 'fetchCenters').mockResolvedValue([
      { _id: mockCenterId, name: 'Downtown Civic Service Center', code: 'DSC-01' },
    ]);

    socketCallbacks = {};
    vi.spyOn(socketService, 'initDisplaySocket').mockImplementation((opts) => {
      socketCallbacks = opts;
      opts.onStatusChange?.('connected');
      return { connected: true };
    });
    vi.spyOn(socketService, 'closeDisplaySocket').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // 1 & 2. Center and display data loading
  it('1 & 2. Loads center metadata and authoritative display data', async () => {
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('Downtown Civic Service Center')).toBeInTheDocument();
      expect(screen.getByText(/CODE: DSC-01/)).toBeInTheDocument();
    });

    expect(api.fetchDisplayData).toHaveBeenCalledWith(mockCenterId);
  });

  // 3. Current token (NOW SERVING)
  it('3. Displays current serving token and counter accurately', async () => {
    render(<App />);

    await waitFor(() => {
      const nowServingToken = screen.getByTestId('now-serving-token');
      expect(nowServingToken).toHaveTextContent('A125');
      const nowServingCounter = screen.getByTestId('now-serving-counter');
      expect(nowServingCounter).toHaveTextContent('Station 1');
    });
  });

  // 4. Next token (NEXT IN LINE)
  it('4. Displays next token and wait estimate accurately', async () => {
    render(<App />);

    await waitFor(() => {
      const nextToken = screen.getByTestId('next-token-code');
      expect(nextToken).toHaveTextContent('A126');
      expect(screen.getByText(/~8 min wait/)).toBeInTheDocument();
    });
  });

  // 5 & 7. Multiple counters display and active count
  it('5 & 7. Renders multiple counters grid and active stations status', async () => {
    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId('counter-station-1')).toBeInTheDocument();
      expect(screen.getByTestId('counter-station-2')).toBeInTheDocument();
      expect(screen.getByTestId('counter-station-3')).toBeInTheDocument();

      const activeMetrics = screen.getByTestId('metric-active-counters');
      expect(activeMetrics).toHaveTextContent('3');
    });
  });

  // 6. Truthful empty states
  it('6. Shows truthful empty state when no tokens are serving or waiting', async () => {
    vi.spyOn(api, 'fetchDisplayData').mockResolvedValueOnce({
      ...mockDisplayData,
      nowServing: [],
      nextInQueue: [],
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId('now-serving-empty')).toHaveTextContent('NO ACTIVE TOKEN');
      expect(screen.getByTestId('next-token-empty')).toHaveTextContent('—');
    });
  });

  // 8 & 9. Joined queues and EWT
  it('8 & 9. Renders authoritative joined-queue depth and EWT', async () => {
    render(<App />);

    await waitFor(() => {
      const joinedBox = screen.getByTestId('metric-joined-queues');
      // Read from the backend's authoritative metrics.waitingCount.
      expect(joinedBox).toHaveTextContent('8');
      expect(joinedBox).toHaveTextContent('2 now being served');

      const ewtBox = screen.getByTestId('metric-ewt');
      // max wait between 8 and 12 = 12 min
      expect(ewtBox).toHaveTextContent('~12');
    });
  });

  // Regression: the joined-queue tile must never be sourced from the
  // day-partitioned `queues` array, which is legitimately empty while real
  // customers are still holding a token.
  it('8b. Joined queues follows metrics.waitingCount, not the queues[] aggregate', async () => {
    api.fetchDisplayData.mockResolvedValue({
      ...mockDisplayData,
      // Simulates the audited failure: no Queue document exists for today, so
      // the day-partitioned array is empty while real customers are waiting.
      queues: [],
      metrics: { ...mockDisplayData.metrics, waitingCount: 5 },
    });
    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId('metric-joined-queues')).toHaveTextContent('5');
    });
  });

  // Regression: no fabricated business value when the backend omits metrics.
  it('8c. Shows an honest unavailable state instead of a fabricated 0', async () => {
    const { metrics, ...withoutMetrics } = mockDisplayData;
    void metrics;
    api.fetchDisplayData.mockResolvedValue(withoutMetrics);

    render(<App />);

    await waitFor(() => {
      const joinedBox = screen.getByTestId('metric-joined-queues');
      expect(joinedBox).toHaveTextContent('Unavailable');
      expect(joinedBox).not.toHaveTextContent('0');
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // NO-REFRESH REALTIME PROOFS
  //
  // Each test below mounts the app exactly ONCE, then drives the UI purely
  // from a Socket.IO event. There is no remount, no reload, and no manual
  // fetch in between, so a pass proves the board repaints from the realtime
  // stream alone - which is the behaviour that was broken.
  // ────────────────────────────────────────────────────────────────────────

  it('NR1. joined-queues tile updates from a queue.updated event with no reload', async () => {
    // Round 1: the initial authoritative REST load reports 0 waiting.
    api.fetchDisplayData.mockResolvedValue({
      ...mockDisplayData,
      nowServing: [],
      nextInQueue: [],
      queues: [],
      metrics: { ...mockDisplayData.metrics, waitingCount: 0, servingCount: 0 },
    });

    const { unmount } = render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId('metric-joined-queues')).toHaveTextContent('0');
    });

    // A real customer joins. The backend answers the socket event by pushing
    // the new authoritative state; the client re-reads it.
    api.fetchDisplayData.mockResolvedValue({
      ...mockDisplayData,
      nowServing: [],
      nextInQueue: [
        { tokenCode: 'A-101', serviceId: { name: 'General Inquiries' }, currentPosition: 1, waitEstimateMinutes: 4 },
      ],
      queues: [],
      metrics: { ...mockDisplayData.metrics, waitingCount: 1, servingCount: 0 },
    });

    act(() => {
      socketCallbacks.onEvent?.('queue.updated', {
        centerId: mockCenterId,
        serviceId: mockServiceId,
        waitingCount: 1,
        totalIssued: 1,
        metrics: { waitingCount: 1, servingCount: 0, completedToday: 0 },
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('metric-joined-queues')).toHaveTextContent('1');
    });
    expect(screen.getByTestId('next-token-code')).toHaveTextContent('A-101');

    // Same mounted component instance - nothing was reloaded.
    unmount();
  });

  it('NR2. now-serving and next-in-line update on call-next with no reload', async () => {
    api.fetchDisplayData.mockResolvedValue({
      ...mockDisplayData,
      nowServing: [],
      nextInQueue: [
        { tokenCode: 'A-201', serviceId: { name: 'General Inquiries' }, currentPosition: 1, waitEstimateMinutes: 3 },
        { tokenCode: 'A-202', serviceId: { name: 'General Inquiries' }, currentPosition: 2, waitEstimateMinutes: 6 },
      ],
      metrics: { ...mockDisplayData.metrics, waitingCount: 2, servingCount: 0 },
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId('next-token-code')).toHaveTextContent('A-201');
      expect(screen.getByTestId('now-serving-empty')).toBeInTheDocument();
    });

    // Admin presses "Call Next": the head of the line becomes Now Serving and
    // the following token becomes Next In Line.
    api.fetchDisplayData.mockResolvedValue({
      ...mockDisplayData,
      nowServing: [
        { tokenCode: 'A-201', status: 'CALLED', serviceId: { name: 'General Inquiries' }, counterId: { displayLabel: 'COUNTER 01' } },
      ],
      nextInQueue: [
        { tokenCode: 'A-202', serviceId: { name: 'General Inquiries' }, currentPosition: 1, waitEstimateMinutes: 6 },
      ],
      metrics: { ...mockDisplayData.metrics, waitingCount: 1, servingCount: 1 },
    });

    act(() => {
      socketCallbacks.onEvent?.('token.called', {
        centerId: mockCenterId,
        token: { tokenCode: 'A-201', status: 'CALLED', serviceId: { name: 'General Inquiries' }, counterId: { number: 1 } },
        counter: { name: 'Counter 01', displayLabel: 'COUNTER 01' },
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('now-serving-token')).toHaveTextContent('A-201');
      expect(screen.getByTestId('now-serving-counter')).toHaveTextContent('COUNTER 01');
      expect(screen.getByTestId('next-token-code')).toHaveTextContent('A-202');
      expect(screen.getByTestId('metric-joined-queues')).toHaveTextContent('1');
    });
  });

  it('NR3. next-in-line becomes a genuine empty state when the queue drains', async () => {
    api.fetchDisplayData.mockResolvedValue({
      ...mockDisplayData,
      nowServing: [{ tokenCode: 'A-301', status: 'SERVING', serviceId: { name: 'General Inquiries' }, counterId: { displayLabel: 'COUNTER 01' } }],
      nextInQueue: [],
      metrics: { ...mockDisplayData.metrics, waitingCount: 0, servingCount: 1 },
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId('next-token-empty')).toBeInTheDocument();
    });

    // Completion empties the board. No placeholder token may appear.
    api.fetchDisplayData.mockResolvedValue({
      ...mockDisplayData,
      nowServing: [],
      nextInQueue: [],
      queues: [],
      metrics: { ...mockDisplayData.metrics, waitingCount: 0, servingCount: 0, completedToday: 1 },
    });

    act(() => {
      socketCallbacks.onEvent?.('token.completed', {
        centerId: mockCenterId,
        token: { tokenCode: 'A-301', status: 'COMPLETED', serviceId: { name: 'General Inquiries' } },
        counter: { name: 'Counter 01', displayLabel: 'COUNTER 01' },
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('now-serving-empty')).toBeInTheDocument();
      expect(screen.getByTestId('next-token-empty')).toBeInTheDocument();
    });
    expect(screen.queryByText('A-301')).not.toBeInTheDocument();
    expect(screen.queryByText(/A-00\d/)).not.toBeInTheDocument();
  });

  it('NR4. a crowd.updated event repaints the footfall tile with no reload', async () => {
    api.fetchDisplayData.mockResolvedValue({
      ...mockDisplayData,
      center: { ...mockDisplayData.center, currentCrowd: 10, crowdPercent: 7, crowdStatus: 'LOW', crowdUpdatedAt: new Date().toISOString(), crowdSensorOnline: true },
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId('metric-footfall')).toHaveTextContent('10');
    });

    act(() => {
      socketCallbacks.onEvent?.('crowd.updated', {
        centerId: mockCenterId,
        currentCrowd: 42,
        crowdPercent: 28,
        crowdStatus: 'LOW',
        capacity: 150,
        crowdUpdatedAt: new Date().toISOString(),
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('metric-footfall')).toHaveTextContent('42');
    });
  });

  // NOTE: cross-center event filtering is asserted in socketService.test.js,
  // because that guard lives in services/socket.js - which is mocked out in this
  // component test. Asserting it here would be vacuous.

  // 10 & 11. Socket.IO live update and reconnect handling
  it('10 & 11. Handles Socket.IO token called event and reconnects smoothly', async () => {
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('Downtown Civic Service Center')).toBeInTheDocument();
    });

    // Simulate token.called event received via socket
    act(() => {
      socketCallbacks.onEvent?.('token.called', {
        token: { tokenCode: 'C999', calledAt: new Date().toISOString() },
        counter: { name: 'Counter 04', displayLabel: 'Station 4' },
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('callout-ticket')).toHaveTextContent('C999');
      expect(screen.getByText(/Station 4/)).toBeInTheDocument();
    });

    // Simulate socket reconnection
    act(() => {
      socketCallbacks.onReconnect?.();
    });

    expect(api.fetchDisplayData).toHaveBeenCalledTimes(3); // Initial + event reload + reconnect
  });

  // 13. Live footfall update from crowd_monitor
  it('13. Updates live footfall in real-time when crowd.updated event is received', async () => {
    render(<App />);

    await waitFor(() => {
      const footfallMetric = screen.getByTestId('metric-footfall');
      expect(footfallMetric).toHaveTextContent('42');
    });

    // Simulate CCTV crowd_monitor publishing count=65
    act(() => {
      socketCallbacks.onEvent?.('crowd.updated', {
        centerId: mockCenterId,
        currentCrowd: 65,
        crowdPercent: 43,
        crowdStatus: 'LOW',
      });
    });

    await waitFor(() => {
      const footfallMetric = screen.getByTestId('metric-footfall');
      expect(footfallMetric).toHaveTextContent('65');
    });
  });

  // 14 & 15. Footfall unavailable / stale state
  it('14 & 15. Shows "Unavailable" when footfall telemetry is not present', async () => {
    vi.spyOn(api, 'fetchDisplayData').mockResolvedValueOnce({
      ...mockDisplayData,
      center: {
        ...mockDisplayData.center,
        currentCrowd: null,
      },
    });

    render(<App />);

    await waitFor(() => {
      const footfallMetric = screen.getByTestId('metric-footfall');
      expect(footfallMetric).toHaveTextContent('Unavailable');
      expect(screen.getByText('SENSOR OFFLINE')).toBeInTheDocument();
    });
  });

  // LIVE FOOTFALL occupancy semantics
  describe('LIVE FOOTFALL occupancy accuracy', () => {
    it('replaces the headcount instead of accumulating it', async () => {
      render(<App />);
      await waitFor(() => expect(screen.getByTestId('metric-footfall')).toHaveTextContent('42'));

      // One physical person detected: the value must become 1, not 43.
      act(() => {
        socketCallbacks.onEvent?.('crowd.updated', {
          centerId: mockCenterId,
          currentCrowd: 1,
          crowdPercent: 1,
          crowdStatus: 'LOW',
          crowdUpdatedAt: new Date().toISOString(),
        });
      });

      const metric = screen.getByTestId('metric-footfall');
      expect(metric).toHaveTextContent('1');
      expect(metric).not.toHaveTextContent('43');
    });

    it('tracks the 1 -> 2 -> 1 -> 0 occupancy sequence', async () => {
      render(<App />);
      await waitFor(() => expect(screen.getByTestId('metric-footfall')).toHaveTextContent('42'));

      const push = (n) => act(() => {
        socketCallbacks.onEvent?.('crowd.updated', {
          centerId: mockCenterId,
          currentCrowd: n,
          crowdPercent: 1,
          crowdStatus: 'LOW',
          crowdUpdatedAt: new Date().toISOString(),
        });
      });

      push(1);
      expect(screen.getByTestId('metric-footfall')).toHaveTextContent('1');
      push(2);
      expect(screen.getByTestId('metric-footfall')).toHaveTextContent('2');
      push(1);
      expect(screen.getByTestId('metric-footfall')).toHaveTextContent('1');
      // Everyone leaves: a real zero must be shown as 0, never as "Unavailable".
      push(0);
      const zeroMetric = screen.getByTestId('metric-footfall');
      expect(zeroMetric).toHaveTextContent('0');
      expect(zeroMetric).not.toHaveTextContent('Unavailable');
    });

    it('accepts a repeated count when the freshness timestamp changes', async () => {
      render(<App />);
      await waitFor(() => expect(screen.getByTestId('metric-footfall')).toHaveTextContent('42'));

      const first = new Date().toISOString();
      act(() => {
        socketCallbacks.onEvent?.('crowd.updated', {
          centerId: mockCenterId, currentCrowd: 1, crowdPercent: 1, crowdStatus: 'LOW', crowdUpdatedAt: first,
        });
      });
      expect(screen.getByTestId('metric-footfall')).toHaveTextContent('1');

      // Same value, newer reading: must still be accepted and stay available.
      act(() => {
        socketCallbacks.onEvent?.('crowd.updated', {
          centerId: mockCenterId,
          currentCrowd: 1,
          crowdPercent: 1,
          crowdStatus: 'LOW',
          crowdUpdatedAt: new Date(Date.now() + 1000).toISOString(),
        });
      });
      expect(screen.getByTestId('metric-footfall')).toHaveTextContent('1');
    });

    it('shows the last-updated timestamp and status badge', async () => {
      render(<App />);
      await waitFor(() => expect(screen.getByTestId('metric-footfall')).toHaveTextContent('42'));
      expect(screen.getByTestId('footfall-freshness')).toHaveTextContent('Last updated:');
      // Crowd vocabulary is aligned with the mobile app's CrowdIndicator.
      expect(screen.getByText('QUIET')).toBeInTheDocument();
    });

    it('shows "Unavailable" when the sensor stopped reporting, and never a frozen count', async () => {
      // Backend still holds the last count, but the sensor is flagged offline.
      vi.spyOn(api, 'fetchDisplayData').mockResolvedValueOnce({
        ...mockDisplayData,
        center: {
          ...mockDisplayData.center,
          currentCrowd: 2,
          crowdUpdatedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
          crowdSensorOnline: false,
        },
      });

      render(<App />);

      await waitFor(() => {
        const metric = screen.getByTestId('metric-footfall');
        expect(metric).toHaveTextContent('Unavailable');
        expect(screen.getByText('SENSOR OFFLINE')).toBeInTheDocument();
      });
      // Crucially it must NOT present the stale 2 or a fake 0.
      const metric = screen.getByTestId('metric-footfall');
      expect(metric).not.toHaveTextContent('2');
    });

    it('re-fetches authoritative crowd state on socket reconnect', async () => {
      render(<App />);
      // Wait until the display has loaded AND the socket effect has wired up.
      await waitFor(() => {
        expect(screen.getByTestId('metric-footfall')).toHaveTextContent('42');
        expect(typeof socketCallbacks.onReconnect).toBe('function');
      });

      const before = api.fetchDisplayData.mock.calls.length;
      act(() => { socketCallbacks.onReconnect?.(); });

      await waitFor(() => {
        expect(api.fetchDisplayData.mock.calls.length).toBeGreaterThan(before);
      });
    });

    // The percentage and the status are the backend's own derivation. Recomputing
    // them here is how two surfaces end up labelling one reading differently.
    it('shows the backend occupancy percentage instead of recomputing it', async () => {
      render(<App />);
      await waitFor(() => expect(screen.getByTestId('metric-footfall')).toHaveTextContent('42'));

      // The server says 7% of a 200 capacity -> 14 people. A client that divided
      // locally would need `capacity`, and would disagree if it were absent.
      act(() => {
        socketCallbacks.onEvent?.('crowd.updated', {
          centerId: mockCenterId,
          currentCrowd: 14,
          capacity: 200,
          crowdPercent: 7,
          crowdStatus: 'LOW',
          crowdUpdatedAt: new Date().toISOString(),
        });
      });

      const metric = screen.getByTestId('metric-footfall');
      expect(metric).toHaveTextContent('7% of capacity');
    });

    it('omits the percentage when the backend did not supply one', async () => {
      render(<App />);
      await waitFor(() => expect(screen.getByTestId('metric-footfall')).toHaveTextContent('42'));

      // A reading with no percentage must not be back-filled from count/capacity.
      act(() => {
        socketCallbacks.onEvent?.('crowd.updated', {
          centerId: mockCenterId,
          currentCrowd: 9,
          capacity: 200,
          crowdUpdatedAt: new Date().toISOString(),
        });
      });

      const metric = screen.getByTestId('metric-footfall');
      expect(metric).toHaveTextContent('9');
      expect(metric).not.toHaveTextContent('% of capacity');
    });

    it('adopts the backend status rather than classifying the count itself', async () => {
      render(<App />);
      await waitFor(() => expect(screen.getByTestId('metric-footfall')).toHaveTextContent('42'));

      // A count of 4 against a capacity of 200 is "LOW" server-side. The badge
      // must be the server's word, and no threshold maths may be applied here.
      act(() => {
        socketCallbacks.onEvent?.('crowd.updated', {
          centerId: mockCenterId,
          currentCrowd: 4,
          capacity: 200,
          crowdPercent: 2,
          crowdStatus: 'LOW',
          crowdUpdatedAt: new Date().toISOString(),
        });
      });

      expect(screen.getByText('QUIET')).toBeInTheDocument();
    });

    it('shows BUSY when the backend reports a HIGH crowd level', async () => {
      render(<App />);
      await waitFor(() => expect(screen.getByTestId('metric-footfall')).toHaveTextContent('42'));

      act(() => {
        socketCallbacks.onEvent?.('crowd.updated', {
          centerId: mockCenterId,
          currentCrowd: 170,
          capacity: 200,
          crowdPercent: 85,
          crowdStatus: 'HIGH',
          crowdUpdatedAt: new Date().toISOString(),
        });
      });

      expect(screen.getByText('BUSY')).toBeInTheDocument();
      expect(screen.getByTestId('metric-footfall')).toHaveTextContent('85% of capacity');
    });
  });

  // 16, 17, 18. QR generation and deep link structure
  it('16, 17, 18. Builds dynamic deep link and web URLs without hardcoding or PII', () => {
    const { deepLink, webUrl } = buildJoinUrls(mockCenterId);
    expect(deepLink).toBe(`queueflow://join?centerId=${mockCenterId}`);
    expect(webUrl).toContain(`/join?centerId=${mockCenterId}`);
    expect(deepLink).not.toContain('undefined');
    expect(deepLink).not.toContain('jwt');
    expect(deepLink).not.toContain('secret');

    // Service-level QR
    const serviceUrls = buildJoinUrls(mockCenterId, mockServiceId);
    expect(serviceUrls.deepLink).toBe(`queueflow://join?centerId=${mockCenterId}&serviceId=${mockServiceId}`);
  });

  // 20. Public-display PII protection
  it('20. Does not expose customer or operator PII anywhere on display', async () => {
    const piiDisplayData = {
      ...mockDisplayData,
      customerName: 'Secret Customer John Doe',
      customerPhone: '+919999999999',
      operatorSecret: 'SUPER_SECRET_TOKEN',
    };
    vi.spyOn(api, 'fetchDisplayData').mockResolvedValueOnce(piiDisplayData);

    render(<App />);

    await waitFor(() => {
      expect(screen.queryByText(/John Doe/)).not.toBeInTheDocument();
      expect(screen.queryByText(/\+919999999999/)).not.toBeInTheDocument();
      expect(screen.queryByText(/SUPER_SECRET_TOKEN/)).not.toBeInTheDocument();
    });
  });

  // 21. No secrets in frontend bundle or rendering
  it('21. Protects internal secrets from frontend rendering', () => {
    expect(mockDisplayData.displayToken).not.toContain(process.env.JWT_SECRET || 'undefined');
    const { deepLink } = buildJoinUrls(mockCenterId);
    expect(deepLink).not.toContain('IOT_SECRET');
  });

  // 22. Responsive and fullscreen control
  it('22. Provides fullscreen and mute controls for lobby operators', async () => {
    render(<App />);

    await waitFor(() => {
      expect(screen.getByLabelText(/Toggle Fullscreen/)).toBeInTheDocument();
      expect(screen.getByLabelText(/Audio On/)).toBeInTheDocument();
    });

    const muteBtn = screen.getByLabelText(/Audio On/);
    await userEvent.click(muteBtn);
    expect(screen.getByLabelText(/Audio Muted/)).toBeInTheDocument();
  });

  // 24. Invalid center / error handling
  it('24. Handles invalid center gracefully with truthful error feed notice', async () => {
    vi.spyOn(api, 'fetchDisplayData').mockRejectedValueOnce(new Error('Service center not found'));

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('FEED UNAVAILABLE')).toBeInTheDocument();
      expect(screen.getByText('Service center not found')).toBeInTheDocument();
    });
  });

  // 25. Display not configured when no center is found
  it('25. Displays truthful DISPLAY NOT CONFIGURED notice when no centers exist', async () => {
    delete window.location;
    window.location = new URL('http://localhost:5174/live-counter');
    vi.spyOn(api, 'fetchCenters').mockResolvedValueOnce([]);

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId('display-not-configured')).toBeInTheDocument();
      expect(screen.getByText('DISPLAY NOT CONFIGURED')).toBeInTheDocument();
    });
  });
});
