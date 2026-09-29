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
          color: 'var(--color-danger)',
          background: 'color-mix(in srgb, var(--color-danger) 10%, transparent)',
          padding: '0.2rem 0.6rem',
          borderRadius: '9999px',
          border: '1px solid color-mix(in srgb, var(--color-danger) 25%, transparent)',
        }}
        role="status"
        aria-live="polite"
        title={title}
      >
        <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: 'var(--color-danger)' }} />
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
          color: 'var(--color-warning)',
          background: 'color-mix(in srgb, var(--color-warning) 10%, transparent)',
          padding: '0.2rem 0.6rem',
          borderRadius: '9999px',
          border: '1px solid color-mix(in srgb, var(--color-warning) 25%, transparent)',
        }}
        role="status"
        aria-live="polite"
      >
        <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: 'var(--color-warning)' }} />
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
          color: 'var(--color-cyan)',
          background: 'rgba(56, 189, 248, 0.1)',
          padding: '0.2rem 0.6rem',
          borderRadius: '9999px',
          border: '1px solid rgba(56, 189, 248, 0.25)',
        }}
        role="status"
        aria-live="polite"
      >
        <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: 'var(--color-cyan)' }} />
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
        color: 'var(--color-primary)',
        background: 'color-mix(in srgb, var(--color-primary) 10%, transparent)',
        padding: '0.2rem 0.6rem',
        borderRadius: '9999px',
        border: '1px solid color-mix(in srgb, var(--color-primary) 25%, transparent)',
      }}
      role="status"
      aria-live="polite"
    >
      <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: 'var(--color-primary)' }} />
      Live
    </div>
  );
}

