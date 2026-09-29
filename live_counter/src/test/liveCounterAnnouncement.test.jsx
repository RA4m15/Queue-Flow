import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '../App';
import * as api from '../services/api';
import * as socketModule from '../services/socket';
import { resetAnnouncerState } from '../services/announcer';

describe('QueueFlow Live Counter Chime + Announcement System', () => {
  let socketCallbacks = {};
  let mockOscillator;
  let mockGain;
  let mockAudioCtx;
  let speechCalls = [];

  const mockCenter = {
    _id: '6ab030edfb8baa6b361738d8',
    name: 'Downtown Civic Service Center',
    code: 'DCSC-01',
    capacity: 150,
    currentCrowd: 42,
    crowdStatus: 'MODERATE',
    crowdPercent: 28,
    crowdUpdatedAt: new Date().toISOString(),
    crowdSensorOnline: true,
  };

  const mockDisplayData = {
    center: mockCenter,
    queues: [],
    counters: [
      { _id: 'c1', name: 'Counter 01', number: 1, status: 'ACTIVE' },
      { _id: 'c2', name: 'Counter 02', number: 2, status: 'ACTIVE' },
    ],
    nowServing: [],
    nextInQueue: [],
    metrics: { waitingCount: 3, servingCount: 2, avgWaitTimeMinutes: 10 },
    displayToken: 'mock-display-token-xyz',
  };

  beforeEach(() => {
    resetAnnouncerState();
    socketCallbacks = {};
    speechCalls = [];

    // Mock API
    vi.spyOn(api, 'fetchCenters').mockResolvedValue([mockCenter]);
    vi.spyOn(api, 'fetchDisplayData').mockResolvedValue(mockDisplayData);

    // Mock socket initialization
    vi.spyOn(socketModule, 'initDisplaySocket').mockImplementation((opts) => {
      socketCallbacks = opts;
      opts.onStatusChange?.('connected');
      return { id: 'test-socket-id' };
    });

    // Mock Web Audio API
    mockOscillator = {
      type: 'sine',
      frequency: { setValueAtTime: vi.fn() },
      connect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
    };

    mockGain = {
      gain: {
        setValueAtTime: vi.fn(),
        exponentialRampToValueAtTime: vi.fn(),
      },
      connect: vi.fn(),
    };

    mockAudioCtx = {
      currentTime: 0,
      state: 'running',
      createOscillator: vi.fn(() => mockOscillator),
      createGain: vi.fn(() => mockGain),
      destination: {},
      resume: vi.fn().mockResolvedValue(),
    };

    window.AudioContext = vi.fn(function () {
      return mockAudioCtx;
    });
    window.webkitAudioContext = window.AudioContext;

    // Mock SpeechSynthesis
    class MockUtterance {
      constructor(text) {
        this.text = text;
        this.rate = 1.0;
        this.pitch = 1.0;
        this.volume = 1.0;
        this.lang = 'en-US';
        this.voice = null;
        this.onend = null;
        this.onerror = null;
      }
    }
    window.SpeechSynthesisUtterance = MockUtterance;

    window.speechSynthesis = {
      paused: false,
      getVoices: vi.fn(() => [
        { name: 'Microsoft Heera - English (India)', lang: 'en-IN' },
        { name: 'Microsoft Ravi - English (India)', lang: 'en-IN' },
        { name: 'Google US English', lang: 'en-US' },
      ]),
      speak: vi.fn((utterance) => {
        speechCalls.push(utterance);
        // Automatically finish speaking after a small tick
        setTimeout(() => {
          if (utterance.onend) utterance.onend();
        }, 10);
      }),
      cancel: vi.fn(),
      resume: vi.fn(),
      pause: vi.fn(),
    };
  });

  afterEach(() => {
    delete window.AudioContext;
    delete window.webkitAudioContext;
    delete window.SpeechSynthesisUtterance;
    delete window.speechSynthesis;
    vi.restoreAllMocks();
    resetAnnouncerState();
  });

  // 1. Genuine token-called event -> chime + speech triggered
  it('1. Genuine token-called event triggers short chime and voice announcement', async () => {
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('Downtown Civic Service Center')).toBeInTheDocument();
    });

    await act(async () => {
      socketCallbacks.onEvent?.('token.called', {
        token: { _id: 't-023', tokenCode: 'C-023', calledAt: '2026-09-28T10:00:00.000Z' },
        counter: { name: 'Counter 01', number: 1 },
      });
    });

    // Wait for chime and speech
    await waitFor(
      () => {
        expect(mockAudioCtx.createOscillator).toHaveBeenCalled();
        expect(window.speechSynthesis.speak).toHaveBeenCalledTimes(1);
      },
      { timeout: 3000 }
    );

    const spokenText = speechCalls[0]?.text;
    expect(spokenText).toBe('Token C-023... please proceed to Counter 01.');
    expect(speechCalls[0]?.rate).toBeCloseTo(0.94, 2);
    expect(speechCalls[0]?.pitch).toBeCloseTo(1.05, 2);
    expect(speechCalls[0]?.voice?.name).toBe('Microsoft Heera - English (India)');
  });

  // 2. Duplicate token-called event -> only one announcement
  it('2. Duplicate token-called event generates only one announcement (strict deduplication)', async () => {
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('Downtown Civic Service Center')).toBeInTheDocument();
    });

    const callPayload = {
      token: { _id: 't-023', tokenCode: 'C-023', calledAt: '2026-09-28T10:00:00.000Z' },
      counter: { name: 'Counter 01', number: 1 },
    };

    // First arrival
    await act(async () => {
      socketCallbacks.onEvent?.('token.called', callPayload);
    });

    await waitFor(
      () => {
        expect(window.speechSynthesis.speak).toHaveBeenCalledTimes(1);
      },
      { timeout: 3000 }
    );

    // Duplicate arrival (e.g. network retry / reconnect echo)
    await act(async () => {
      socketCallbacks.onEvent?.('token.called', callPayload);
    });

    // Still only 1 call
    expect(window.speechSynthesis.speak).toHaveBeenCalledTimes(1);
  });

  // 3. queue.updated alone -> no speech
  it('3. queue.updated event does NOT trigger chime or speech', async () => {
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('Downtown Civic Service Center')).toBeInTheDocument();
    });

    await act(async () => {
      socketCallbacks.onEvent?.('queue.updated', {
        centerId: mockCenter._id,
        waitingCount: 5,
      });
    });

    expect(window.speechSynthesis.speak).not.toHaveBeenCalled();
    expect(mockAudioCtx.createOscillator).not.toHaveBeenCalled();
  });

  // 4. counter.updated alone -> no speech
  it('4. counter.updated event does NOT trigger speech', async () => {
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('Downtown Civic Service Center')).toBeInTheDocument();
    });

    await act(async () => {
      socketCallbacks.onEvent?.('counter.updated', {
        counterId: 'c1',
        status: 'ACTIVE',
      });
    });

    expect(window.speechSynthesis.speak).not.toHaveBeenCalled();
  });

  // 5. crowd.updated -> no speech
  it('5. crowd.updated telemetry event does NOT trigger speech', async () => {
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('Downtown Civic Service Center')).toBeInTheDocument();
    });

    await act(async () => {
      socketCallbacks.onEvent?.('crowd.updated', {
        centerId: mockCenter._id,
        currentCrowd: 55,
      });
    });

    expect(window.speechSynthesis.speak).not.toHaveBeenCalled();
  });

  // 6. skipped token -> no speech
  it('6. token.skipped event does NOT trigger speech', async () => {
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('Downtown Civic Service Center')).toBeInTheDocument();
    });

    await act(async () => {
      socketCallbacks.onEvent?.('token.skipped', {
        token: { tokenCode: 'C-022' },
        reason: 'outside service area',
      });
    });

    expect(window.speechSynthesis.speak).not.toHaveBeenCalled();
  });

  // 7. Two genuine calls -> announcements are sequential
  it('7. Rapid consecutive calls are queued and announced sequentially without overlap', async () => {
    let call1Finished = false;
    // Controlled speech synthesis to simulate real speaking duration
    window.speechSynthesis.speak = vi.fn((utterance) => {
      speechCalls.push(utterance);
      if (utterance.text.includes('C-023')) {
        setTimeout(() => {
          call1Finished = true;
          if (utterance.onend) utterance.onend();
        }, 50);
      } else {
        setTimeout(() => {
          if (utterance.onend) utterance.onend();
        }, 10);
      }
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('Downtown Civic Service Center')).toBeInTheDocument();
    });

    // Deliver Call 1 and Call 2 almost simultaneously
    await act(async () => {
      socketCallbacks.onEvent?.('token.called', {
        token: { _id: 't-023', tokenCode: 'C-023', calledAt: '2026-09-28T10:00:00.000Z' },
        counter: { name: 'Counter 01' },
      });
      socketCallbacks.onEvent?.('token.called', {
        token: { _id: 't-024', tokenCode: 'C-024', calledAt: '2026-09-28T10:00:01.000Z' },
        counter: { name: 'Counter 02' },
      });
    });

    // Wait until both complete
    await waitFor(
      () => {
        expect(speechCalls).toHaveLength(2);
      },
      { timeout: 3000 }
    );

    expect(speechCalls[0].text).toBe('Token C-023... please proceed to Counter 01.');
    expect(speechCalls[1].text).toBe('Token C-024... please proceed to Counter 02.');
  });

  // 8. Counter 01 and Counter 02 use their real counter names
  it('8. Slices and speaks real counter names for Counter 01 and Counter 02 dynamically', async () => {
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('Downtown Civic Service Center')).toBeInTheDocument();
    });

    // Call from Counter 01
    await act(async () => {
      socketCallbacks.onEvent?.('token.called', {
        token: { _id: 'tok-1', tokenCode: 'C-021', calledAt: '2026-09-28T10:05:00.000Z' },
        counter: { name: 'Counter 01' },
      });
    });

    await waitFor(
      () => {
        expect(speechCalls).toHaveLength(1);
      },
      { timeout: 3000 }
    );
    expect(speechCalls[0].text).toBe('Token C-021... please proceed to Counter 01.');

    // Call from Counter 02
    await act(async () => {
      socketCallbacks.onEvent?.('token.called', {
        token: { _id: 'tok-2', tokenCode: 'C-022', calledAt: '2026-09-28T10:06:00.000Z' },
        counter: { name: 'Counter 02' },
      });
    });

    await waitFor(
      () => {
        expect(speechCalls).toHaveLength(2);
      },
      { timeout: 3000 }
    );
    expect(speechCalls[1].text).toBe('Token C-022... please proceed to Counter 02.');
  });

  // 9. Missing counter data does not generate a false announcement
  it('9. Missing counter data handles safely and does NOT announce a false counter', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => { });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('Downtown Civic Service Center')).toBeInTheDocument();
    });

    // Deliver event with tokenCode but NO counter information
    await act(async () => {
      socketCallbacks.onEvent?.('token.called', {
        token: { _id: 'tok-missing', tokenCode: 'C-999', calledAt: '2026-09-28T10:10:00.000Z' },
        counter: null,
      });
    });

    // Speech must NOT be called
    expect(window.speechSynthesis.speak).not.toHaveBeenCalled();
    // Chime must NOT be played
    expect(mockAudioCtx.createOscillator).not.toHaveBeenCalled();
    // Warn was logged reporting missing counter data
    expect(warnSpy).toHaveBeenCalled();
  });

  // 10. Existing realtime functionality remains intact
  it('10. Existing visual callout and realtime display state update alongside announcements', async () => {
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('Downtown Civic Service Center')).toBeInTheDocument();
    });

    await act(async () => {
      socketCallbacks.onEvent?.('token.called', {
        token: { _id: 'tok-realtime', tokenCode: 'A-555', calledAt: '2026-09-28T10:15:00.000Z' },
        counter: { name: 'Counter 03', displayLabel: 'Station 3' },
      });
    });

    // Visual callout banner is displayed in the DOM
    await waitFor(() => {
      expect(screen.getByTestId('callout-ticket')).toHaveTextContent('A-555');
      expect(screen.getByText(/Station 3/)).toBeInTheDocument();
    });

    // Speech was also triggered with the real counter (after chime)
    await waitFor(
      () => {
        expect(window.speechSynthesis.speak).toHaveBeenCalled();
      },
      { timeout: 2000 }
    );
  });

  // Mute control suppresses voice and chime
  it('11. Muting sound disables chime and speech announcements', async () => {
    render(<App />);

    await waitFor(() => {
      expect(screen.getByLabelText(/Audio On/)).toBeInTheDocument();
    });

    const muteBtn = screen.getByLabelText(/Audio On/);
    await userEvent.click(muteBtn);

    expect(screen.getByLabelText(/Audio Muted/)).toBeInTheDocument();

    await act(async () => {
      socketCallbacks.onEvent?.('token.called', {
        token: { _id: 'tok-muted', tokenCode: 'C-777', calledAt: '2026-09-28T10:20:00.000Z' },
        counter: { name: 'Counter 01' },
      });
    });

    // Audio muted: no speech and no chime
    expect(window.speechSynthesis.speak).not.toHaveBeenCalled();
    expect(mockAudioCtx.createOscillator).not.toHaveBeenCalled();
  });

  // 12. en-IN voice is preferred when available
  it('12. en-IN voice is preferred when available', async () => {
    window.speechSynthesis.getVoices = vi.fn(() => [
      { name: 'David Desktop', lang: 'en-US' },
      { name: 'Microsoft Heera - English (India)', lang: 'en-IN' },
      { name: 'Microsoft Zira Desktop', lang: 'en-US' },
    ]);
    resetAnnouncerState();

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('Downtown Civic Service Center')).toBeInTheDocument();
    });

    await act(async () => {
      socketCallbacks.onEvent?.('token.called', {
        token: { _id: 'tok-voice-1', tokenCode: 'V-001', calledAt: new Date().toISOString() },
        counter: { name: 'Counter 01' },
      });
    });

    await waitFor(() => {
      expect(speechCalls).toHaveLength(1);
    });

    expect(speechCalls[0].voice?.name).toBe('Microsoft Heera - English (India)');
    expect(speechCalls[0].voice?.lang).toBe('en-IN');
    expect(speechCalls[0].rate).toBeCloseTo(0.94, 2);
    expect(speechCalls[0].pitch).toBeCloseTo(1.05, 2);
  });

  // 13. fallback voice is selected when en-IN is unavailable
  it('13. fallback voice is selected when en-IN is unavailable', async () => {
    window.speechSynthesis.getVoices = vi.fn(() => [
      { name: 'Google US English', lang: 'en-US' },
      { name: 'Microsoft Zira - English (United States)', lang: 'en-US' },
    ]);
    resetAnnouncerState();

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('Downtown Civic Service Center')).toBeInTheDocument();
    });

    await act(async () => {
      socketCallbacks.onEvent?.('token.called', {
        token: { _id: 'tok-voice-2', tokenCode: 'V-002', calledAt: new Date().toISOString() },
        counter: { name: 'Counter 02' },
      });
    });

    await waitFor(() => {
      expect(speechCalls).toHaveLength(1);
    });

    // Should fall back cleanly to an available English voice without crashing
    expect(speechCalls[0].voice?.name).toBe('Microsoft Zira - English (United States)');
    expect(speechCalls[0].text).toBe('Token V-002... please proceed to Counter 02.');
  });

  // 14. Socket reconnect does not duplicate the listener or cause double announcements
  it('14. Socket reconnect does not duplicate the listener or cause double announcements', async () => {
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('Downtown Civic Service Center')).toBeInTheDocument();
    });

    // Simulate socket reconnect event
    await act(async () => {
      socketCallbacks.onReconnect?.();
    });

    // Fire token.called event
    await act(async () => {
      socketCallbacks.onEvent?.('token.called', {
        token: { _id: 'tok-recon-1', tokenCode: 'R-101', calledAt: new Date().toISOString() },
        counter: { name: 'Counter 01' },
      });
    });

    await waitFor(
      () => {
        expect(speechCalls).toHaveLength(1);
      },
      { timeout: 3000 }
    );

    // Exactly one speak call
    expect(window.speechSynthesis.speak).toHaveBeenCalledTimes(1);
    expect(speechCalls[0].text).toBe('Token R-101... please proceed to Counter 01.');
  });
});
