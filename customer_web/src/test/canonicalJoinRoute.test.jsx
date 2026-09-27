import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { JoinQrPage } from '../pages/JoinQrPage';
import { CenterServicesPage } from '../pages/CenterServicesPage';
import { QueuePreviewPage } from '../pages/QueuePreviewPage';
import { serviceCenterAPI, serviceAPI, queueAPI, tokenAPI } from '../services/api';
import { AuthProvider } from '../context/AuthContext';

/**
 * Canonical Customer Queue QR — Customer Web side (cases 15 & 16).
 *
 * The Live Counter encodes exactly one URL:
 *
 *   https://<customer-web-host>/join?centerId=<24hex>[&serviceId=<24hex>]
 *
 * When the phone has no QueueFlow app, that same URL opens in a browser and
 * must drive the customer through the existing, unmodified flow:
 *
 *   /join  ->  CENTER -> SERVICE -> PREVIEW -> DOCUMENT GATE -> JOIN
 *
 * Nothing here may create a second queue system; these tests assert the
 * canonical URL reaches the existing CENTER and PREVIEW screens.
 */

const CENTER_ID = '507f1f77bcf86cd799439011';
const SERVICE_ID = '507f191e810c19729de860ea';
const HOST = 'queueflow.app';

/** Renders the real route table subset that /join navigates into. */
function renderJoinRoute(path) {
  return render(
    <AuthProvider>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/join" element={<JoinQrPage />} />
          <Route path="/center/:id" element={<CenterServicesPage />} />
          <Route path="/queue/preview" element={<QueuePreviewPage />} />
          <Route path="*" element={<div>Route Not Found</div>} />
        </Routes>
      </MemoryRouter>
    </AuthProvider>
  );
}

function mockCenterAndServices() {
  vi.spyOn(serviceCenterAPI, 'getById').mockResolvedValue({
    data: { serviceCenter: { _id: CENTER_ID, name: 'Central City Center' } },
  });
  vi.spyOn(serviceAPI, 'listByCenter').mockResolvedValue({
    data: {
      services: [
        { _id: SERVICE_ID, name: 'Passport Services', isActive: true },
        { _id: '507f1f77bcf86cd799439099', name: 'Closed Desk', isActive: false },
      ],
    },
  });
  vi.spyOn(serviceAPI, 'getById').mockResolvedValue({
    data: { service: { _id: SERVICE_ID, name: 'Passport Services', isActive: true } },
  });
  vi.spyOn(queueAPI, 'getServiceQueue').mockResolvedValue({
    data: { queue: { waitingCount: 3, status: 'OPEN' }, waitingTokens: [], calledTokens: [] },
  });
}

describe('15. Canonical HTTPS /join URL routes into the existing flow', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockCenterAndServices();
  });

  it('15a. /join?centerId=…&serviceId=… goes straight to QUEUE PREVIEW', async () => {
    renderJoinRoute(
      `/join?centerId=${CENTER_ID}&serviceId=${SERVICE_ID}`
    );

    // The canonical URL is consumed, not shown as an error.
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /queue preview/i })).toBeInTheDocument();
    });

    // It is the real QueuePreviewPage: live queue status + the document gate +
    // the join CTA. No QR error surfaced.
    expect(screen.queryByText(/QR Error/i)).not.toBeInTheDocument();
    expect(screen.getByText(/live queue status/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /join queue now/i })).toBeInTheDocument();
  });

  it('15b. /join?centerId=… goes to CENTER -> SERVICE selection', async () => {
    renderJoinRoute(`/join?centerId=${CENTER_ID}`);

    // CenterServicesPage is the service-selection screen, reached without ever
    // touching a QR-specific page.
    await waitFor(() => {
      expect(screen.getByText('Passport Services')).toBeInTheDocument();
    });
    expect(screen.getByText('Closed Desk')).toBeInTheDocument();
    expect(screen.queryByText(/Route Not Found/i)).not.toBeInTheDocument();
  });

  it('15c. the preview reached from /join is joined server-side, not locally', async () => {
    // The QR carries routing parameters only. A token is created exclusively by
    // the user tapping Join in the preview, via tokenAPI.
    const joinSpy = vi.spyOn(tokenAPI, 'joinQueue');

    renderJoinRoute(`/join?centerId=${CENTER_ID}&serviceId=${SERVICE_ID}`);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /join queue now/i })).toBeInTheDocument();
    });

    // Merely landing on /join must not have joined anything.
    expect(joinSpy).not.toHaveBeenCalled();
  });
});

describe('16. /join rejects what is not a join link', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockCenterAndServices();
  });

  it('16a. a malformed centerId is reported, not silently ignored', async () => {
    renderJoinRoute('/join?centerId=not-a-mongo-id');

    await waitFor(() => {
      expect(screen.getByText(/Invalid Service Center ID format/i)).toBeInTheDocument();
    });
    // It must NOT have fallen through to the center page with a bad id.
    expect(screen.queryByText('Passport Services')).not.toBeInTheDocument();
  });

  it('16b. a malformed serviceId is reported', async () => {
    renderJoinRoute(`/join?centerId=${CENTER_ID}&serviceId=xyz`);

    await waitFor(() => {
      expect(screen.getByText(/Invalid Service ID format/i)).toBeInTheDocument();
    });
  });

  it('16c. a centerId that is also used as the serviceId is rejected', async () => {
    renderJoinRoute(`/join?centerId=${CENTER_ID}&serviceId=${CENTER_ID}`);

    await waitFor(() => {
      expect(screen.getByText(/mismatched service and center/i)).toBeInTheDocument();
    });
  });

  it('16d. /join with no center reference at all says so', async () => {
    // Silently rendering the paste-a-link form reads as "nothing happened".
    renderJoinRoute('/join');

    await waitFor(() => {
      expect(
        screen.getByText(/does not identify a service center/i)
      ).toBeInTheDocument();
    });
  });

  it('16e. an unrelated ?url= payload is rejected, not followed', async () => {
    renderJoinRoute('/join?url=https%3A%2F%2Fevil.test%2Fnope');

    await waitFor(() => {
      expect(screen.getByText(/QR Error/i)).toBeInTheDocument();
    });
  });
});
