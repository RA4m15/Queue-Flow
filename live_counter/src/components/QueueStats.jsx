export function QueueStats({ queues = [], counters = [], metrics = null, center = null }) {
  // "JOINED QUEUES" is the authoritative count of real customers holding a
  // token and still WAITING. It must come from the backend's Token-derived
  // metrics, NOT from summing `queues[].waitingCount`: `queues` is partitioned
  // by calendar day and is legitimately empty while real customers are still
  // standing in line, which previously rendered this tile as 0.
  const joinedQueues = typeof metrics?.waitingCount === 'number'
    ? metrics.waitingCount
    : null;

  const activeCounters = counters.filter((c) => c.status === 'ACTIVE').length;
  const totalCounters = counters.length;

  // Longest context-aware estimate across today's queues. Only rendered when
  // the backend actually produced an estimate - never a hardcoded 0.
  const ewtValues = queues
    .map((q) => q.estimatedWaitMinutes)
    .filter((v) => typeof v === 'number');
  const ewtMinutes = ewtValues.length > 0 ? Math.max(...ewtValues) : null;

  // Queue status is the backend's own word, never inferred here. The center's
  // open/closed flag is the headline; the per-queue states are listed beneath
  // it so an operator can see which line is paused. When the backend did not
  // send a status, the tile says so rather than assuming "open".
  const knownQueueStates = queues
    .map((q) => q.status)
    .filter((s) => typeof s === 'string' && s.length > 0);
  const uniqueQueueStates = Array.from(new Set(knownQueueStates));

  const centerOpen = typeof center?.isOpen === 'boolean' ? center.isOpen : null;

  let queueStatusLabel;
  let queueStatusSub;
  if (centerOpen === false) {
    queueStatusLabel = 'CENTER CLOSED';
    queueStatusSub = 'Not accepting customers';
  } else if (centerOpen === true) {
    queueStatusLabel = 'OPEN';
    queueStatusSub = uniqueQueueStates.length > 0 ? uniqueQueueStates.join(' / ') : 'Center accepting customers';
  } else {
    queueStatusLabel = null;
    queueStatusSub = 'No status reported';
  }

  return (
    <>
      <div className="display-card metric-box" data-testid="metric-joined-queues">
        <div className="metric-label">
          <span>JOINED QUEUES</span>
          <span>👥</span>
        </div>
        <div className="metric-value">
          {joinedQueues === null ? (
            <span className="metric-value-empty">Unavailable</span>
          ) : (
            joinedQueues
          )}
        </div>
        <div className="metric-sub">
          {typeof metrics?.servingCount === 'number' && metrics.servingCount > 0
            ? `${metrics.servingCount} now being served`
            : 'Customers holding a token'}
        </div>
      </div>

      <div className="display-card metric-box" data-testid="metric-active-counters">
        <div className="metric-label">
          <span>ACTIVE STATIONS</span>
          <span>⚡</span>
        </div>
        <div className="metric-value">
          {activeCounters}
          <span className="metric-value-unit"> / {totalCounters}</span>
        </div>
        <div className="metric-sub">
          {totalCounters - activeCounters} offline or on break
        </div>
      </div>

      <div className="display-card metric-box" data-testid="metric-ewt">
        <div className="metric-label">
          <span>ESTIMATED WAIT</span>
          <span>⏱️</span>
        </div>
        <div className="metric-value">
          {ewtMinutes === null ? (
            <span className="metric-value-empty">—</span>
          ) : (
            <>
              ~{ewtMinutes}
              <span className="metric-value-unit"> min</span>
            </>
          )}
        </div>
        <div className="metric-sub">
          {ewtMinutes === null
            ? 'No active queue forecast'
            : 'Context-aware queue forecast'}
        </div>
      </div>

      <div className="display-card metric-box" data-testid="metric-queue-status">
        <div className="metric-label">
          <span>QUEUE STATUS</span>
          <span>🟢</span>
        </div>
        <div className="metric-value">
          {queueStatusLabel === null ? (
            <span className="metric-value-empty">Unavailable</span>
          ) : (
            queueStatusLabel
          )}
        </div>
        <div className="metric-sub">{queueStatusSub}</div>
      </div>
    </>
  );
}
