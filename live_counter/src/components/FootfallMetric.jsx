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

  // Crowd vocabulary matches the mobile app's CrowdIndicator so the TV board,
  // the customer web and the phone all describe the same state identically.
  const getStatusBadge = () => {
    if (!isAvailable) {
      return (
        <span
          className="footfall-badge"
          style={{ background: 'var(--bg-card-alt)', color: 'var(--text-muted)', border: '1px solid var(--border-light)' }}
        >
          SENSOR OFFLINE
        </span>
      );
    }
    const status = (crowdStatus || 'LOW').toUpperCase();
    if (status === 'HIGH' || status === 'CRITICAL') {
      return <span className="footfall-badge high">BUSY</span>;
    }
    if (status === 'MODERATE') {
      return <span className="footfall-badge moderate">MODERATE</span>;
    }
    return <span className="footfall-badge low">QUIET</span>;
  };

  return (
    <div className="display-card metric-box" data-testid="metric-footfall">
      <div className="metric-label">
        <span>LIVE FOOTFALL</span>
        {getStatusBadge()}
      </div>

      <div className="metric-value">
        {isAvailable ? (
          <>
            {footfall}
            {capacity ? <span className="metric-value-unit"> / {capacity}</span> : null}
          </>
        ) : (
          <span className="metric-value-empty">Unavailable</span>
        )}
      </div>

      <div className="metric-sub">
        {isAvailable ? (
          // Occupancy percentage is the backend's own derivation from the stored
          // count and capacity. It is never recomputed here, so this board and the
          // Admin dashboard cannot disagree about the same center.
          typeof crowdPercent === 'number'
            ? `${crowdPercent}% of capacity`
            : 'Real-time CCTV track'
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
