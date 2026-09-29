import React, { useState, useEffect } from 'react';
import { CROWD_SENSOR_STALE_MS } from '../../services/crowdState';

/**
 * LIVE FOOTFALL - the Admin dashboard's read-only view of the authoritative crowd.
 *
 * Every number and status shown here is the backend's. The widget is strictly
 * read-only: it does not calculate occupancy, classify a level, or substitute
 * a fake value of its own. If the sensor is not reporting or stale, the card
 * displays a dash ("—") and marks the sensor OFFLINE.
 */
export default function CrowdWidget({ crowdData, isReadingStale }) {
  const [nowTick, setNowTick] = useState(() => Date.now());

  // Re-evaluate freshness on a short cadence so a sensor that stops reporting
  // is marked offline promptly, without polling the API. This only ages the
  // server's own verdict; it never changes a value.
  useEffect(() => {
    const id = setInterval(() => setNowTick(Date.now()), 5000);
    return () => clearInterval(id);
  }, []);

  const currentCrowd = crowdData?.currentCrowd;
  const hasReading = typeof currentCrowd === 'number';
  const capacity = typeof crowdData?.capacity === 'number' && crowdData.capacity > 0 ? crowdData.capacity : null;

  // The backend derived the percentage from the stored occupancy and capacity.
  // Fall back to the same staleness window it uses, so the card goes offline on
  // the same schedule the server would.
  const serverStale = typeof isReadingStale === 'function' ? isReadingStale(crowdData) : false;
  const stamp = crowdData?.crowdUpdatedAt ? new Date(crowdData.crowdUpdatedAt) : null;
  const agedOut = stamp && !Number.isNaN(stamp.getTime())
    ? nowTick - stamp.getTime() > CROWD_SENSOR_STALE_MS
    : false;
  const isStale = !hasReading || serverStale || agedOut;

  // No occupancy figure may be presented when the reading cannot be trusted, so
  // a stopped sensor shows the last known state as unavailable rather than as a
  // current value.
  const crowdPercent = !isStale && typeof crowdData?.crowdPercent === 'number'
    ? crowdData.crowdPercent
    : null;

  const rawStatus = (crowdData?.crowdStatus || '').toUpperCase();

  // Vocabulary matches the mobile app's CrowdIndicator and the lobby board, so
  // the control room, the TV and the phone describe one state identically.
  const statusLabel = rawStatus === 'HIGH' ? 'BUSY' : rawStatus === 'MODERATE' ? 'MODERATE' : 'QUIET';
  const tone = isStale
    ? 'var(--text-muted)'
    : rawStatus === 'HIGH'
      ? 'var(--color-danger)'
      : rawStatus === 'MODERATE'
        ? 'var(--color-warning)'
        : 'var(--color-success)';

  const lastUpdatedLabel = stamp && !Number.isNaN(stamp.getTime())
    ? stamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : null;

  return (
    <div className="q-card crowd-widget">
      {/* Headline: big number, small muted unit, status chip */}
      <div className="crowd-head">
        <div className="crowd-headline">
          <div className="crowd-title-row">
            {isStale ? (
              <span className="pulsing-dot" style={{ color: 'var(--text-muted)' }}>
                <span className="pulsing-dot-core" style={{ backgroundColor: 'var(--text-muted)' }} />
              </span>
            ) : (
              <span className="pulsing-dot" style={{ color: 'var(--color-cyan)' }}>
                <span className="pulsing-dot-ping" style={{ backgroundColor: 'var(--color-cyan)' }} />
                <span className="pulsing-dot-core" style={{ backgroundColor: 'var(--color-cyan)' }} />
              </span>
            )}
            <span className="eyebrow">LIVE FOOTFALL</span>
          </div>

          {isStale ? (
            <div className="crowd-figure">
              <span className="crowd-count" style={{ color: 'var(--text-muted)' }}>&mdash;</span>
            </div>
          ) : (
            <div className="crowd-figure">
              <span className="crowd-count">{currentCrowd}</span>
              {capacity !== null && <span className="crowd-capacity">/ {capacity} inside</span>}
            </div>
          )}
        </div>

        <span
          className="crowd-status-chip"
          style={{
            color: tone,
            background: `color-mix(in srgb, ${tone} 12%, transparent)`,
            borderColor: `color-mix(in srgb, ${tone} 30%, transparent)`,
          }}
        >
          <span className="crowd-status-dot" style={{ background: tone }} />
          <span>{isStale ? 'OFFLINE' : 'ONLINE'}</span>
          {!isStale && <span className="crowd-status-sub">&middot; {statusLabel}</span>}
        </span>
      </div>

      {/* Occupancy gauge — only ever rendered from a trusted reading */}
      {!isStale && crowdPercent !== null && capacity !== null ? (
        <div className="crowd-gauge">
          <div className="crowd-track">
            <div
              className="crowd-fill"
              style={{ width: `${Math.min(100, crowdPercent)}%`, background: tone }}
            />
          </div>
          <p className="crowd-caption">
            <span className="mono">{crowdPercent}%</span> of capacity
            <span className="crowd-caption-sep">&middot;</span>
            <span className="mono">{rawStatus || 'LOW'}</span>
            <span className="crowd-caption-sep">&middot;</span>
            limit {capacity}
          </p>
        </div>
      ) : !isStale && capacity === null ? (
        <p className="crowd-caption">Facility capacity not configured &mdash; occupancy unavailable.</p>
      ) : null}

      {/* Freshness: the backend's stamp, so an operator can judge the reading */}
      <p className="crowd-caption" style={{ marginTop: '8px' }}>
        {isStale
          ? 'Last reading is no longer being reported.'
          : `Last updated: ${lastUpdatedLabel ?? 'just now'}`}
      </p>
    </div>
  );
}
