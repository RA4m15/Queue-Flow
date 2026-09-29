import { useGhostQueue } from '../hooks/useGhostQueue';

export function GhostQueueBadge({ token }) {
  const {
    geoStatus,
    proximityState,
    distanceMeters,
    lastUpdated,
    errorMessage,
    isUpdating,
    requestLocation,
  } = useGhostQueue(token);

  if (!token || !['WAITING', 'CALLED'].includes(token.status)) {
    return null;
  }

  // Resolve truthful display state
  let badgeLabel = 'Location permission required';
  let badgeColor = 'var(--text-muted)';
  let badgeBg = 'var(--bg-card-alt)';
  let icon = '📍';
  let description = 'Enable location to track your approach remotely.';

  if (geoStatus === 'DENIED') {
    badgeLabel = 'Location permission denied';
    badgeColor = 'var(--color-danger, var(--color-danger))';
    badgeBg = 'rgba(255, 77, 79, 0.15)';
    icon = '🚫';
    description = 'Please allow location access in your browser to evaluate proximity.';
  } else if (geoStatus === 'UNAVAILABLE' || proximityState === 'LOCATION_UNAVAILABLE') {
    badgeLabel = 'Location unavailable';
    badgeColor = 'var(--text-muted)';
    badgeBg = 'var(--bg-card-alt)';
    icon = '⚠️';
    description = 'Service center location is not configured for geofencing.';
  } else if (proximityState === 'INSIDE') {
    badgeLabel = 'Inside service area';
    badgeColor = 'var(--color-primary, var(--color-primary))';
    badgeBg = 'color-mix(in srgb, var(--color-primary) 15%, transparent)';
    icon = '✅';
    description = 'You are within the service center area. Please stay ready for your turn.';
  } else if (proximityState === 'NEAR') {
    badgeLabel = 'Near service center';
    badgeColor = 'var(--color-cyan)';
    badgeBg = 'color-mix(in srgb, var(--color-cyan) 15%, transparent)';
    icon = '🚶';
    description = 'You are in the immediate vicinity of the service center.';
  } else if (proximityState === 'APPROACHING') {
    badgeLabel = 'Approaching';
    badgeColor = 'var(--color-warning)';
    badgeBg = 'rgba(255, 184, 0, 0.15)';
    icon = '🚗';
    description = 'You are approaching the service center area.';
  } else if (proximityState === 'OUTSIDE') {
    badgeLabel = 'Outside service area';
    badgeColor = 'var(--text-secondary, var(--text-secondary))';
    badgeBg = 'color-mix(in srgb, var(--text-secondary) 10%, transparent)';
    icon = '🌐';
    description = 'Remote: You can remain outside without physically standing in line.';
  } else if (proximityState === 'STALE') {
    badgeLabel = 'Location stale';
    badgeColor = 'var(--color-warning)';
    badgeBg = 'color-mix(in srgb, var(--color-warning) 15%, transparent)';
    icon = '⏱️';
    description = 'Location has not updated recently. Please refresh your location.';
  }

  // Format coarse distance (never reveals exact GPS coordinates)
  let distanceText = null;
  if (distanceMeters !== null && distanceMeters !== undefined) {
    if (distanceMeters <= 500) {
      distanceText = 'Within 500m of center';
    } else if (distanceMeters < 1000) {
      distanceText = `~${distanceMeters}m from center`;
    } else {
      distanceText = `~${(distanceMeters / 1000).toFixed(1)} km from center`;
    }
  }

  return (
    <div
      className="ghost-queue-card"
      style={{
        marginTop: '1rem',
        padding: '0.875rem 1rem',
        borderRadius: '10px',
        background: 'color-mix(in srgb, var(--bg-card) 65%, transparent)',
        border: '1px solid var(--border-subtle, rgba(255, 255, 255, 0.1))',
        fontSize: '0.85rem',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.4rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <span style={{ fontSize: '1.1rem' }}>{icon}</span>
          <span
            style={{
              fontWeight: '700',
              padding: '0.2rem 0.5rem',
              borderRadius: '6px',
              fontSize: '0.75rem',
              letterSpacing: '0.04em',
              textTransform: 'uppercase',
              color: badgeColor,
              background: badgeBg,
            }}
          >
            {badgeLabel}
          </span>
        </div>

        <button
          type="button"
          onClick={requestLocation}
          disabled={isUpdating}
          className="btn-secondary"
          style={{
            padding: '0.25rem 0.6rem',
            fontSize: '0.75rem',
            borderRadius: '6px',
            cursor: isUpdating ? 'not-allowed' : 'pointer',
          }}
          title="Share current location to update proximity"
        >
          {isUpdating ? 'Updating…' : 'Share Location'}
        </button>
      </div>

      <div style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', lineHeight: '1.4' }}>
        {description}
      </div>

      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: '1rem',
          marginTop: '0.5rem',
          fontSize: '0.75rem',
          color: 'var(--text-muted)',
          borderTop: '1px solid var(--bg-card-alt)',
          paddingTop: '0.4rem',
        }}
      >
        {distanceText && (
          <span>
            Distance: <strong style={{ color: 'var(--text-main)' }}>{distanceText}</strong>
          </span>
        )}
        {lastUpdated && (
          <span>
            Last updated: <strong style={{ color: 'var(--text-main)' }}>{lastUpdated.toLocaleTimeString()}</strong>
          </span>
        )}
        {errorMessage && (
          <span style={{ color: 'var(--color-danger, var(--color-danger))' }}>{errorMessage}</span>
        )}
      </div>
    </div>
  );
}
