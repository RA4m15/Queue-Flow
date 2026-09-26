import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

export function LandingPage() {
  const { activeToken } = useAuth();

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
      {/* Active Token Notification Banner */}
      {activeToken && (
        <div
          className="qf-card"
          style={{
            border: '1px solid var(--border-accent)',
            background: 'linear-gradient(135deg, rgba(0, 229, 168, 0.12) 0%, rgba(0, 210, 255, 0.08) 100%)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '1rem',
            padding: '1rem 1.25rem',
          }}
        >
          <div>
            <div style={{ fontSize: '0.8rem', color: 'var(--color-primary)', fontWeight: '700', textTransform: 'uppercase' }}>
              Active Token
            </div>
            <div style={{ fontSize: '1.1rem', fontWeight: '800', color: 'var(--text-main)' }}>
              Ticket {activeToken.tokenCode}
            </div>
          </div>
          <Link to={`/token/${activeToken._id}`} className="btn-primary" style={{ padding: '0.5rem 1rem', fontSize: '0.85rem' }}>
            View Ticket
          </Link>
        </div>
      )}

      {/* Hero Section */}
      <section style={{ textAlign: 'center', padding: '2rem 0 1rem 0' }}>
        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '0.5rem',
            padding: '0.4rem 0.9rem',
            borderRadius: '9999px',
            background: 'var(--color-primary-subtle)',
            border: '1px solid var(--border-accent)',
            color: 'var(--color-primary)',
            fontSize: '0.8rem',
            fontWeight: '700',
            letterSpacing: '0.05em',
            textTransform: 'uppercase',
            marginBottom: '1.25rem',
          }}
        >
          <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: 'var(--color-primary)' }} />
          Zero-Install Mobile Queue
        </div>

        <h1
          style={{
            fontSize: '2.5rem',
            fontWeight: '800',
            lineHeight: 1.15,
            letterSpacing: '-0.03em',
            marginBottom: '1rem',
            background: 'linear-gradient(180deg, #FFFFFF 0%, #94A3B8 100%)',
            WebkitBackgroundClip: 'text',
            WebkitTextFillColor: 'transparent',
          }}
        >
          Join Queues Instantly.<br />
          <span style={{ color: 'var(--color-primary)', WebkitTextFillColor: 'var(--color-primary)' }}>
            No App Required.
          </span>
        </h1>

        <p
          style={{
            fontSize: '1.05rem',
            color: 'var(--text-secondary)',
            maxWidth: '520px',
            margin: '0 auto 2rem auto',
            lineHeight: 1.6,
          }}
        >
          Select a service center or scan a QR code at the counter to grab your digital ticket and track your queue position in real time.
        </p>

        {/* CTA Buttons */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '0.75rem',
            maxWidth: '360px',
            margin: '0 auto',
          }}
        >
          <Link to="/centers" className="btn-primary" style={{ width: '100%', padding: '1rem' }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="2" y="7" width="20" height="14" rx="2" ry="2" />
              <path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16" />
            </svg>
            Browse Service Centers
          </Link>

          <Link to="/join" className="btn-secondary" style={{ width: '100%', padding: '0.9rem' }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="3" y="3" width="7" height="7" />
              <rect x="14" y="3" width="7" height="7" />
              <rect x="14" y="14" width="7" height="7" />
              <rect x="3" y="14" width="7" height="7" />
            </svg>
            Scan or Enter QR Code
          </Link>
        </div>
      </section>

      {/* Feature Pillars */}
      <section style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '1rem' }}>
        <div className="qf-card">
          <div
            style={{
              width: '40px',
              height: '40px',
              borderRadius: '10px',
              background: 'var(--color-primary-subtle)',
              color: 'var(--color-primary)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              marginBottom: '0.75rem',
            }}
            aria-hidden="true"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
            </svg>
          </div>
          <h3 style={{ fontSize: '1.05rem', fontWeight: '700', marginBottom: '0.35rem' }}>
            Instant Zero-Install
          </h3>
          <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
            Works immediately in Safari, Chrome, Edge, and any modern mobile browser.
          </p>
        </div>

        <div className="qf-card">
          <div
            style={{
              width: '40px',
              height: '40px',
              borderRadius: '10px',
              background: 'var(--color-cyan-subtle)',
              color: 'var(--color-cyan)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              marginBottom: '0.75rem',
            }}
            aria-hidden="true"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
              <path d="M13.73 21a2 2 0 0 1-3.46 0" />
            </svg>
          </div>
          <h3 style={{ fontSize: '1.05rem', fontWeight: '700', marginBottom: '0.35rem' }}>
            Live Queue Alerts
          </h3>
          <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
            Real-time WebSocket updates let you know your exact spot and when your turn is called.
          </p>
        </div>

        <div className="qf-card">
          <div
            style={{
              width: '40px',
              height: '40px',
              borderRadius: '10px',
              background: 'rgba(168, 85, 247, 0.12)',
              color: '#C084FC',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              marginBottom: '0.75rem',
            }}
            aria-hidden="true"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
            </svg>
          </div>
          <h3 style={{ fontSize: '1.05rem', fontWeight: '700', marginBottom: '0.35rem' }}>
            Authoritative & Secure
          </h3>
          <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
            All queue positions and token sequences are generated and signed by the backend.
          </p>
        </div>
      </section>
    </div>
  );
}
