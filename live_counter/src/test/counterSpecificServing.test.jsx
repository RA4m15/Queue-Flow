import { render, screen, waitFor, act, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { App } from '../App';
import * as api from '../services/api';
import * as socketService from '../services/socket';
import { CalloutBanner } from '../components/CalloutBanner';

describe('Live Counter — Counter-Specific Serving & High Contrast Pop-up Regression Suite', () => {
  const collegeCenterId = '6ab93df8da6b1eefeb19caa2';

  const mockTwoCountersDisplay = {
    center: {
      _id: collegeCenterId,
      name: 'College Account',
      code: 'COLLEGE01',
      capacity: 200,
      currentCrowd: 1,
      crowdPercent: 1,
      crowdStatus: 'LOW',
      crowdUpdatedAt: new Date().toISOString(),
      crowdSensorOnline: true,
    },
    displayToken: 'college-display-jwt-token',
    queues: [
      {
        queueId: 'q-college-1',
        service: { _id: 'svc-col', name: 'College Queue', tokenPrefix: 'C' },
        status: 'OPEN',
        waitingCount: 2,
        activeCount: 2,
      },
    ],
    counters: [
      {
        _id: 'cnt-01',
        number: 1,
        name: 'Counter 01',
        displayLabel: 'COUNTER 01',
        status: 'ACTIVE',
        service: { name: 'College Queue', tokenPrefix: 'C' },
        servingToken: { tokenCode: 'C-003', status: 'SERVING', calledAt: '2026-09-29T10:00:00.000Z' },
      },
      {
        _id: 'cnt-02',
        number: 2,
        name: 'Counter 02',
        displayLabel: 'COUNTER 02',
        status: 'ACTIVE',
        service: { name: 'College Queue', tokenPrefix: 'C' },
        servingToken: { tokenCode: 'C-004', status: 'SERVING', calledAt: '2026-09-29T10:01:00.000Z' },
      },
    ],
    nowServing: [
      {
        _id: 'tok-003',
        tokenCode: 'C-003',
        status: 'SERVING',
        calledAt: '2026-09-29T10:00:00.000Z',
        counterId: { _id: 'cnt-01', number: 1, name: 'Counter 01', displayLabel: 'COUNTER 01' },
        serviceId: { name: 'College Queue', tokenPrefix: 'C' },
      },
      {
        _id: 'tok-004',
        tokenCode: 'C-004',
        status: 'SERVING',
        calledAt: '2026-09-29T10:01:00.000Z',
        counterId: { _id: 'cnt-02', number: 2, name: 'Counter 02', displayLabel: 'COUNTER 02' },
        serviceId: { name: 'College Queue', tokenPrefix: 'C' },
      },
    ],
    nextInQueue: [
      { _id: 'tok-005', tokenCode: 'C-005', currentPosition: 1, waitEstimateMinutes: 4 },
    ],
    metrics: { waitingCount: 1, servingCount: 2, completedToday: 5 },
  };

  let socketCallbacks = {};

  beforeEach(() => {
    vi.restoreAllMocks();
    delete window.location;
    window.location = new URL(`http://localhost:5174/live-counter?centerId=${collegeCenterId}`);

    vi.spyOn(api, 'fetchDisplayData').mockResolvedValue(mockTwoCountersDisplay);
    vi.spyOn(api, 'fetchCenters').mockResolvedValue([
      { _id: collegeCenterId, name: 'College Account', code: 'COLLEGE01' },
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

  // 1. Multiple counters with different serving tokens simultaneously
  it('1. Displays multiple counters with their own serving tokens simultaneously in Now Serving', async () => {
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('College Account')).toBeInTheDocument();
    });

    const card1 = screen.getByTestId('now-serving-card-1');
    const card2 = screen.getByTestId('now-serving-card-2');

    expect(within(card1).getByText('COUNTER 01')).toBeInTheDocument();
    expect(within(card1).getByText('C-003')).toBeInTheDocument();
    expect(within(card1).getByText('Serving')).toBeInTheDocument();

    expect(within(card2).getByText('COUNTER 02')).toBeInTheDocument();
    expect(within(card2).getByText('C-004')).toBeInTheDocument();
    expect(within(card2).getByText('Serving')).toBeInTheDocument();
  });

  // 2. One counter completing without affecting another
  it('2. Completing Counter 01 makes it IDLE while Counter 02 continues serving C-004', async () => {
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('College Account')).toBeInTheDocument();
    });

    // Complete token on Counter 01
    act(() => {
      socketCallbacks.onEvent?.('token.completed', {
        centerId: collegeCenterId,
        token: { _id: 'tok-003', tokenCode: 'C-003', status: 'COMPLETED' },
        counter: { _id: 'cnt-01', number: 1, name: 'Counter 01', displayLabel: 'COUNTER 01' },
      });
    });

    await waitFor(() => {
      const card1 = screen.getByTestId('now-serving-card-1');
      const card2 = screen.getByTestId('now-serving-card-2');

      // Counter 01 is now IDLE
      expect(within(card1).getByText('IDLE')).toBeInTheDocument();
      expect(within(card1).getByText('No active token')).toBeInTheDocument();

      // Counter 02 is STILL SERVING C-004
      expect(within(card2).getByText('C-004')).toBeInTheDocument();
      expect(within(card2).getByText('Serving')).toBeInTheDocument();
    });
  });

  // 3. token.called updates ONLY its counter
  it('3. token.called updates only the target counter and leaves other counters untouched', async () => {
    // Start with Counter 01 idle, Counter 02 serving C-004
    vi.spyOn(api, 'fetchDisplayData').mockResolvedValue({
      ...mockTwoCountersDisplay,
      counters: [
        {
          _id: 'cnt-01',
          number: 1,
          name: 'Counter 01',
          displayLabel: 'COUNTER 01',
          status: 'ACTIVE',
          servingToken: null,
        },
        mockTwoCountersDisplay.counters[1],
      ],
      nowServing: [mockTwoCountersDisplay.nowServing[1]],
    });

    render(<App />);

    await waitFor(() => {
      expect(within(screen.getByTestId('now-serving-card-1')).getByText('IDLE')).toBeInTheDocument();
      expect(within(screen.getByTestId('now-serving-card-2')).getByText('C-004')).toBeInTheDocument();
    });

    // Call token C-005 on Counter 01
    act(() => {
      socketCallbacks.onEvent?.('token.called', {
        centerId: collegeCenterId,
        token: {
          _id: 'tok-005',
          tokenCode: 'C-005',
          status: 'CALLED',
          serviceId: { name: 'College Queue' },
          counterId: { number: 1 },
        },
        counter: { name: 'Counter 01', displayLabel: 'COUNTER 01', number: 1 },
      });
    });

    await waitFor(() => {
      const card1 = screen.getByTestId('now-serving-card-1');
      const card2 = screen.getByTestId('now-serving-card-2');

      // Counter 01 updated to C-005
      expect(within(card1).getByText('C-005')).toBeInTheDocument();

      // Counter 02 is UNCHANGED, still C-004
      expect(within(card2).getByText('C-004')).toBeInTheDocument();
    });
  });

  // 4. token.completed clears ONLY its counter
  it('4. token.completed clears only its counter when multiple counters are active', async () => {
    render(<App />);

    await waitFor(() => {
      expect(within(screen.getByTestId('now-serving-card-2')).getByText('C-004')).toBeInTheDocument();
    });

    // Complete token on Counter 02
    act(() => {
      socketCallbacks.onEvent?.('token.completed', {
        centerId: collegeCenterId,
        token: { _id: 'tok-004', tokenCode: 'C-004', status: 'COMPLETED' },
        counter: { _id: 'cnt-02', number: 2, name: 'Counter 02' },
      });
    });

    await waitFor(() => {
      const card1 = screen.getByTestId('now-serving-card-1');
      const card2 = screen.getByTestId('now-serving-card-2');

      // Counter 01 STILL has C-003
      expect(within(card1).getByText('C-003')).toBeInTheDocument();

      // Counter 02 is now IDLE
      expect(within(card2).getByText('IDLE')).toBeInTheDocument();
      expect(within(card2).getByText('No active token')).toBeInTheDocument();
    });
  });

  // 5. Counter-specific popup
  it('5. Callout popup displays the exact token and counter from token.called event (never hardcoded)', async () => {
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('College Account')).toBeInTheDocument();
    });

    // Counter 02 calls token C-008
    act(() => {
      socketCallbacks.onEvent?.('token.called', {
        centerId: collegeCenterId,
        token: {
          _id: 'tok-008',
          tokenCode: 'C-008',
          calledAt: new Date().toISOString(),
        },
        counter: {
          _id: 'cnt-02',
          number: 2,
          name: 'Counter 02',
          displayLabel: 'COUNTER 02',
        },
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('callout-banner')).toBeInTheDocument();
      expect(screen.getByTestId('callout-ticket')).toHaveTextContent('C-008');
      expect(screen.getByTestId('callout-counter')).toHaveTextContent('COUNTER 02');
      expect(screen.getByText('PLEASE PROCEED TO')).toBeInTheDocument();
    });
  });

  // 6. Popup token visibility & high contrast
  it('6. Popup token component renders with explicit callout-ticket class for high contrast visibility', () => {
    render(
      <CalloutBanner
        callout={{
          tokenCode: 'C-003',
          counterName: 'COUNTER 01',
          tokenId: 'tok-003',
        }}
        onDismiss={() => {}}
      />
    );

    const ticketEl = screen.getByTestId('callout-ticket');
    expect(ticketEl).toHaveTextContent('C-003');
    expect(ticketEl).toHaveClass('callout-ticket');

    const counterEl = screen.getByTestId('callout-counter');
    expect(counterEl).toHaveTextContent('COUNTER 01');
    expect(counterEl).toHaveClass('callout-counter-name');
  });

  // 7. Socket reconnect restoring all counters
  it('7. Socket reconnect re-fetches authoritative backend state and rebuilds all counters', async () => {
    render(<App />);

    await waitFor(() => {
      expect(within(screen.getByTestId('now-serving-card-1')).getByText('C-003')).toBeInTheDocument();
    });

    // Mock new authoritative backend response with Counter 01 idle and Counter 02 serving C-007
    vi.spyOn(api, 'fetchDisplayData').mockResolvedValue({
      ...mockTwoCountersDisplay,
      counters: [
        {
          _id: 'cnt-01',
          number: 1,
          name: 'Counter 01',
          displayLabel: 'COUNTER 01',
          status: 'ACTIVE',
          servingToken: null,
        },
        {
          _id: 'cnt-02',
          number: 2,
          name: 'Counter 02',
          displayLabel: 'COUNTER 02',
          status: 'ACTIVE',
          servingToken: { tokenCode: 'C-007', status: 'SERVING' },
        },
      ],
      nowServing: [
        {
          _id: 'tok-007',
          tokenCode: 'C-007',
          status: 'SERVING',
          counterId: { _id: 'cnt-02', number: 2 },
        },
      ],
    });

    // Simulate socket reconnect
    act(() => {
      socketCallbacks.onReconnect?.();
    });

    await waitFor(() => {
      const card1 = screen.getByTestId('now-serving-card-1');
      const card2 = screen.getByTestId('now-serving-card-2');

      expect(within(card1).getByText('IDLE')).toBeInTheDocument();
      expect(within(card2).getByText('C-007')).toBeInTheDocument();
    });
  });

  // 8. Center isolation: events from other centers are ignored
  it('8. Center isolation: ignores socket events from different centers', async () => {
    render(<App />);

    await waitFor(() => {
      expect(within(screen.getByTestId('now-serving-card-1')).getByText('C-003')).toBeInTheDocument();
    });

    // Event from a different center
    act(() => {
      socketCallbacks.onEvent?.('token.called', {
        centerId: 'other-foreign-center-999',
        token: { _id: 'tok-foreign', tokenCode: 'F-999', counterId: { number: 1 } },
        counter: { name: 'Counter 01', number: 1 },
      });
    });

    // Counter 01 must NOT be overwritten with F-999
    expect(within(screen.getByTestId('now-serving-card-1')).getByText('C-003')).toBeInTheDocument();
    expect(screen.queryByText('F-999')).not.toBeInTheDocument();
  });
});
