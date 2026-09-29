import { render, screen, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import userEvent from '@testing-library/user-event';
import { App } from '../App';
import * as api from '../services/api';
import * as socketService from '../services/socket';

describe('Live Counter Callout Pop-up Notice Lifecycle', () => {
  const mockCenterId = 'center-popup-123';
  const mockDisplayData = {
    center: {
      _id: mockCenterId,
      name: 'Central Testing Center',
      code: 'CTC-01',
      currentCrowd: 15,
      capacity: 100,
      crowdStatus: 'MODERATE',
      crowdPercent: 15,
      crowdUpdatedAt: new Date().toISOString(),
      crowdSensorOnline: true,
    },
    displayToken: 'mock-socket-token-abc',
    queues: [],
    counters: [
      { _id: 'c1', name: 'Counter 01', number: 1, isOnline: true },
      { _id: 'c2', name: 'Counter 02', number: 2, isOnline: true },
    ],
    nowServing: [],
    nextInQueue: [],
    metrics: {
      waitingCount: 5,
      servingCount: 0,
      completedToday: 20,
    },
  };

  let socketCallbacks = {};

  beforeEach(() => {
    vi.restoreAllMocks();
    delete window.location;
    window.location = new URL(`http://localhost:5174/live-counter?centerId=${mockCenterId}`);

    vi.spyOn(api, 'fetchDisplayData').mockResolvedValue(mockDisplayData);
    vi.spyOn(api, 'fetchCenters').mockResolvedValue([
      { _id: mockCenterId, name: 'Central Testing Center', code: 'CTC-01' },
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

  it('1. Appears when token is called, then automatically disappears when token transitions to serving', async () => {
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('Central Testing Center')).toBeInTheDocument();
    });

    expect(screen.queryByTestId('callout-banner')).not.toBeInTheDocument();

    // Trigger token.called
    act(() => {
      socketCallbacks.onEvent?.('token.called', {
        token: { _id: 'tok-101', tokenCode: 'A-101', calledAt: new Date().toISOString() },
        counter: { name: 'Counter 01', displayLabel: 'Station 1' },
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('callout-banner')).toBeInTheDocument();
      expect(screen.getByTestId('callout-ticket')).toHaveTextContent('A-101');
      expect(screen.getByText(/Station 1/)).toBeInTheDocument();
    });

    // When counter operator starts serving -> token.serving event received
    act(() => {
      socketCallbacks.onEvent?.('token.serving', {
        token: { _id: 'tok-101', tokenCode: 'A-101', status: 'SERVING' },
        counter: { name: 'Counter 01', displayLabel: 'Station 1' },
      });
    });

    await waitFor(() => {
      expect(screen.queryByTestId('callout-banner')).not.toBeInTheDocument();
    });
  });

  it('2. Automatically disappears when token is completed', async () => {
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('Central Testing Center')).toBeInTheDocument();
    });

    // Trigger token.called
    act(() => {
      socketCallbacks.onEvent?.('token.called', {
        token: { _id: 'tok-202', tokenCode: 'B-202', calledAt: new Date().toISOString() },
        counter: { name: 'Counter 02', displayLabel: 'Station 2' },
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('callout-banner')).toBeInTheDocument();
      expect(screen.getByTestId('callout-ticket')).toHaveTextContent('B-202');
    });

    // Complete token
    act(() => {
      socketCallbacks.onEvent?.('token.completed', {
        token: { _id: 'tok-202', tokenCode: 'B-202', status: 'COMPLETED' },
      });
    });

    await waitFor(() => {
      expect(screen.queryByTestId('callout-banner')).not.toBeInTheDocument();
    });
  });

  it('3. Automatically disappears when token is skipped', async () => {
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('Central Testing Center')).toBeInTheDocument();
    });

    // Trigger token.called
    act(() => {
      socketCallbacks.onEvent?.('token.called', {
        token: { _id: 'tok-303', tokenCode: 'C-303', calledAt: new Date().toISOString() },
        counter: { name: 'Counter 01', displayLabel: 'Station 1' },
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('callout-banner')).toBeInTheDocument();
      expect(screen.getByTestId('callout-ticket')).toHaveTextContent('C-303');
    });

    // Operator skips token
    act(() => {
      socketCallbacks.onEvent?.('token.skipped', {
        token: { _id: 'tok-303', tokenCode: 'C-303', status: 'SKIPPED' },
      });
    });

    await waitFor(() => {
      expect(screen.queryByTestId('callout-banner')).not.toBeInTheDocument();
    });
  });

  it('4. Can be dismissed manually via close button', async () => {
    const user = userEvent.setup();
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('Central Testing Center')).toBeInTheDocument();
    });

    act(() => {
      socketCallbacks.onEvent?.('token.called', {
        token: { _id: 'tok-404', tokenCode: 'D-404', calledAt: new Date().toISOString() },
        counter: { name: 'Counter 01', displayLabel: 'Station 1' },
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('callout-banner')).toBeInTheDocument();
    });

    const closeBtn = screen.getByRole('button', { name: /Dismiss call notice/i });
    await user.click(closeBtn);

    await waitFor(() => {
      expect(screen.queryByTestId('callout-banner')).not.toBeInTheDocument();
    });
  });
});
