import React from 'react';

export default function LoadingSpinner({ message = 'Loading live telemetry...' }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '60px 24px', gap: '16px' }}>
      <div
        style={{
          width: '36px',
          height: '36px',
          border: '3px solid var(--bg-card-alt)',
          borderTopColor: 'var(--color-primary)',
          borderRadius: '50%',
          animation: 'qspin 0.85s linear infinite',
          boxShadow: '',
        }}
      />
      <p style={{ fontSize: '13px', color: 'var(--text-secondary)', fontWeight: 500, letterSpacing: '0.01em' }}>
        {message}
      </p>
      <style>{`
        @keyframes qspin {
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}
