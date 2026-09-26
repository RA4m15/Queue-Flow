import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { ConnectionIndicator } from './ConnectionIndicator';
import { NotificationBell } from './NotificationBell';
import { useNetworkStatus } from '../hooks/useNetworkStatus';

export function Navbar() {
  const { user, isAuthenticated, logout, activeToken } = useAuth();
  const { isOnline } = useNetworkStatus();
  const navigate = useNavigate();

  return (
    <header
      style={{
        background: 'rgba(8, 12, 22, 0.85)',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
        borderBottom: '1px solid var(--border-subtle)',
        position: 'sticky',
        top: 0,
        zIndex: 50,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0.85rem 1rem',
          maxWidth: '768px',
          margin: '0 auto',
        }}
      >
        {/* Brand */}
        <Link
          to="/"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.6rem',
            textDecoration: 'none',
          }}
          aria-label="QueueFlow Home"
        >
          <div
            style={{
              width: '32px',
              height: '32px',
              borderRadius: '8px',
              background: 'var(--color-primary-gradient)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: '0 0 12px rgba(0, 229, 168, 0.4)',
            }}
            aria-hidden="true"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#05070D" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <polyline points="12 6 12 12 16 14" />
            </svg>
          </div>
          <span style={{ fontSize: '1.2rem', fontWeight: '800', letterSpacing: '-0.02em', color: 'var(--text-main)' }}>
            Queue<span style={{ color: 'var(--color-primary)' }}>Flow</span>
          </span>
        </Link>

        {/* Right Nav */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <Link
            to="/display"
            style={{
              fontSize: '0.8rem',
              fontWeight: '600',
              color: 'var(--text-secondary)',
              textDecoration: 'none',
              padding: '0.3rem 0.5rem',
              borderRadius: '6px',
              border: '1px solid var(--border-subtle)',
              display: 'flex',
              alignItems: 'center',
              gap: '0.35rem'
            }}
            title="Open Live TV Display screen"
          >
            <span style={{ fontSize: '0.9rem' }}>📺</span> TV Display
          </Link>
          <ConnectionIndicator isOnline={isOnline} />
          <NotificationBell />

          {activeToken && (
            <Link
              to={`/token/${activeToken._id}`}
              className="badge badge-called"
              style={{ textDecoration: 'none', padding: '0.35rem 0.65rem' }}
              title="View your active token"
            >
              Ticket {activeToken.tokenCode}
            </Link>
          )}

          {isAuthenticated ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <Link
                to="/my-tokens"
                style={{
                  fontSize: '0.85rem',
                  fontWeight: '600',
                  color: 'var(--text-secondary)',
                  padding: '0.4rem 0.6rem',
                }}
              >
                My Tokens
              </Link>
              <button
                type="button"
                onClick={async () => {
                  await logout();
                  navigate('/');
                }}
                className="btn-secondary"
                style={{
                  padding: '0.35rem 0.75rem',
                  fontSize: '0.8rem',
                  borderRadius: '8px',
                }}
                title={`Signed in as ${user?.name || user?.email}`}
              >
                Sign Out
              </button>
            </div>
          ) : (
            <Link
              to="/login"
              className="btn-secondary"
              style={{
                padding: '0.35rem 0.85rem',
                fontSize: '0.85rem',
                borderRadius: '8px',
              }}
            >
              Sign In
            </Link>
          )}
        </div>
      </div>
    </header>
  );
}
