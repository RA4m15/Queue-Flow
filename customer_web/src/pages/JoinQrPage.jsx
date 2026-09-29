import { useState, useEffect, useCallback } from 'react';
import { useSearchParams, useNavigate, Link } from 'react-router-dom';
import { parseJoinUrl, isValidMongoId } from '../utils/qrUrlParser';
import { QrCameraScanner } from '../components/QrCameraScanner';
import { BackButton } from '../components/BackButton';

export function JoinQrPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  const [activeTab, setActiveTab] = useState('camera'); // 'camera' | 'manual'
  const [inputUrl, setInputUrl] = useState('');
  const [error, setError] = useState(null);

  // Check URL parameters on mount (inbound deep-links / canonical web QR redirects)
  useEffect(() => {
    const rawCenterId = searchParams.get('centerId') || searchParams.get('cid');
    const rawServiceId = searchParams.get('serviceId') || searchParams.get('sid');
    const rawUrl = searchParams.get('url');

    // If query parameters are present, process them immediately
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
        if (rawServiceId.trim().toLowerCase() === rawCenterId.trim().toLowerCase()) {
          setError('QR link contains mismatched service and center references');
          return;
        }
        navigate(`/queue/preview?centerId=${rawCenterId.trim()}&serviceId=${rawServiceId.trim()}`, { replace: true });
        return;
      }

      navigate(`/center/${rawCenterId.trim()}`, { replace: true });
      return;
    }

    // If query string has parameters but none identifies a center/url, report it
    if (searchParams.toString().length > 0) {
      setError('This join link does not identify a service center.');
    }
  }, [searchParams, navigate]);

  // Handler for camera scan success
  const handleScanSuccess = useCallback((rawText, parsed) => {
    setError(null);
    if (!parsed || !parsed.isValid) {
      setError('QR code not recognized');
      return;
    }

    if (parsed.centerId && parsed.serviceId) {
      navigate(`/queue/preview?centerId=${parsed.centerId}&serviceId=${parsed.serviceId}`);
    } else if (parsed.centerId) {
      navigate(`/center/${parsed.centerId}`);
    }
  }, [navigate]);

  // Handler for manual submit
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem', maxWidth: '480px', margin: '0 auto', width: '100%' }}>
      {/* Header and Back Button */}
      <div>
        <BackButton label="Back" fallback="/" />

        <h1 style={{ fontSize: '1.8rem', fontWeight: '800', marginBottom: '0.2rem' }}>
          Scan QR Code
        </h1>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
          Scan a QueueFlow counter QR code or enter your join details.
        </p>
      </div>

      {/* Mode Switcher Tabs */}
      <div
        role="tablist"
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          background: 'var(--bg-card)',
          padding: '4px',
          borderRadius: '10px',
          border: '1px solid var(--border-subtle)',
          gap: '4px',
        }}
      >
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'camera'}
          onClick={() => setActiveTab('camera')}
          className={activeTab === 'camera' ? 'btn-primary' : 'btn-secondary'}
          style={{
            padding: '0.6rem 0.5rem',
            fontSize: '0.85rem',
            borderRadius: '8px',
            border: activeTab === 'camera' ? 'none' : '1px solid transparent',
          }}
        >
          📷 Scan with Camera
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'manual'}
          onClick={() => setActiveTab('manual')}
          className={activeTab === 'manual' ? 'btn-primary' : 'btn-secondary'}
          style={{
            padding: '0.6rem 0.5rem',
            fontSize: '0.85rem',
            borderRadius: '8px',
            border: activeTab === 'manual' ? 'none' : '1px solid transparent',
          }}
        >
          ⌨️ Enter QR Code
        </button>
      </div>

      {/* Error Banner */}
      {error && (
        <div
          role="alert"
          style={{
            padding: '0.85rem 1rem',
            borderRadius: '12px',
            background: 'color-mix(in srgb, var(--color-danger, #ef4444) 12%, transparent)',
            border: '1px solid color-mix(in srgb, var(--color-danger, #ef4444) 35%, transparent)',
            color: 'var(--color-danger, #ef4444)',
            fontSize: '0.85rem',
          }}
        >
          <strong>QR Error:</strong> {error}
        </div>
      )}

      {/* Camera Scanner View */}
      {activeTab === 'camera' && (
        <div style={{ width: '100%' }}>
          <QrCameraScanner
            onScanSuccess={handleScanSuccess}
            onError={(msg) => {
              // Non-fatal error callback; display error or let user use manual fallback
            }}
          />

          <div style={{ textAlign: 'center', marginTop: '1rem' }}>
            <button
              type="button"
              onClick={() => setActiveTab('manual')}
              style={{
                background: 'transparent',
                border: 'none',
                color: 'var(--color-primary)',
                fontSize: '0.85rem',
                fontWeight: 600,
                cursor: 'pointer',
                textDecoration: 'underline',
              }}
            >
              Camera not working? Enter code manually
            </button>
          </div>
        </div>
      )}

      {/* Manual Input Fallback */}
      {activeTab === 'manual' && (
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
                placeholder="e.g. https://queueflow.app/join?centerId=..."
                value={inputUrl}
                onChange={(e) => setInputUrl(e.target.value)}
                required
              />
              <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                Paste the canonical <code>https://&lt;domain&gt;/join?centerId=…</code> URL or query parameters.
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
      )}

      {/* Browse Alternative */}
      <div style={{ textAlign: 'center', color: 'var(--text-secondary)', fontSize: '0.9rem', marginTop: '0.5rem' }}>
        <span>Don't have a QR code? </span>
        <Link to="/centers" style={{ color: 'var(--color-primary)', fontWeight: '700' }}>
          Browse Service Centers →
        </Link>
      </div>
    </div>
  );
}
