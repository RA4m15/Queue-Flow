import { useState, useEffect } from 'react';
import { useSearchParams, useNavigate, Link } from 'react-router-dom';
import { parseJoinUrl, isValidMongoId } from '../utils/qrUrlParser';

export function JoinQrPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  const [inputUrl, setInputUrl] = useState('');
  const [error, setError] = useState(null);

  // Check URL parameters on mount
  useEffect(() => {
    const rawCenterId = searchParams.get('centerId') || searchParams.get('cid');
    const rawServiceId = searchParams.get('serviceId') || searchParams.get('sid');
    const rawUrl = searchParams.get('url');

    if (rawUrl) {
      const parsed = parseJoinUrl(rawUrl);
      if (parsed.isValid) {
        if (parsed.centerId && parsed.serviceId) {
          navigate(`/queue/preview?centerId=${parsed.centerId}&serviceId=${parsed.serviceId}`, { replace: true });
        } else if (parsed.centerId) {
          navigate(`/center/${parsed.centerId}`, { replace: true });
        }
        return;
      } else {
        setError(parsed.error);
        return;
      }
    }

    if (rawCenterId) {
      if (!isValidMongoId(rawCenterId)) {
        setError('Invalid Service Center ID format in QR link');
        return;
      }

      if (rawServiceId) {
        if (!isValidMongoId(rawServiceId)) {
          setError('Invalid Service ID format in QR link');
          return;
        }
        navigate(`/queue/preview?centerId=${rawCenterId.trim()}&serviceId=${rawServiceId.trim()}`, { replace: true });
        return;
      }

      navigate(`/center/${rawCenterId.trim()}`, { replace: true });
    }
  }, [searchParams, navigate]);

  const handleManualSubmit = (e) => {
    e.preventDefault();
    setError(null);

    const parsed = parseJoinUrl(inputUrl);
    if (!parsed.isValid) {
      setError(parsed.error || 'Invalid QueueFlow QR code or join URL');
      return;
    }

    if (parsed.centerId && parsed.serviceId) {
      navigate(`/queue/preview?centerId=${parsed.centerId}&serviceId=${parsed.serviceId}`);
    } else if (parsed.centerId) {
      navigate(`/center/${parsed.centerId}`);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
      <div>
        <Link
          to="/"
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
          Back to Home
        </Link>

        <h1 style={{ fontSize: '1.8rem', fontWeight: '800', marginBottom: '0.2rem' }}>
          Quick QR Join
        </h1>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
          Paste a QueueFlow QR join link or enter your center details.
        </p>
      </div>

      {error && (
        <div
          role="alert"
          style={{
            padding: '1rem',
            borderRadius: '12px',
            background: 'rgba(239, 68, 68, 0.12)',
            border: '1px solid rgba(239, 68, 68, 0.35)',
            color: '#F87171',
            fontSize: '0.9rem',
          }}
        >
          <strong>QR Error:</strong> {error}
        </div>
      )}

      <div className="qf-card">
        <form onSubmit={handleManualSubmit}>
          <div className="form-group">
            <label className="form-label" htmlFor="qr-input">
              QueueFlow QR or Join URL
            </label>
            <input
              id="qr-input"
              type="text"
              className="form-input"
              placeholder="e.g. queueflow://join?centerId=... or https://..."
              value={inputUrl}
              onChange={(e) => setInputUrl(e.target.value)}
              required
            />
            <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
              Supports both custom scheme (queueflow://join) and web links.
            </span>
          </div>

          <button
            type="submit"
            className="btn-primary"
            style={{ width: '100%', marginTop: '0.5rem' }}
          >
            Continue to Queue
          </button>
        </form>
      </div>

      <div style={{ textAlign: 'center', color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
        <span>Don't have a QR code? </span>
        <Link to="/centers" style={{ color: 'var(--color-primary)', fontWeight: '700' }}>
          Browse Service Centers →
        </Link>
      </div>
    </div>
  );
}
