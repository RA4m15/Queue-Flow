import { useState, useEffect } from 'react';
import { tokenAPI } from '../services/api';

/**
 * NextStepCard
 * Displays candidate next services in the multi-hop workflow once a service is completed.
 * Allows customer to confirm transition or decline ("Not now").
 */
export function NextStepCard({ tokenId, onTransitionSuccess }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [data, setData] = useState(null);
  const [dismissed, setDismissed] = useState(false);
  const [confirmingId, setConfirmingId] = useState(null);

  useEffect(() => {
    let isMounted = true;

    async function fetchNextServices() {
      if (!tokenId) return;
      try {
        setLoading(true);
        setError(null);
        const res = await tokenAPI.getNextServices(tokenId);
        if (isMounted) {
          setData(res.data?.data || null);
        }
      } catch (err) {
        if (isMounted) {
          setError(err.message || 'Unable to check next workflow step');
        }
      } finally {
        if (isMounted) setLoading(false);
      }
    }

    fetchNextServices();
    return () => {
      isMounted = false;
    };
  }, [tokenId]);

  const handleConfirm = async (serviceId) => {
    try {
      setConfirmingId(serviceId);
      setError(null);
      const res = await tokenAPI.confirmNextHop(tokenId, serviceId);
      if (onTransitionSuccess) {
        onTransitionSuccess(res.data?.data?.token);
      }
    } catch (err) {
      setError(err.message || 'Failed to confirm next service');
    } finally {
      setConfirmingId(null);
    }
  };

  if (loading) {
    return (
      <div
        className="qf-card"
        style={{
          marginTop: '1.25rem',
          padding: '1.25rem',
          background: 'rgba(15, 23, 42, 0.6)',
          border: '1px solid var(--border-subtle)',
          borderRadius: '12px',
          textAlign: 'center',
        }}
      >
        <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
          Checking workflow steps...
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div
        className="qf-card"
        style={{
          marginTop: '1.25rem',
          padding: '1rem',
          background: 'rgba(239, 68, 68, 0.1)',
          border: '1px solid rgba(239, 68, 68, 0.3)',
          borderRadius: '12px',
          color: '#F87171',
          fontSize: '0.85rem',
        }}
      >
        {error}
      </div>
    );
  }

  if (!data) return null;

  // Already transitioned to next step
  if (data.alreadyTransitioned && data.nextToken) {
    return (
      <div
        className="qf-card"
        style={{
          marginTop: '1.25rem',
          padding: '1.25rem',
          background: 'linear-gradient(135deg, rgba(0, 229, 168, 0.08) 0%, rgba(14, 165, 233, 0.08) 100%)',
          border: '1px solid rgba(0, 229, 168, 0.3)',
          borderRadius: '12px',
          textAlign: 'center',
        }}
      >
        <div style={{ fontSize: '0.8rem', fontWeight: 800, color: 'var(--color-primary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.4rem' }}>
          Next Step Active
        </div>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginBottom: '0.75rem' }}>
          You have already confirmed and joined the queue for token <strong>{data.nextToken.tokenCode}</strong>.
        </p>
      </div>
    );
  }

  // Journey Complete — truthful no next service
  if (data.isJourneyComplete || !data.hasNextService || !data.nextServices || data.nextServices.length === 0) {
    return (
      <div
        className="qf-card"
        style={{
          marginTop: '1.25rem',
          padding: '1.25rem',
          background: 'rgba(15, 23, 42, 0.5)',
          border: '1px solid var(--border-subtle)',
          borderRadius: '12px',
          textAlign: 'center',
        }}
      >
        <div style={{ fontSize: '1.5rem', marginBottom: '0.25rem' }}>✨</div>
        <div style={{ fontWeight: 800, fontSize: '1rem', color: 'var(--text-main)', marginBottom: '0.25rem' }}>
          Journey Complete
        </div>
        <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
          All required steps for this service visit have been completed.
        </div>
      </div>
    );
  }

  if (dismissed) {
    return (
      <div
        style={{
          marginTop: '1rem',
          padding: '0.75rem 1rem',
          background: 'rgba(255, 255, 255, 0.03)',
          borderRadius: '8px',
          border: '1px solid var(--border-subtle)',
          fontSize: '0.8rem',
          color: 'var(--text-muted)',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <span>Next service step postponed.</span>
        <button
          type="button"
          onClick={() => setDismissed(false)}
          style={{
            background: 'transparent',
            border: 'none',
            color: 'var(--color-primary)',
            fontSize: '0.8rem',
            fontWeight: 700,
            cursor: 'pointer',
            padding: 0,
          }}
        >
          View Next Step
        </button>
      </div>
    );
  }

  return (
    <div
      className="qf-card"
      style={{
        marginTop: '1.25rem',
        padding: '1.5rem',
        background: 'linear-gradient(135deg, rgba(15, 23, 42, 0.9) 0%, rgba(30, 41, 59, 0.8) 100%)',
        border: '1px solid var(--color-primary)',
        borderRadius: '14px',
        boxShadow: '0 8px 32px rgba(0, 229, 168, 0.1)',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <span style={{ fontSize: '1.1rem' }}>➡️</span>
          <span style={{ fontSize: '0.85rem', fontWeight: 800, color: 'var(--color-primary)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
            Next Step in Journey
          </span>
        </div>
        <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
          Multi-Hop Workflow
        </span>
      </div>

      <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginBottom: '1rem' }}>
        Your previous service is complete. You are eligible to continue to the next service:
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', marginBottom: '1.25rem' }}>
        {data.nextServices.map((svc) => (
          <div
            key={svc.serviceId}
            style={{
              padding: '1rem',
              background: 'rgba(8, 12, 22, 0.7)',
              border: '1px solid var(--border-subtle)',
              borderRadius: '10px',
              display: 'flex',
              flexDirection: 'column',
              gap: '0.5rem',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <span
                  style={{
                    fontSize: '0.75rem',
                    fontWeight: 800,
                    padding: '2px 8px',
                    borderRadius: '6px',
                    background: 'rgba(0, 229, 168, 0.15)',
                    color: 'var(--color-primary)',
                    fontFamily: 'monospace',
                  }}
                >
                  {svc.tokenPrefix}
                </span>
                <span style={{ fontWeight: 700, fontSize: '0.95rem', color: 'var(--text-main)' }}>
                  {svc.name}
                </span>
              </div>
              <span
                style={{
                  fontSize: '0.7rem',
                  fontWeight: 700,
                  textTransform: 'uppercase',
                  padding: '2px 6px',
                  borderRadius: '4px',
                  background: svc.relationshipType === 'REQUIRED' ? 'rgba(239, 68, 68, 0.15)' : 'rgba(59, 130, 246, 0.15)',
                  color: svc.relationshipType === 'REQUIRED' ? '#FCA5A5' : '#93C5FD',
                }}
              >
                {svc.relationshipType}
              </span>
            </div>

            {svc.description && (
              <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                {svc.description}
              </div>
            )}

            <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
              <span>
                Estimated wait: <strong style={{ color: 'var(--text-main)' }}>{svc.waitEstimateMinutes !== null ? `~${svc.waitEstimateMinutes} min` : 'Available immediately'}</strong>
              </span>
              <span>•</span>
              <span>
                In queue: <strong style={{ color: 'var(--text-main)' }}>{svc.waitingCount || 0} waiting</strong>
              </span>
            </div>

            <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
              <button
                type="button"
                className="btn-primary"
                style={{ flex: 1, padding: '0.5rem 1rem', fontSize: '0.85rem' }}
                onClick={() => handleConfirm(svc.serviceId)}
                disabled={confirmingId === svc.serviceId}
              >
                {confirmingId === svc.serviceId ? 'Joining Queue...' : 'Continue to Next Service'}
              </button>
              <button
                type="button"
                className="btn-secondary"
                style={{ padding: '0.5rem 1rem', fontSize: '0.85rem' }}
                onClick={() => setDismissed(true)}
                disabled={confirmingId === svc.serviceId}
              >
                Not now
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
