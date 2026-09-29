import React from 'react';
import { Users, Clock, CheckCircle2, Monitor } from 'lucide-react';

export default function StatPills({ queues = [], counters = [], avgWaitSeconds = null, metrics = null }) {
  // WAITING IN QUEUE — authoritative count of real customers holding a token
  // and still WAITING. Taken from the backend's Token-derived metrics. The old
  // source summed `queues[].waitingCount`, which is a day-partitioned Queue
  // aggregate and is legitimately empty while real customers are still waiting,
  // so the pill read 0 with a full lobby. The queue-table sum is kept only as
  // a fallback for a backend that has not yet exposed `metrics`.
  const totalWaiting = typeof metrics?.waitingCount === 'number'
    ? metrics.waitingCount
    : queues.reduce((sum, q) => sum + (q.waitingCount || 0), 0);

  // COMPLETED TODAY — tokens actually COMPLETED today, per the backend's
  // completion timestamp. `counters[].stats.served` is a lifetime counter per
  // counter, not a today figure, so it was never a valid "completed today".
  const totalServed = typeof metrics?.completedToday === 'number'
    ? metrics.completedToday
    : counters.reduce((sum, c) => sum + (c.stats?.served || 0), 0);

  const activeCounters = counters.filter((c) => c.status === 'ACTIVE').length;
  const totalCounters = counters.length;

  // Average WAIT time actually observed by customers who arrived today.
  // `avgWaitSeconds` is null until at least one of today's arrivals has really
  // been called, so show an honest dash rather than a fabricated number.
  let avgWaitFormatted = '—';
  if (typeof avgWaitSeconds === 'number' && avgWaitSeconds > 0) {
    avgWaitFormatted = `${Math.round(avgWaitSeconds / 60)}m`;
  }

  const kpis = [
    {
      label: 'WAITING IN QUEUE',
      value: totalWaiting,
      sub: typeof metrics?.waitingCount === 'number'
        ? `${metrics.waitingCount} holding a token`
        : 'Customers holding a token',
      icon: Users,
      color: totalWaiting > 10 ? 'var(--color-danger)' : totalWaiting > 5 ? 'var(--color-warning)' : 'var(--color-primary)',
    },
    {
      label: 'AVG WAIT TIME',
      value: avgWaitFormatted,
      sub: typeof metrics?.waitSampleCount === 'number' && metrics.waitSampleCount > 0
        ? `From ${metrics.waitSampleCount} real call${metrics.waitSampleCount === 1 ? '' : 's'} today`
        : 'No measured wait yet today',
      icon: Clock,
      color: 'var(--color-cyan)',
    },
    {
      label: 'COMPLETED TODAY',
      value: totalServed,
      sub: `${metrics?.issuedToday ?? '—'} issued today`,
      icon: CheckCircle2,
      color: 'var(--color-success)',
    },
    {
      label: 'ACTIVE COUNTERS',
      value: (
        <span>
          {activeCounters}
          <span className="stat-pill-fraction">/{totalCounters}</span>
        </span>
      ),
      sub: `${totalCounters - activeCounters} offline or on break`,
      icon: Monitor,
      color: activeCounters > 0 ? 'var(--color-primary)' : 'var(--text-secondary)',
    },
  ];

  return (
    <div className="stat-grid">
      {kpis.map((kpi, idx) => {
        const Icon = kpi.icon;
        return (
          <div key={idx} className="stat-pill">
            <div className="stat-pill-head">
              <span className="stat-pill-label">{kpi.label}</span>
              <span className="stat-pill-icon" style={{ color: kpi.color }}>
                <Icon size={15} />
              </span>
            </div>

            <div className="stat-pill-val">{kpi.value}</div>

            <div className="stat-pill-sub">{kpi.sub}</div>
          </div>
        );
      })}
    </div>
  );
}
