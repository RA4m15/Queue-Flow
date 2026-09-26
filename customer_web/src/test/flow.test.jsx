import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { CentersPage } from '../pages/CentersPage';
import { CenterServicesPage } from '../pages/CenterServicesPage';
import { QueuePreviewPage } from '../pages/QueuePreviewPage';
import { serviceCenterAPI, serviceAPI, queueAPI } from '../services/api';
import { AuthProvider } from '../context/AuthContext';

describe('Customer Web Real Flow Tests (Requirements 1, 2, 4, 6, 15)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('Requirement 1: renders actual service centers list from API', async () => {
    const mockCenters = [
      {
        _id: '507f1f77bcf86cd799439011',
        name: 'Central City Center',
        type: 'GOVERNMENT',
        address: { street: '123 Main St', city: 'Metropolis' },
      },
      {
        _id: '507f1f77bcf86cd799439012',
        name: 'Westside Branch',
        type: 'HEALTHCARE',
        address: '456 West Ave',
      },
    ];

    vi.spyOn(serviceCenterAPI, 'list').mockResolvedValueOnce({
      data: { centers: mockCenters },
    });

    render(
      <MemoryRouter>
        <CentersPage />
      </MemoryRouter>
    );

    // Initial loading state
    expect(screen.queryByText('Central City Center')).not.toBeInTheDocument();

    // Loaded state
    await waitFor(() => {
      expect(screen.getByText('Central City Center')).toBeInTheDocument();
      expect(screen.getByText('Westside Branch')).toBeInTheDocument();
    });
  });

  it('Requirement 4: renders empty state when API returns empty centers list', async () => {
    vi.spyOn(serviceCenterAPI, 'list').mockResolvedValueOnce({
      data: { centers: [] },
    });

    render(
      <MemoryRouter>
        <CentersPage />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('No service centers available')).toBeInTheDocument();
    });
  });

  it('Requirement 2 & 15: renders service list from API and disables inactive services', async () => {
    const centerId = '507f1f77bcf86cd799439011';
    const mockCenter = { _id: centerId, name: 'North Branch' };
    const mockServices = [
      {
        _id: 'service_1',
        name: 'Express Registration',
        tokenPrefix: 'E',
        description: 'Fast track registration',
        isActive: true,
      },
      {
        _id: 'service_2',
        name: 'Special Permit',
        tokenPrefix: 'P',
        description: 'Seasonal service',
        isActive: false, // Inactive
      },
    ];

    vi.spyOn(serviceCenterAPI, 'getById').mockResolvedValueOnce({
      data: { serviceCenter: mockCenter },
    });
    vi.spyOn(serviceAPI, 'listByCenter').mockResolvedValueOnce({
      data: { services: mockServices },
    });

    render(
      <MemoryRouter initialEntries={[`/center/${centerId}`]}>
        <Routes>
          <Route path="/center/:id" element={<CenterServicesPage />} />
        </Routes>
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('Express Registration')).toBeInTheDocument();
      expect(screen.getByText('Special Permit')).toBeInTheDocument();
    });

    // Inactive service verification (Requirement 15)
    const inactiveService = screen.getByRole('button', { name: /Special Permit/i });
    expect(inactiveService).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByText('Unavailable')).toBeInTheDocument();
  });

  it('Requirement 6: renders real queue preview and shows "No data available" for missing fields', async () => {
    const centerId = '507f1f77bcf86cd799439011';
    const serviceId = '507f191e810c19729de860ea';

    vi.spyOn(serviceCenterAPI, 'getById').mockResolvedValueOnce({
      data: { serviceCenter: { _id: centerId, name: 'Central Center' } },
    });
    vi.spyOn(serviceAPI, 'getById').mockResolvedValueOnce({
      data: { service: { _id: serviceId, name: 'General Queue' } },
    });
    vi.spyOn(queueAPI, 'getServiceQueue').mockResolvedValueOnce({
      data: {
        queue: { waitingCount: 5, status: 'OPEN' },
        waitingTokens: [],
        calledTokens: [],
      },
    });

    render(
      <AuthProvider>
        <MemoryRouter initialEntries={[`/queue/preview?centerId=${centerId}&serviceId=${serviceId}`]}>
          <Routes>
            <Route path="/queue/preview" element={<QueuePreviewPage />} />
          </Routes>
        </MemoryRouter>
      </AuthProvider>
    );

    await waitFor(() => {
      expect(screen.getByText('5')).toBeInTheDocument();
      expect(screen.getByText('OPEN')).toBeInTheDocument();
      // Estimated wait time has no avgServiceTimeMinutes provided, so it displays "No data available"
      expect(screen.getByText('No data available')).toBeInTheDocument();
    });
  });
});
