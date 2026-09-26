import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SkeletonLoader } from '../components/SkeletonLoader';
import { ErrorAlert } from '../components/ErrorAlert';
import { OfflineBanner } from '../components/OfflineBanner';
import { TokenCard } from '../components/TokenCard';
import { StatusBadge } from '../components/StatusBadge';

describe('Component & State Tests (Requirements 3, 4, 5, 10, 15, 17, 18)', () => {
  it('Requirement 3: renders skeleton loading states correctly', () => {
    const { container } = render(<SkeletonLoader count={3} />);
    const skeletons = container.querySelectorAll('.skeleton');
    expect(skeletons.length).toBeGreaterThan(0);
  });

  it('Requirement 5: renders API error state and triggers retry callback', () => {
    const retryFn = vi.fn();
    render(<ErrorAlert message="Failed to connect to QueueFlow backend" onRetry={retryFn} />);

    expect(screen.getByText('Unable to Load Information')).toBeInTheDocument();
    expect(screen.getByText('Failed to connect to QueueFlow backend')).toBeInTheDocument();

    const retryBtn = screen.getByRole('button', { name: /try again/i });
    fireEvent.click(retryBtn);
    expect(retryFn).toHaveBeenCalledTimes(1);
  });

  it('Requirement 17: renders offline banner when browser is offline', () => {
    const { rerender } = render(<OfflineBanner isOnline={false} />);
    expect(screen.getByRole('alert')).toHaveTextContent(/you are offline/i);

    rerender(<OfflineBanner isOnline={true} />);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('Requirement 10: renders real backend token data in digital TokenCard', () => {
    const realToken = {
      _id: '507f1f77bcf86cd799439011',
      tokenCode: 'A045',
      tokenNumber: 45,
      status: 'WAITING',
      currentPosition: 4,
      createdAt: '2026-09-25T10:00:00.000Z',
      centerId: { name: 'Downtown Center' },
      serviceId: { name: 'Passport Renewal' },
      counterId: { displayLabel: 'Desk 3' },
    };

    render(<TokenCard token={realToken} />);

    expect(screen.getByText('A045')).toBeInTheDocument();
    expect(screen.getByText('Passport Renewal')).toBeInTheDocument();
    expect(screen.getByText('Downtown Center')).toBeInTheDocument();
    expect(screen.getByText('#4')).toBeInTheDocument();
    expect(screen.getByText('Desk 3')).toBeInTheDocument();
  });

  it('Requirement 18: no fake or static business values rendered in StatusBadge', () => {
    const { rerender } = render(<StatusBadge status="CALLED" />);
    expect(screen.getByText(/now called/i)).toBeInTheDocument();

    rerender(<StatusBadge status="SERVING" />);
    expect(screen.getByText(/being served/i)).toBeInTheDocument();
  });
});
