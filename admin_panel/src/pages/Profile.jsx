import React from 'react';
import { useAuth } from '../context/AuthContext';
import ThemeSetting from '../components/ThemeSetting';
import { User, Shield, Mail, LogOut } from 'lucide-react';

function DetailRow({ icon: Icon, label, value }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '16px',
        padding: '12px 0',
        borderBottom: '1px solid var(--border-subtle)',
      }}
    >
      <span
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '9px',
          fontSize: '13px',
          color: 'var(--text-muted)',
        }}
      >
        <Icon size={15} />
        {label}
      </span>
      <span
        style={{
          fontSize: '13px',
          fontWeight: 600,
          color: 'var(--text-primary)',
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
 * Admin Panel — Profile.
 *
 * A dedicated settings page rather than a control on the dashboard: appearance
 * is a personal preference, and the live operations dashboard must stay exactly
 * as dense and glanceable as it is today.
 *
 * This page is read-only by design. It reports the session the backend already
 * authenticated and changes nothing about it.
 */
export default function Profile() {
  const { user } = useAuth();

  return (
    <div style={{ padding: '24px 28px', maxWidth: '760px', margin: '0 auto' }}>
      {/* Header */}
      <div style={{ marginBottom: '24px' }}>
        <h1
          style={{
            fontSize: '22px',
            fontWeight: 800,
            color: 'var(--text-primary)',
            letterSpacing: '-0.02em',
          }}
        >
          Profile
        </h1>
        <p style={{ fontSize: '13px', color: 'var(--text-secondary)', marginTop: '3px' }}>
          Your operator account and how this console looks
        </p>
      </div>

      {/* Account */}
      <section className="q-card" style={{ padding: '20px 22px', marginBottom: '18px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '14px', marginBottom: '16px' }}>
          <div
            style={{
              width: '46px',
              height: '46px',
              borderRadius: '13px',
              background: 'var(--bg-card-alt)',
              border: '1px solid var(--border-subtle)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--color-primary)',
              fontWeight: 800,
              fontSize: '18px',
              flexShrink: 0,
            }}
            aria-hidden="true"
          >
            {user?.name ? user.name[0].toUpperCase() : <User size={20} />}
          </div>
          <div style={{ minWidth: 0 }}>
            <div
              style={{
                fontSize: '16px',
                fontWeight: 700,
                color: 'var(--text-primary)',
                lineHeight: 1.25,
                wordBreak: 'break-word',
              }}
            >
              {user?.name || '—'}
            </div>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '5px',
                fontSize: '11px',
                color: 'var(--text-muted)',
                marginTop: '2px',
              }}
            >
              <Shield size={11} color="var(--color-primary)" />
              <span className="mono" style={{ fontWeight: 700 }}>
                {user?.role || 'STAFF'}
              </span>
            </div>
          </div>
        </div>

        <DetailRow icon={Mail} label="Email" value={user?.email} />
      </section>

      {/* Theme */}
      <section className="q-card" style={{ padding: '20px 22px' }}>
        <p className="eyebrow" style={{ marginBottom: '4px' }}>
          Theme
        </p>
        <p
          style={{
            fontSize: '13px',
            color: 'var(--text-secondary)',
            marginBottom: '16px',
            lineHeight: 1.5,
          }}
        >
          Choose how this console looks. Your choice is saved on this device and
          applied across the whole Admin Panel.
        </p>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '20px',
            flexWrap: 'wrap',
          }}
        >
          <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)' }}>
            Appearance
          </span>
          <ThemeSetting />
        </div>
      </section>
    </div>
  );
}
