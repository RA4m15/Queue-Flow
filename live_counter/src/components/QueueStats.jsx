export function QueueStats({ queues = [], counters = [] }) {
  const totalWaiting = queues.reduce((sum, q) => sum + (q.waitingCount || 0), 0);
  const activeCounters = counters.filter((c) => c.status === 'ACTIVE').length;
  const totalCounters = counters.length;

  // Compute average or maximum estimated wait time across open queues
  const ewtMinutes = queues.length > 0
    ? Math.max(...queues.map((q) => q.estimatedWaitMinutes || 0))
    : 0;

  return (
    <>
      <div className="display-card metric-box" data-testid="metric-joined-queues">
        <div className="metric-label">
          <span>JOINED QUEUES</span>
          <span>👥</span>
        </div>
        <div className="metric-value">
          {totalWaiting}
        </div>
        <div className="metric-sub">
          {queues.length} {queues.length === 1 ? 'service queue' : 'services operating'}
        </div>
      </div>

      <div className="display-card metric-box" data-testid="metric-active-counters">
        <div className="metric-label">
          <span>ACTIVE STATIONS</span>
          <span>⚡</span>
        </div>
        <div className="metric-value">
          {activeCounters}
          <span style={{ fontSize: '1rem', color: 'var(--text-muted)', fontWeight: 600 }}> / {totalCounters}</span>
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
          ~{ewtMinutes}
          <span style={{ fontSize: '1rem', color: 'var(--color-primary)', fontWeight: 700 }}> min</span>
        </div>
        <div className="metric-sub">
          Context-aware queue forecast
        </div>
      </div>
    </>
  );
}
