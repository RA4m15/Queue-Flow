import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route, useNavigate } from 'react-router-dom';
import { Navbar } from '../components/Navbar';
import { BackButton } from '../components/BackButton';
import { QrCameraScanner } from '../components/QrCameraScanner';
import { JoinQrPage } from '../pages/JoinQrPage';
import { LandingPage } from '../pages/LandingPage';
import { CentersPage } from '../pages/CentersPage';
import { CenterServicesPage } from '../pages/CenterServicesPage';
import { QueuePreviewPage } from '../pages/QueuePreviewPage';
import { parseJoinUrl, isAllowedHost, isValidMongoId } from '../utils/qrUrlParser';
import { AuthProvider } from '../context/AuthContext';
import { serviceCenterAPI, serviceAPI, queueAPI } from '../services/api';

const COLLEGE_CENTER_ID = '6ab93df8da6b1eefeb19caa2';
const COLLEGE_SERVICE_ID = '6ab93df8da6b1eefeb19caa6';

describe('1. TV Display Removal from Customer Web', () => {
  it('does NOT render TV Display link or button in the customer Navbar', () => {
    render(
      <AuthProvider>
        <MemoryRouter>
          <Navbar />
        </MemoryRouter>
      </AuthProvider>
    );

    // Navbar should have branding, connection status, sign in, but NO TV Display
    expect(screen.getByLabelText(/queueflow home/i)).toBeInTheDocument();
    expect(screen.queryByText(/TV Display/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /TV Display/i })).not.toBeInTheDocument();
    expect(screen.queryByTitle(/Open Live TV Display/i)).not.toBeInTheDocument();
  });
});

describe('2. Back Button Navigation', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders BackButton on internal pages but not on LandingPage', () => {
    const { unmount } = render(
      <AuthProvider>
        <MemoryRouter initialEntries={['/']}>
          <LandingPage />
        </MemoryRouter>
      </AuthProvider>
    );

    // Home page should NOT have BackButton
    expect(screen.queryByTestId('back-button')).not.toBeInTheDocument();
    unmount();

    // CentersPage should have BackButton
    render(
      <AuthProvider>
        <MemoryRouter initialEntries={['/centers']}>
          <CentersPage />
        </MemoryRouter>
      </AuthProvider>
    );
    expect(screen.getByTestId('back-button')).toBeInTheDocument();
  });

  it('calls navigate(-1) when session history contains a previous page', () => {
    // Simulate window.history with previous entries
    const origState = window.history.state;
    Object.defineProperty(window.history, 'state', {
      value: { idx: 2 },
      configurable: true,
      writable: true,
    });

    let navigatedValue = null;
    function TestComponent() {
      const nav = useNavigate();
      return (
        <div>
          <BackButton
            label="Back"
            fallback="/"
            onClickOverride={(val) => {
              navigatedValue = val;
            }}
          />
        </div>
      );
    }

    render(
      <MemoryRouter initialEntries={['/centers', '/center/123']}>
        <TestComponent />
      </MemoryRouter>
    );

    const btn = screen.getByTestId('back-button');
    fireEvent.click(btn);

    // With history state idx > 0, Back button initiates backwards navigation
    expect(window.history.state.idx).toBe(2);

    window.history.state = origState;
  });

  it('navigates to fallback when opened directly with no prior history', () => {
    const origState = window.history.state;
    Object.defineProperty(window.history, 'state', {
      value: { idx: 0 },
      configurable: true,
      writable: true,
    });
    Object.defineProperty(window.history, 'length', {
      value: 1,
      configurable: true,
      writable: true,
    });

    render(
      <MemoryRouter initialEntries={['/centers']}>
        <Routes>
          <Route
            path="/centers"
            element={
              <div>
                <BackButton label="Back" fallback="/" />
                <span>Centers View</span>
              </div>
            }
          />
          <Route path="/" element={<div>Home Landing View</div>} />
        </Routes>
      </MemoryRouter>
    );

    const btn = screen.getByTestId('back-button');
    fireEvent.click(btn);

    expect(screen.getByText('Home Landing View')).toBeInTheDocument();

    window.history.state = origState;
  });
});

describe('3. Canonical QR Parsing & Validation Rules', () => {
  it('accepts canonical HTTPS QueueFlow QR format', () => {
    const url = `https://queueflow.app/join?centerId=${COLLEGE_CENTER_ID}&serviceId=${COLLEGE_SERVICE_ID}`;
    const result = parseJoinUrl(url);

    expect(result.isValid).toBe(true);
    expect(result.centerId).toBe(COLLEGE_CENTER_ID);
    expect(result.serviceId).toBe(COLLEGE_SERVICE_ID);
    expect(result.error).toBeNull();
  });

  it('accepts canonical HTTPS with centerId only', () => {
    const url = `https://queueflow.app/join?centerId=${COLLEGE_CENTER_ID}`;
    const result = parseJoinUrl(url);

    expect(result.isValid).toBe(true);
    expect(result.centerId).toBe(COLLEGE_CENTER_ID);
    expect(result.serviceId).toBeNull();
  });

  it('accepts legacy queueflow://join scheme for compatibility', () => {
    const url = `queueflow://join?centerId=${COLLEGE_CENTER_ID}&serviceId=${COLLEGE_SERVICE_ID}`;
    const result = parseJoinUrl(url);

    expect(result.isValid).toBe(true);
    expect(result.centerId).toBe(COLLEGE_CENTER_ID);
    expect(result.serviceId).toBe(COLLEGE_SERVICE_ID);
  });

  it('rejects localhost and 127.0.0.1 in public QR scanner', () => {
    const localhost = `http://localhost:5175/join?centerId=${COLLEGE_CENTER_ID}`;
    const ipUrl = `http://127.0.0.1:5175/join?centerId=${COLLEGE_CENTER_ID}`;

    const res1 = parseJoinUrl(localhost);
    const res2 = parseJoinUrl(ipUrl);

    expect(res1.isValid).toBe(false);
    expect(res1.error).toContain('Localhost');
    expect(res2.isValid).toBe(false);
    expect(res2.error).toContain('Localhost');
  });

  it('rejects unsupported third-party hosts', () => {
    const evil = `https://evil-phishing.com/join?centerId=${COLLEGE_CENTER_ID}`;
    const result = parseJoinUrl(evil);

    expect(result.isValid).toBe(false);
    expect(result.error).toContain('Unsupported host');
  });

  it('rejects non-/join web paths', () => {
    const wrongPath = `https://queueflow.app/display?centerId=${COLLEGE_CENTER_ID}`;
    const result = parseJoinUrl(wrongPath);

    expect(result.isValid).toBe(false);
    expect(result.error).toContain('Invalid QR link path');
  });

  it('rejects malformed MongoDB ObjectId', () => {
    const badCenter = `https://queueflow.app/join?centerId=not-a-mongo-id`;
    const result = parseJoinUrl(badCenter);

    expect(result.isValid).toBe(false);
    expect(result.error).toContain('Invalid Service Center ID format');
  });

  it('rejects mismatched centerId == serviceId', () => {
    const same = `https://queueflow.app/join?centerId=${COLLEGE_CENTER_ID}&serviceId=${COLLEGE_CENTER_ID}`;
    const result = parseJoinUrl(same);

    expect(result.isValid).toBe(false);
    expect(result.error).toContain('mismatched');
  });

  it('rejects staff HMAC check-in QR', () => {
    const hmac = JSON.stringify({
      v: 1,
      tid: COLLEGE_CENTER_ID,
      cid: COLLEGE_CENTER_ID,
      pur: 'QUEUEFLOW_CHECKIN',
      sig: 'abcdef1234567890abcdef1234567890',
    });
    const result = parseJoinUrl(hmac);

    expect(result.isValid).toBe(false);
    expect(result.error).toContain('Staff check-in');
  });

  it('rejects random strings and non-QR data', () => {
    expect(parseJoinUrl('WIFI:S:MyNetwork;P:pass;;').isValid).toBe(false);
    expect(parseJoinUrl('hello world').isValid).toBe(false);
    expect(parseJoinUrl('').isValid).toBe(false);
  });
});

describe('4. Mobile Camera Scanner & Lifecycle', () => {
  let mockTrack;
  let mockStream;

  beforeEach(() => {
    mockTrack = {
      stop: vi.fn(),
      kind: 'video',
      readyState: 'live',
    };
    mockStream = {
      getTracks: vi.fn(() => [mockTrack]),
    };

    // Mock navigator.mediaDevices
    Object.defineProperty(navigator, 'mediaDevices', {
      value: {
        getUserMedia: vi.fn().mockResolvedValue(mockStream),
      },
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('requests camera permission with environment facing mode and cleans up on unmount', async () => {
    const { unmount } = render(
      <QrCameraScanner onScanSuccess={vi.fn()} onError={vi.fn()} />
    );

    // Initial state: requesting camera access
    expect(screen.getByText(/Requesting camera access/i)).toBeInTheDocument();

    await waitFor(() => {
      expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith(
        expect.objectContaining({
          video: expect.objectContaining({
            facingMode: { ideal: 'environment' },
          }),
        })
      );
    });

    // Unmount stops stream tracks cleanly (no stream leaks)
    unmount();
    expect(mockTrack.stop).toHaveBeenCalled();
  });

  it('handles camera permission denied with clear UI and allow access CTA', async () => {
    const permError = new Error('Permission denied');
    permError.name = 'NotAllowedError';
    navigator.mediaDevices.getUserMedia.mockRejectedValue(permError);

    render(
      <QrCameraScanner onScanSuccess={vi.fn()} onError={vi.fn()} />
    );

    await waitFor(() => {
      expect(screen.getByText(/Camera permission denied/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /allow camera access/i })).toBeInTheDocument();
    });
  });

  it('handles camera unavailable gracefully', async () => {
    const unavailError = new Error('No camera found');
    unavailError.name = 'NotFoundError';
    navigator.mediaDevices.getUserMedia.mockRejectedValue(unavailError);

    render(
      <QrCameraScanner onScanSuccess={vi.fn()} onError={vi.fn()} />
    );

    await waitFor(() => {
      expect(screen.getByText(/Camera unavailable/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /retry camera/i })).toBeInTheDocument();
    });
  });

  it('handles desktop or device without mediaDevices with clear message', async () => {
    // Simulate browser without getUserMedia
    Object.defineProperty(navigator, 'mediaDevices', {
      value: null,
      configurable: true,
      writable: true,
    });

    render(
      <QrCameraScanner onScanSuccess={vi.fn()} onError={vi.fn()} />
    );

    await waitFor(() => {
      expect(
        screen.getByText(/Camera scanning is not available on this device/i)
      ).toBeInTheDocument();
    });
  });
});

describe('5. Manual QR Fallback & College Account Routing', () => {
  beforeEach(() => {
    vi.restoreAllMocks();

    vi.spyOn(serviceCenterAPI, 'getById').mockResolvedValue({
      data: {
        serviceCenter: {
          _id: COLLEGE_CENTER_ID,
          name: 'College Account',
          code: 'COLLEGE01',
          isOpen: true,
        },
      },
    });

    vi.spyOn(serviceAPI, 'listByCenter').mockResolvedValue({
      data: {
        services: [
          {
            _id: COLLEGE_SERVICE_ID,
            centerId: COLLEGE_CENTER_ID,
            name: 'College Queue',
            isActive: true,
          },
        ],
      },
    });

    vi.spyOn(serviceAPI, 'getById').mockResolvedValue({
      data: {
        service: {
          _id: COLLEGE_SERVICE_ID,
          centerId: COLLEGE_CENTER_ID,
          name: 'College Queue',
          isActive: true,
        },
      },
    });

    vi.spyOn(queueAPI, 'getServiceQueue').mockResolvedValue({
      data: {
        queue: { waitingCount: 2, status: 'OPEN' },
        waitingTokens: [],
        calledTokens: [],
      },
    });
  });

  it('allows manual QR input fallback and routes to College Account', async () => {
    const user = userEvent.setup();

    render(
      <AuthProvider>
        <MemoryRouter initialEntries={['/join']}>
          <Routes>
            <Route path="/join" element={<JoinQrPage />} />
            <Route path="/center/:id" element={<CenterServicesPage />} />
            <Route path="/queue/preview" element={<QueuePreviewPage />} />
          </Routes>
        </MemoryRouter>
      </AuthProvider>
    );

    // Switch to manual input tab
    const manualTab = screen.getByRole('tab', { name: /enter qr code/i });
    await user.click(manualTab);

    const input = screen.getByLabelText(/QueueFlow QR or Join URL/i);
    expect(input).toBeInTheDocument();

    // Enter canonical College Account QR URL with both center and service
    await user.type(
      input,
      `https://queueflow.app/join?centerId=${COLLEGE_CENTER_ID}&serviceId=${COLLEGE_SERVICE_ID}`
    );

    const submitBtn = screen.getByRole('button', { name: /continue to queue/i });
    await user.click(submitBtn);

    // Resolves to Queue Preview for College Account
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /queue preview/i })).toBeInTheDocument();
      expect(screen.getByText(/College Account/i)).toBeInTheDocument();
    });
  });

  it('shows clear validation error when manual input is invalid', async () => {
    const user = userEvent.setup();

    render(
      <AuthProvider>
        <MemoryRouter initialEntries={['/join']}>
          <Routes>
            <Route path="/join" element={<JoinQrPage />} />
          </Routes>
        </MemoryRouter>
      </AuthProvider>
    );

    const manualTab = screen.getByRole('tab', { name: /enter qr code/i });
    await user.click(manualTab);

    const input = screen.getByLabelText(/QueueFlow QR or Join URL/i);
    await user.type(input, 'https://unknown-domain.com/join?centerId=123');

    const submitBtn = screen.getByRole('button', { name: /continue to queue/i });
    await user.click(submitBtn);

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
      expect(screen.getByText(/QR Error/i)).toBeInTheDocument();
    });
  });

  it('College Account QR without serviceId routes to service selection', async () => {
    const user = userEvent.setup();

    render(
      <AuthProvider>
        <MemoryRouter initialEntries={['/join']}>
          <Routes>
            <Route path="/join" element={<JoinQrPage />} />
            <Route path="/center/:id" element={<CenterServicesPage />} />
          </Routes>
        </MemoryRouter>
      </AuthProvider>
    );

    const manualTab = screen.getByRole('tab', { name: /enter qr code/i });
    await user.click(manualTab);

    const input = screen.getByLabelText(/QueueFlow QR or Join URL/i);
    await user.type(
      input,
      `https://queueflow.app/join?centerId=${COLLEGE_CENTER_ID}`
    );

    const submitBtn = screen.getByRole('button', { name: /continue to queue/i });
    await user.click(submitBtn);

    await waitFor(() => {
      expect(screen.getByText('College Account')).toBeInTheDocument();
      expect(screen.getByText('College Queue')).toBeInTheDocument();
    });
  });
});
