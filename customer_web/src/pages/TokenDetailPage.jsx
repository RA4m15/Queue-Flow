import { useParams, Link } from 'react-router-dom';
import { useLiveToken } from '../hooks/useLiveToken';
import { TokenCard } from '../components/TokenCard';
import { SkeletonLoader } from '../components/SkeletonLoader';
import { ErrorAlert } from '../components/ErrorAlert';
import { useAuth } from '../context/AuthContext';
import { useNetworkStatus } from '../hooks/useNetworkStatus';
import { OfflineBanner } from '../components/OfflineBanner';

export function TokenDetailPage() {
  const { id } = useParams();
  const { token, loading, error, turnAlert, dismissTurnAlert, refetch } = useLiveToken(id);
  const { refreshActiveToken } = useAuth();
  const { isOnline } = useNetworkStatus();

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
      <OfflineBanner isOnline={isOnline} />

      {/* Turn Alert Announcement Banner */}
      {turnAlert && (
        <div
          role="alert"
          aria-live="assertive"
          className="qf-card pulse-mint"
          style={{
            background: 'linear-gradient(135deg, rgba(0, 229, 168, 0.25) 0%, rgba(0, 210, 255, 0.2) 100%)',
            border: '2px solid var(--color-primary)',
            padding: '1.25rem',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '1rem',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <span style={{ fontSize: '1.75rem' }}>🔔</span>
            <div>
              <div style={{ fontWeight: '800', color: 'var(--color-primary)', fontSize: '1.1rem' }}>
                Your Turn Has Arrived!
              </div>
              <div style={{ color: 'var(--text-main)', fontSize: '0.9rem' }}>
                {turnAlert}
              </div>
            </div>
          </div>
          <button
            type="button"
            className="btn-primary"
            style={{ padding: '0.5rem 1rem', fontSize: '0.85rem' }}
            onClick={dismissTurnAlert}
          >
            Got It
          </button>
        </div>
      )}

      {/* Header with back link & refresh */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Link
          to="/centers"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '0.4rem',
            color: 'var(--text-secondary)',
            fontSize: '0.85rem',
          }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polyline points="15 18 9 12 15 6" />
          </svg>
          Browse Centers
        </Link>

        <button
          type="button"
          onClick={() => {
            refetch();
            refreshActiveToken();
          }}
          className="btn-secondary"
          style={{ padding: '0.4rem 0.75rem', fontSize: '0.8rem' }}
          title="Refresh token status"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polyline points="23 4 23 10 17 10" />
            <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
          </svg>
          Refresh
        </button>
      </div>

      {loading && !token ? (
        <SkeletonLoader type="token" />
      ) : error && !token ? (
        <ErrorAlert message={error} onRetry={refetch} />
      ) : !token ? (
        <div className="qf-card" style={{ textAlign: 'center', padding: '3rem 1.5rem' }}>
          <h2 style={{ fontSize: '1.2rem', marginBottom: '0.5rem', color: 'var(--text-main)' }}>
            Token Not Found
          </h2>
          <p style={{ color: 'var(--text-secondary)', marginBottom: '1.25rem', fontSize: '0.9rem' }}>
            This token does not exist or has already been completed/expired.
          </p>
          <Link to="/centers" className="btn-primary">
            Join a New Queue
          </Link>
        </div>
      ) : (
        <TokenCard
          token={token}
          onCancelled={() => {
            refetch();
            refreshActiveToken();
          }}
          onRefresh={refetch}
        />
      )}
    </div>
  );
}
