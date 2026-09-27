export function OfflineBanner({ isOnline = true, cachedAt = null, hasData = true, isRefreshing = false }) {
  if (isOnline && !isRefreshing) return null;

  if (isOnline && isRefreshing) {
    return (
      <aside 
        className="offline-banner" 
        role="status" 
        aria-live="polite"
        style={{
          background: 'rgba(56, 189, 248, 0.15)',
          borderColor: 'rgba(56, 189, 248, 0.35)',
          color: '#38BDF8',
        }}
      >
        <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#38BDF8', display: 'inline-block' }} />
        <span>Refreshing live status...</span>
      </aside>
    );
  }

  const formattedTime = cachedAt 
    ? new Date(cachedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : null;

  return (
    <aside className="offline-banner" role="alert" aria-live="assertive">
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        style={{ flexShrink: 0 }}
      >
        <line x1="1" y1="1" x2="23" y2="23" />
        <path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55" />
        <path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39" />
        <path d="M10.71 5.05A16 16 0 0 1 22.58 9" />
        <path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88" />
        <path d="M8.53 16.11a6 6 0 0 1 6.95 0" />
        <line x1="12" y1="20" x2="12.01" y2="20" />
      </svg>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.15rem' }}>
        {hasData ? (
          <>
            <span style={{ fontWeight: 600 }}>
              You are offline — showing last known queue status
            </span>

            {formattedTime && (
              <span style={{ fontSize: '0.8rem', opacity: 0.9 }}>
                Last updated: {formattedTime}
              </span>
            )}
          </>
        ) : (
          <>
            <span style={{ fontWeight: 600 }}>
              You're offline
            </span>
            <span style={{ fontSize: '0.8rem', opacity: 0.9 }}>
              No current queue data is available. Actions require an active connection.
            </span>
          </>
        )}
      </div>
    </aside>
  );
}

