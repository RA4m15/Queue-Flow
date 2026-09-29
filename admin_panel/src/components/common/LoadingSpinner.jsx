import React from 'react';

export default function LoadingSpinner({ message = 'Loading live telemetry...' }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '60px 24px', gap: '16px' }}>
      <div
        style={{
          width: '36px',
          height: '36px',
          border: '3px solid rgba(255, 255, 255, 0.08)',
          borderTopColor: '#00E5A8',
          borderRadius: '50%',
          animation: 'qspin 0.85s linear infinite',
          boxShadow: '0 0 20px rgba(0, 229, 168, 0.25)',
        }}
      />
      <p style={{ fontSize: '13px', color: '#94A3B8', fontWeight: 500, letterSpacing: '0.01em' }}>
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
