import { useState, useEffect, useCallback } from 'react';
import { useSearchParams, Link, useNavigate } from 'react-router-dom';
import { queueAPI, serviceCenterAPI, serviceAPI, tokenAPI } from '../services/api';
import { useAuth } from '../context/AuthContext';
import { SkeletonLoader } from '../components/SkeletonLoader';
import { ErrorAlert } from '../components/ErrorAlert';
import { AuthModal } from '../components/AuthModal';

export function QueuePreviewPage() {
  const [searchParams] = useSearchParams();
  const centerId = searchParams.get('centerId');
  const serviceId = searchParams.get('serviceId');
  const navigate = useNavigate();

  const { isAuthenticated, refreshActiveToken } = useAuth();

  const [center, setCenter] = useState(null);
  const [service, setService] = useState(null);
  const [queueData, setQueueData] = useState(null);
  const [estimatedWaitMinutes, setEstimatedWaitMinutes] = useState(null);
  const [waitingTokens, setWaitingTokens] = useState([]);
  const [calledTokens, setCalledTokens] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState(null);
  const [showAuthModal, setShowAuthModal] = useState(false);

  const fetchPreview = useCallback(async () => {
    if (!centerId || !serviceId) {
      setError('Missing centerId or serviceId parameter');
      setLoading(false);
      return;
    }

    try {
      setLoading(true);
      setError(null);
      setJoinError(null);

      const [cRes, sRes, qRes] = await Promise.all([
        serviceCenterAPI.getById(centerId),
        serviceAPI.getById(serviceId),
        queueAPI.getServiceQueue(centerId, serviceId),
      ]);

      setCenter(cRes.data?.serviceCenter || cRes.data || null);
      setService(sRes.data?.service || sRes.data || null);

      const qPayload = qRes.data?.queue || qRes.data || null;
      setQueueData(qPayload);
      // Tier 3 / Feature 1: the backend context-aware EWT engine is the single
      // authority for the estimate. Render it verbatim — never recompute here.
      setEstimatedWaitMinutes(
        typeof qRes.data?.estimatedWaitMinutes === 'number' ? qRes.data.estimatedWaitMinutes : null
      );
      setWaitingTokens(qRes.data?.waitingTokens || []);
      setCalledTokens(qRes.data?.calledTokens || []);
    } catch (err) {
      setError(err.message || 'Failed to load queue preview');
    } finally {
      setLoading(false);
    }
  }, [centerId, serviceId]);

  useEffect(() => {
    fetchPreview();
  }, [fetchPreview]);

  const handleJoinQueue = async () => {
    if (!isAuthenticated) {
      setShowAuthModal(true);
      return;
    }

    try {
      setJoining(true);
      setJoinError(null);

      // Server-authoritative token creation
      const res = await tokenAPI.joinQueue(centerId, serviceId);
      const createdToken = res.data?.token;

      if (!createdToken?._id) {
        throw new Error('Server did not return a valid token');
      }

      await refreshActiveToken();
      navigate(`/token/${createdToken._id}`);
    } catch (err) {
      if (err.status === 409) {
        setJoinError(
          err.message || 'You already have an active token for this service at this center.'
        );
      } else {
        setJoinError(err.message || 'Failed to join queue');
      }
    } finally {
      setJoining(false);
    }
  };

  if (!centerId || !serviceId) {
    return (
      <div className="qf-card" style={{ textAlign: 'center', padding: '2rem' }}>
        <h2 style={{ fontSize: '1.2rem', marginBottom: '0.5rem', color: '#F87171' }}>
          Invalid Queue Parameters
        </h2>
        <p style={{ color: 'var(--text-secondary)', marginBottom: '1.25rem' }}>
          Please select a valid center and service to preview the queue.
        </p>
        <Link to="/centers" className="btn-primary">
          Browse Centers
        </Link>
      </div>
    );
  }

  const waitingCount = queueData?.waitingCount !== undefined ? queueData.waitingCount : 'No data available';
  const queueStatus = queueData?.status || 'No data available';

  return (
    <>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
        {/* Navigation Breadcrumb */}
        <div>
          <Link
            to={`/center/${centerId}`}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.4rem',
              color: 'var(--text-secondary)',
              fontSize: '0.85rem',
              marginBottom: '0.75rem',
            }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="15 18 9 12 15 6" />
            </svg>
            Back to Services
          </Link>

          <h1 style={{ fontSize: '1.8rem', fontWeight: '800', marginBottom: '0.2rem' }}>
            Queue Preview
          </h1>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
            {service?.name ? `${service.name} at ` : ''}{center?.name || 'Service Center'}
          </p>
        </div>

        {loading ? (
          <SkeletonLoader type="preview" />
        ) : error ? (
          <ErrorAlert message={error} onRetry={fetchPreview} />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
            {/* Live Queue Metrics Card */}
            <div className="qf-card" style={{ border: '1px solid var(--border-accent)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.25rem' }}>
                <span style={{ fontSize: '0.8rem', fontWeight: '700', color: 'var(--text-muted)', textTransform: 'uppercase' }}>
                  Live Queue Status
                </span>
                <span
                  style={{
                    fontSize: '0.75rem',
                    fontWeight: '700',
                    padding: '0.25rem 0.6rem',
                    borderRadius: '9999px',
                    background: queueStatus === 'OPEN' ? 'var(--color-primary-subtle)' : 'rgba(255, 255, 255, 0.08)',
                    color: queueStatus === 'OPEN' ? 'var(--color-primary)' : 'var(--text-muted)',
                    border: queueStatus === 'OPEN' ? '1px solid var(--border-accent)' : '1px solid var(--border-subtle)',
                  }}
                >
                  {queueStatus}
                </span>
              </div>

              {/* Waiting & Estimated Time */}
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr 1fr',
                  gap: '1rem',
                  textAlign: 'center',
                  marginBottom: '1rem',
                }}
              >
                <div style={{ background: 'rgba(8, 12, 22, 0.5)', padding: '1rem', borderRadius: '12px' }}>
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '0.25rem' }}>
                    Waiting in Queue
                  </div>
                  <div style={{ fontSize: '2rem', fontWeight: '800', color: 'var(--color-primary)', fontFamily: 'var(--font-mono)' }}>
                    {waitingCount}
                  </div>
                </div>

                <div style={{ background: 'rgba(8, 12, 22, 0.5)', padding: '1rem', borderRadius: '12px' }}>
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '0.25rem' }}>
                    Est. Wait Time
                  </div>
                  <div style={{ fontSize: '2rem', fontWeight: '800', color: 'var(--color-cyan)', fontFamily: 'var(--font-mono)' }}>
                    {typeof estimatedWaitMinutes === 'number'
                      ? `~${estimatedWaitMinutes}m`
                      : 'No data available'}
                  </div>
                </div>
              </div>

              {/* Called Tokens / Active Counters preview */}
              {calledTokens.length > 0 && (
                <div style={{ marginTop: '1rem', borderTop: '1px solid var(--border-subtle)', paddingTop: '1rem' }}>
                  <div style={{ fontSize: '0.8rem', fontWeight: '700', color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '0.5rem' }}>
                    Currently at Counters
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
                    {calledTokens.map((ct) => (
                      <span
                        key={ct._id || ct.tokenCode}
                        style={{
                          fontSize: '0.85rem',
                          fontFamily: 'var(--font-mono)',
                          fontWeight: '700',
                          padding: '0.35rem 0.65rem',
                          borderRadius: '8px',
                          background: 'rgba(0, 210, 255, 0.1)',
                          border: '1px solid var(--border-cyan)',
                          color: 'var(--color-cyan)',
                        }}
                      >
                        {ct.tokenCode} → {ct.counterId?.displayLabel || ct.counterId?.name || 'Counter'}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Waiting Tokens Preview */}
              {waitingTokens.length > 0 && (
                <div style={{ marginTop: '1rem', borderTop: '1px solid var(--border-subtle)', paddingTop: '1rem' }}>
                  <div style={{ fontSize: '0.8rem', fontWeight: '700', color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '0.5rem' }}>
                    Next in Line Preview
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
                    {waitingTokens.map((wt) => (
                      <span
                        key={wt._id || wt.tokenCode}
                        style={{
                          fontSize: '0.85rem',
                          fontFamily: 'var(--font-mono)',
                          fontWeight: '600',
                          padding: '0.35rem 0.65rem',
                          borderRadius: '8px',
                          background: 'rgba(255, 255, 255, 0.05)',
                          border: '1px solid var(--border-subtle)',
                          color: 'var(--text-secondary)',
                        }}
                      >
                        {wt.tokenCode}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Error or Conflict Alert */}
            {joinError && (
              <div
                role="alert"
                style={{
                  padding: '1rem',
                  borderRadius: '12px',
                  background: 'rgba(239, 68, 68, 0.12)',
                  border: '1px solid rgba(239, 68, 68, 0.35)',
                  color: '#F87171',
                  fontSize: '0.9rem',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '0.5rem',
                }}
              >
                <div>{joinError}</div>
                {joinError.includes('already have an active token') && (
                  <Link
                    to="/my-tokens"
                    style={{
                      color: 'var(--color-primary)',
                      fontWeight: '700',
                      textDecoration: 'underline',
                    }}
                  >
                    View Your Active Token →
                  </Link>
                )}
              </div>
            )}

            {/* Join Queue CTA Button */}
            <button
              type="button"
              className="btn-primary"
              onClick={handleJoinQueue}
              disabled={joining || queueStatus === 'CLOSED'}
              style={{
                width: '100%',
                padding: '1.1rem',
                fontSize: '1.05rem',
              }}
            >
              {joining ? (
                'Generating Authoritative Token...'
              ) : queueStatus === 'CLOSED' ? (
                'Queue is Currently Closed'
              ) : (
                'Join Queue Now'
              )}
            </button>
          </div>
        )}
      </div>

      {/* Auth Modal for Unauthenticated Users */}
      <AuthModal
        isOpen={showAuthModal}
        onClose={() => setShowAuthModal(false)}
        onSuccess={() => {
          setShowAuthModal(false);
          handleJoinQueue();
        }}
        initialMode="register"
      />
    </>
  );
}
