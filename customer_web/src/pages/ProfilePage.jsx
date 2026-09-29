import { Link, Navigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { ThemeSetting } from '../components/ThemeSetting';
import { BackButton } from '../components/BackButton';

function DetailRow({ label, value }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '12px',
        padding: '11px 0',
        borderBottom: '1px solid var(--border-subtle)',
      }}
    >
      <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>{label}</span>
      <span
        style={{
          fontSize: '0.9rem',
          fontWeight: 600,
          color: 'var(--text-main)',
          textAlign: 'right',
          wordBreak: 'break-word',
        }}
      >
        {value || '—'}
      </span>
    </div>
  );
}

/**
 * Customer Web — Profile.
 *
 * Holds the personal settings a customer can change without an operator: today
 * just appearance. The account details are read-only and come straight from the
 * session `AuthContext` already holds, so nothing here re-fetches, re-validates
 * or can log anyone out.
 */
export function ProfilePage() {
  const { user, isAuthenticated, loading } = useAuth();

  // Nothing to personalise while signed out — send them to sign in, not to a
  // half-populated page.
  if (!loading && !isAuthenticated) {
    return <Navigate to="/login?returnTo=/profile" replace />;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      <div>
        <BackButton label="Back" fallback="/" />
        <h1 style={{ fontSize: '1.6rem', fontWeight: '800', marginBottom: '0.2rem' }}>
          Profile
        </h1>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
          Your account and how QueueFlow looks for you.
        </p>
      </div>

      {/* Account */}
      <section className="qf-card">
        <p className="section-label" style={{ marginBottom: '10px' }}>
          Account
        </p>
        <DetailRow label="Name" value={user?.name} />
        <DetailRow label="Email" value={user?.email} />
        <DetailRow label="Phone" value={user?.phone} />
      </section>

      {/* Theme */}
      <section className="qf-card">
        <p className="section-label" style={{ marginBottom: '6px' }}>
          Theme
        </p>
        <p
          style={{
            color: 'var(--text-secondary)',
            fontSize: '0.88rem',
            lineHeight: 1.5,
            marginBottom: '16px',
          }}
        >
          Choose a dark or light look. Your choice is saved on this device and
          applied across QueueFlow.
        </p>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '16px',
            flexWrap: 'wrap',
          }}
        >
          <span style={{ fontSize: '0.95rem', fontWeight: '600', color: 'var(--text-main)' }}>
            Appearance
          </span>
          <ThemeSetting />
        </div>
      </section>

      <div style={{ textAlign: 'center', paddingTop: '0.25rem' }}>
        <Link
          to="/my-tokens"
          className="btn-secondary"
          style={{ minHeight: 'auto', padding: '0.55rem 1rem', fontSize: '0.85rem' }}
        >
          View my tokens
        </Link>
      </div>
    </div>
  );
}
