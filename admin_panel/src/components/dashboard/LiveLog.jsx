import React from 'react';

/**
 * Compact, scannable activity feed.
 *
 * Each row is: time (mono, muted) + a small status chip + the event text.
 * Chips are deliberately small — the feed should read as a log, not as a set
 * of large colourful blocks. Semantics:
 *
 *   DONE    green     completed
 *   SERVING green     in service
 *   CALLED  cyan      called to a counter
 *   WAITING yellow    joined the queue
 *   BREAK   grey      counter state change
 *   SKIP    red       skipped / cancelled
 */
const TAG_TONE = {
  done: 'success',
  serving: 'success',
  called: 'info',
  waiting: 'warn',
  skip: 'danger',
  break: 'neutral',
  info: 'neutral',
};

export default function LiveLog({ log = [] }) {
  return (
    <section className="log-panel">
      <header className="log-head">
        <span className="eyebrow">Live activity stream</span>
        <span className="log-realtime">
          <span className="pulsing-dot" style={{ color: 'var(--color-primary)' }}>
            <span className="pulsing-dot-ping" style={{ backgroundColor: 'var(--color-primary)' }} />
            <span className="pulsing-dot-core" style={{ backgroundColor: 'var(--color-primary)' }} />
          </span>
          Realtime
        </span>
      </header>

      <div className="q-card log-list">
        {log.length === 0 ? (
          <p className="log-empty">No recent queue activity recorded yet.</p>
        ) : (
          log.map((item, i) => (
            <div key={item.id || i} className="log-row">
              <span className="log-time mono">{item.t}</span>
              <span className={`log-chip tone-${TAG_TONE[item.tag] || 'neutral'}`}>
                {(item.tag || 'info').toUpperCase()}
              </span>
              <span className="log-text">{item.event}</span>
            </div>
          ))
        )}
      </div>
    </section>
  );
}
