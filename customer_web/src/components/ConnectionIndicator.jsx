export function ConnectionIndicator({ status = 'connected', isOnline = true }) {
  if (!isOnline) {
    return (
      <div 
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '0.4rem',
          fontSize: '0.75rem',
          color: '#F87171',
          background: 'rgba(239, 68, 68, 0.1)',
          padding: '0.2rem 0.6rem',
          borderRadius: '9999px',
          border: '1px solid rgba(239, 68, 68, 0.25)',
        }}
        role="status"
        aria-live="polite"
      >
        <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#EF4444' }} />
        Offline
      </div>
    );
  }

  if (status === 'reconnecting') {
    return (
      <div 
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '0.4rem',
          fontSize: '0.75rem',
          color: '#FBBF24',
          background: 'rgba(245, 158, 11, 0.1)',
          padding: '0.2rem 0.6rem',
          borderRadius: '9999px',
          border: '1px solid rgba(245, 158, 11, 0.25)',
        }}
        role="status"
        aria-live="polite"
      >
        <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#F59E0B' }} />
        Reconnecting...
      </div>
    );
  }

  return (
    <div 
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '0.4rem',
        fontSize: '0.75rem',
        color: '#00E5A8',
        background: 'rgba(0, 229, 168, 0.1)',
        padding: '0.2rem 0.6rem',
        borderRadius: '9999px',
        border: '1px solid rgba(0, 229, 168, 0.25)',
      }}
      role="status"
      aria-live="polite"
    >
      <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#00E5A8' }} />
      Live
    </div>
  );
}
