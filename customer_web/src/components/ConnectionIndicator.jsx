export function ConnectionIndicator({ 
  status = 'connected', 
  isOnline = true, 
  connectionState = null, 
  isCached = false,
  cachedAt = null 
}) {
  // Determine effective state
  const effectiveState = connectionState || (
    !isOnline ? 'OFFLINE' :
    status === 'reconnecting' ? 'RECONNECTING' :
    isCached ? 'STALE' : 'LIVE'
  );

  if (!isOnline || effectiveState === 'OFFLINE_NO_CACHE' || effectiveState === 'OFFLINE_LAST_KNOWN' || effectiveState === 'OFFLINE') {
    const title = cachedAt ? `Offline. Showing state from ${new Date(cachedAt).toLocaleTimeString()}` : 'Offline. No connection.';
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
        title={title}
      >
        <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#EF4444' }} />
        Offline
      </div>
    );
  }

  if (effectiveState === 'ONLINE_RECONNECTING' || effectiveState === 'RECONNECTING' || status === 'reconnecting') {
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

  if (effectiveState === 'ONLINE_STALE' || effectiveState === 'STALE') {
    return (
      <div 
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '0.4rem',
          fontSize: '0.75rem',
          color: '#38BDF8',
          background: 'rgba(56, 189, 248, 0.1)',
          padding: '0.2rem 0.6rem',
          borderRadius: '9999px',
          border: '1px solid rgba(56, 189, 248, 0.25)',
        }}
        role="status"
        aria-live="polite"
      >
        <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#38BDF8' }} />
        Refreshing live status...
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

