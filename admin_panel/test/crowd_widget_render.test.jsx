/**
 * Render check for the Admin dashboard's crowd card.
 *
 * No browser is attached to this session, so this substitutes for a visual
 * smoke test: it renders the real component with the real module and asserts the
 * three states an operator can see - live reading, sensor offline, and no reading
 * yet - plus that no state ever displays an invented number.
 *
 * Run:  npx vitest run --root ..\\admin_panel test/crowd_widget_render.test.jsx
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import * as matchers from '@testing-library/jest-dom/matchers';
expect.extend(matchers);
import React from 'react';

vi.mock('../src/services/api', () => ({
  crowdAPI: { getStatus: vi.fn() },
  devAPI: { simulateCrowd: vi.fn(), resetCrowd: vi.fn() },
}));
vi.mock('../src/context/SocketContext', () => ({
  useSocket: () => ({ on: () => () => {} }),
}));

import CrowdWidget from '../src/components/dashboard/CrowdWidget.jsx';
import { CROWD_SENSOR_STALE_MS } from '../src/services/crowdState.js';

const CENTER = '6ab93df8da6b1eefeb19caa2';
const fresh = () => new Date().toISOString();
const staleStamp = () => new Date(Date.now() - (CROWD_SENSOR_STALE_MS + 30_000)).toISOString();

describe('CrowdWidget render states', () => {
  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(() => { cleanup(); });

  it('renders the authoritative live reading with ONLINE chip and real timestamp', () => {
    render(<CrowdWidget crowdData={{
      centerId: CENTER, currentCrowd: 1, capacity: 200, crowdPercent: 1,
      crowdStatus: 'LOW', crowdUpdatedAt: fresh(), crowdSensorOnline: true,
    }} isReadingStale={() => false} />);

    expect(screen.getByText(/Live footfall/i)).toBeInTheDocument();
    expect(screen.getByText('1')).toBeInTheDocument();
    expect(screen.getByText('/ 200 inside')).toBeInTheDocument();
    expect(screen.getByText('1%')).toBeInTheDocument();
    expect(screen.getByText('ONLINE')).toBeInTheDocument();
    expect(screen.getByText(/QUIET/)).toBeInTheDocument();
    expect(screen.getByText(/Last updated:/i)).toBeInTheDocument();

    // Verify Entry / Exit / Reset controls are completely absent
    expect(screen.queryByText(/Entry/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Exit/i)).not.toBeInTheDocument();
    expect(screen.queryByTitle(/Reset/i)).not.toBeInTheDocument();
  });

  it('renders a real count of zero as a reading, not as unavailable', () => {
    render(<CrowdWidget crowdData={{
      centerId: CENTER, currentCrowd: 0, capacity: 200, crowdPercent: 0,
      crowdStatus: 'LOW', crowdUpdatedAt: fresh(), crowdSensorOnline: true,
    }} isReadingStale={() => false} />);

    expect(screen.getByText('0')).toBeInTheDocument();
    expect(screen.getByText('ONLINE')).toBeInTheDocument();
    expect(screen.getByText(/QUIET/)).toBeInTheDocument();
    expect(screen.queryByText(/no longer being reported/i)).not.toBeInTheDocument();
  });

  it('shows OFFLINE, dash, and honest notice when the sensor stopped', () => {
    render(<CrowdWidget crowdData={{
      centerId: CENTER, currentCrowd: 42, capacity: 200, crowdPercent: 21,
      crowdStatus: 'LOW', crowdUpdatedAt: staleStamp(), crowdSensorOnline: false,
    }} isReadingStale={() => true} />);

    expect(screen.getByText('OFFLINE')).toBeInTheDocument();
    expect(screen.getByText(/Last reading is no longer being reported/i)).toBeInTheDocument();
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.queryByText('42')).not.toBeInTheDocument();
    expect(screen.queryByText('21%')).not.toBeInTheDocument();
    expect(screen.queryByText('0')).not.toBeInTheDocument();
  });

  it('shows OFFLINE, dash, and does not fabricate 0 when no reading has ever arrived', () => {
    render(<CrowdWidget crowdData={{
      currentCrowd: null, capacity: null, crowdPercent: null,
      crowdStatus: null, crowdUpdatedAt: null, crowdSensorOnline: false,
    }} isReadingStale={() => true} />);

    expect(screen.getByText('OFFLINE')).toBeInTheDocument();
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.getByText(/Last reading is no longer being reported/i)).toBeInTheDocument();
    expect(screen.queryByText('0')).not.toBeInTheDocument();
    expect(screen.queryByText(/0%/)).not.toBeInTheDocument();
  });

  it('maps the backend status to the shared vocabulary alongside ONLINE chip', () => {
    for (const [status, label] of [['HIGH', 'BUSY'], ['MODERATE', 'MODERATE'], ['LOW', 'QUIET']]) {
      cleanup();
      render(<CrowdWidget crowdData={{
        centerId: CENTER, currentCrowd: 90, capacity: 200, crowdPercent: 45,
        crowdStatus: status, crowdUpdatedAt: fresh(), crowdSensorOnline: true,
      }} isReadingStale={() => false} />);

      const chip = document.querySelector('.crowd-status-chip');
      expect(chip).not.toBeNull();
      expect(chip.textContent).toContain('ONLINE');
      expect(chip.textContent).toContain(label);
    }
  });

  it('does not invent an occupancy figure when capacity is unknown', () => {
    render(<CrowdWidget crowdData={{
      centerId: CENTER, currentCrowd: 7, capacity: null, crowdPercent: null,
      crowdStatus: null, crowdUpdatedAt: fresh(), crowdSensorOnline: true,
    }} isReadingStale={() => false} />);

    expect(screen.getByText('7')).toBeInTheDocument();
    expect(screen.getByText(/capacity not configured/i)).toBeInTheDocument();
    expect(screen.queryByText(/%/)).not.toBeInTheDocument();
  });

  it('guarantees manual Entry, Exit, and Reset buttons are never rendered in any state', () => {
    // 1. Online state
    const { unmount } = render(<CrowdWidget crowdData={{
      centerId: CENTER, currentCrowd: 15, capacity: 100, crowdPercent: 15,
      crowdStatus: 'LOW', crowdUpdatedAt: fresh(), crowdSensorOnline: true,
    }} isReadingStale={() => false} />);

    expect(screen.queryByText(/\+ Entry/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/− Exit/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/- Exit/i)).not.toBeInTheDocument();
    expect(document.querySelector('.crowd-dev')).toBeNull();
    unmount();

    // 2. Offline state
    render(<CrowdWidget crowdData={{
      centerId: CENTER, currentCrowd: null, capacity: 100, crowdPercent: null,
      crowdStatus: null, crowdUpdatedAt: null, crowdSensorOnline: false,
    }} isReadingStale={() => true} />);

    expect(screen.queryByText(/\+ Entry/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/− Exit/i)).not.toBeInTheDocument();
    expect(document.querySelector('.crowd-dev')).toBeNull();
  });
});
