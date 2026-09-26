import { useState } from 'react';
import { StatusBadge } from './StatusBadge';
import { tokenAPI } from '../services/api';

export function TokenCard({ token, onCancelled, onRefresh }) {
  const [showQRModal, setShowQRModal] = useState(false);
  const [qrLoading, setQrLoading] = useState(false);
  const [qrData, setQrData] = useState(null);
  const [qrError, setQrError] = useState(null);
  const [cancelling, setCancelling] = useState(false);
  const [cancelConfirm, setCancelConfirm] = useState(false);

  if (!token) return null;

  const centerName = typeof token.centerId === 'object' && token.centerId?.name
    ? token.centerId.name
    : 'Service Center';

  const serviceName = typeof token.serviceId === 'object' && token.serviceId?.name
    ? token.serviceId.name
    : 'Service';

  const counterDisplay = typeof token.counterId === 'object' && token.counterId
    ? (token.counterId.displayLabel || token.counterId.name || `Counter ${token.counterId.number || ''}`)
    : null;

  const isCancellable = token.status === 'WAITING';
  const isActive = ['WAITING', 'CALLED', 'SERVING'].includes(token.status);

  const handleOpenQR = async () => {
    setShowQRModal(true);
    if (!qrData) {
      try {
        setQrLoading(true);
        setQrError(null);
        const res = await tokenAPI.getQR(token._id);
        setQrData(res.data?.qrImage || null);
      } catch (err) {
        setQrError(err.message || 'Unable to load token QR');
      } finally {
        setQrLoading(false);
      }
    }
  };

  const handleCancel = async () => {
    try {
      setCancelling(true);
      await tokenAPI.cancel(token._id);
      setCancelConfirm(false);
      if (onCancelled) onCancelled(token._id);
      if (onRefresh) onRefresh();
    } catch (err) {
      alert(err.message || 'Failed to cancel token');
    } finally {
      setCancelling(false);
    }
  };

  return (
    <>
      <article className="ticket-container" aria-label={`Digital Token ${token.tokenCode}`}>
        {/* Ticket Header */}
        <div className="ticket-header">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.4rem' }}>
            <span style={{ fontSize: '0.8rem', fontWeight: '700', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Digital Token
            </span>
            <StatusBadge status={token.status} />
          </div>

          <h2 style={{ fontSize: '1.25rem', fontWeight: '800', color: 'var(--text-main)', marginBottom: '0.2rem' }}>
            {serviceName}
          </h2>
          <p style={{ fontSize: '0.9rem', color: 'var(--text-secondary)' }}>
            {centerName}
          </p>
        </div>

        {/* Ticket Body: Token Number */}
        <div className="ticket-body" style={{ textAlign: 'center', padding: '2rem 1.5rem' }}>
          <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '0.5rem' }}>
            Your Token Code
          </div>
          <div className="token-hero-code" style={{ marginBottom: '1.25rem' }}>
            {token.tokenCode || `#${token.tokenNumber}`}
          </div>

          {/* Position & Counter Grid */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))',
              gap: '0.75rem',
              background: 'rgba(8, 12, 22, 0.6)',
              borderRadius: '12px',
              padding: '1rem',
              border: '1px solid var(--border-subtle)',
              marginBottom: '1.25rem',
              textAlign: 'left',
            }}
          >
            <div>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '0.25rem' }}>
                Queue Position
              </div>
              <div style={{ fontSize: '1.2rem', fontWeight: '700', color: 'var(--color-cyan)' }}>
                {token.status === 'CALLED' || token.status === 'SERVING'
                  ? 'Your Turn'
                  : token.currentPosition !== undefined && token.currentPosition !== null
                    ? `#${token.currentPosition}`
                    : 'In Line'}
              </div>
            </div>

            <div>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '0.25rem' }}>
                People Ahead
              </div>
              <div style={{ fontSize: '1.2rem', fontWeight: '700', color: 'var(--color-primary)' }}>
                {token.status === 'CALLED' || token.status === 'SERVING'
                  ? '0'
                  : `${token.peopleAhead ?? Math.max(0, (token.currentPosition || 1) - 1)}`}
              </div>
            </div>

            <div>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '0.25rem' }}>
                Assigned Counter
              </div>
              <div style={{ fontSize: '1.1rem', fontWeight: '700', color: counterDisplay ? 'var(--color-primary)' : 'var(--text-secondary)' }}>
                {counterDisplay || 'Pending'}
              </div>
            </div>

            {token.servingToken && (
              <div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '0.25rem' }}>
                  Now Serving
                </div>
                <div style={{ fontSize: '1.1rem', fontWeight: '700', color: '#F59E0B' }}>
                  {token.servingToken.tokenCode}
                </div>
              </div>
            )}
          </div>

          {/* Active Counters & Est. Wait */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', fontSize: '0.85rem', color: 'var(--text-muted)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span>Issued: {token.createdAt ? new Date(token.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'Just now'}</span>
              {(token.estimatedWaitMinutes !== undefined || token.waitEstimateMinutes !== undefined) && (
                <span style={{ fontWeight: 600, color: 'var(--color-primary)' }}>
                  Est. Wait: ~{token.estimatedWaitMinutes ?? token.waitEstimateMinutes}m
                </span>
              )}
            </div>

            {token.activeCounters && token.activeCounters.length > 0 && (
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                <span>Active Counters:</span>
                <span style={{ color: 'var(--color-cyan)', fontWeight: 600 }}>
                  {token.activeCounters.map((c) => c.displayLabel || c.name || `Counter ${c.number}`).join(', ')}
                </span>
              </div>
            )}
          </div>
        </div>

        {/* Ticket Footer Actions */}
        <div className="ticket-footer" style={{ display: 'flex', gap: '0.75rem', justifyContent: 'space-between' }}>
          {isActive && (
            <button
              type="button"
              onClick={handleOpenQR}
              className="btn-secondary"
              style={{ flex: 1, fontSize: '0.85rem' }}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect x="3" y="3" width="7" height="7" />
                <rect x="14" y="3" width="7" height="7" />
                <rect x="14" y="14" width="7" height="7" />
                <rect x="3" y="14" width="7" height="7" />
              </svg>
              Check-in QR
            </button>
          )}

          {isCancellable && (
            <button
              type="button"
              onClick={() => setCancelConfirm(true)}
              className="btn-danger"
              style={{ flex: 1, fontSize: '0.85rem' }}
            >
              Cancel Token
            </button>
          )}
        </div>
      </article>

      {/* Cancel Confirmation Modal */}
      {cancelConfirm && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="cancel-dialog-title"
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(5, 7, 13, 0.85)',
            backdropFilter: 'blur(8px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '1rem',
            zIndex: 100,
          }}
        >
          <div className="qf-card" style={{ maxWidth: '400px', width: '100%', textAlign: 'center' }}>
            <h3 id="cancel-dialog-title" style={{ fontSize: '1.2rem', fontWeight: '800', marginBottom: '0.5rem', color: '#F87171' }}>
              Cancel Token?
            </h3>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginBottom: '1.5rem' }}>
              Are you sure you want to cancel token <strong>{token.tokenCode}</strong>? This action cannot be undone.
            </p>
            <div style={{ display: 'flex', gap: '0.75rem' }}>
              <button
                type="button"
                className="btn-secondary"
                style={{ flex: 1 }}
                onClick={() => setCancelConfirm(false)}
                disabled={cancelling}
              >
                Keep Token
              </button>
              <button
                type="button"
                className="btn-danger"
                style={{ flex: 1 }}
                onClick={handleCancel}
                disabled={cancelling}
              >
                {cancelling ? 'Cancelling...' : 'Yes, Cancel'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Staff Check-in QR Modal */}
      {showQRModal && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="qr-dialog-title"
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(5, 7, 13, 0.85)',
            backdropFilter: 'blur(8px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '1rem',
            zIndex: 100,
          }}
        >
          <div className="qf-card" style={{ maxWidth: '360px', width: '100%', textAlign: 'center' }}>
            <h3 id="qr-dialog-title" style={{ fontSize: '1.1rem', fontWeight: '700', marginBottom: '0.25rem' }}>
              Staff Verification QR
            </h3>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginBottom: '1.25rem' }}>
              Present this QR to counter staff or IoT kiosk
            </p>

            <div
              style={{
                background: '#FFFFFF',
                padding: '1.25rem',
                borderRadius: '16px',
                display: 'inline-block',
                marginBottom: '1.25rem',
                boxShadow: '0 0 20px rgba(0, 229, 168, 0.2)',
              }}
            >
              {qrLoading ? (
                <div style={{ width: '180px', height: '180px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#000000' }}>
                  Loading QR...
                </div>
              ) : qrError ? (
                <div style={{ width: '180px', height: '180px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#EF4444', fontSize: '0.8rem' }}>
                  {qrError}
                </div>
              ) : qrData ? (
                <img
                  src={qrData}
                  alt={`Verification QR for token ${token.tokenCode}`}
                  style={{ width: '180px', height: '180px', display: 'block' }}
                />
              ) : null}
            </div>

            <div style={{ fontSize: '0.9rem', fontWeight: '700', color: 'var(--text-main)', marginBottom: '1.25rem' }}>
              Token: {token.tokenCode}
            </div>

            <button
              type="button"
              className="btn-secondary"
              style={{ width: '100%' }}
              onClick={() => setShowQRModal(false)}
            >
              Close
            </button>
          </div>
        </div>
      )}
    </>
  );
}
