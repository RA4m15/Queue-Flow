export function FootfallMetric({
  footfall,
  capacity,
  crowdStatus,
  crowdPercent,
  lastFootfallUpdate,
  isSensorStale,
}) {
  const isAvailable = typeof footfall === 'number' && !isSensorStale;

  const ageSeconds = lastFootfallUpdate
    ? Math.max(0, Math.round((Date.now() - lastFootfallUpdate.getTime()) / 1000))
    : null;

  const getStatusBadge = () => {
    if (!isAvailable) {
      return <span className="footfall-badge" style={{ background: 'rgba(255,255,255,0.1)', color: 'var(--text-muted)' }}>SENSOR OFFLINE</span>;
    }
    const status = (crowdStatus || 'LOW').toUpperCase();
    if (status === 'HIGH') {
      return <span className="footfall-badge high">HIGH CROWD</span>;
    }
    if (status === 'MODERATE') {
      return <span className="footfall-badge moderate">MODERATE</span>;
    }
    return <span className="footfall-badge low">OPTIMAL</span>;
  };

  return (
    <div className="display-card metric-box" data-testid="metric-footfall">
      <div className="metric-label">
        <span>LIVE FOOTFALL</span>
        {getStatusBadge()}
      </div>

      <div className="metric-value">
        {isAvailable ? footfall : (
          <span style={{ fontSize: '1.2rem', color: 'var(--text-muted)' }}>Unavailable</span>
        )}
      </div>

      <div className="metric-sub">
        {isAvailable ? (
          capacity ? `${crowdPercent ?? Math.round((footfall / capacity) * 100)}% of ${capacity} capacity` : 'Real-time CCTV track'
        ) : (
          lastFootfallUpdate
            ? `Last updated ${Math.round((Date.now() - lastFootfallUpdate.getTime()) / 1000)}s ago`
            : 'No active crowd sensor'
        )}
      </div>

      {isAvailable && ageSeconds !== null && (
        <div className="metric-footfall-freshness" data-testid="footfall-freshness">
          Last updated: {lastFootfallUpdate.toLocaleTimeString()}
        </div>
      )}
    </div>
  );
}
