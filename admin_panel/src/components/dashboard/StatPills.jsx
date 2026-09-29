import React from 'react';
import { Users, Clock, CheckCircle2, Monitor } from 'lucide-react';

export default function StatPills({ queues = [], counters = [], avgWaitSeconds = null }) {
  const totalWaiting = queues.reduce((sum, q) => sum + (q.waitingCount || 0), 0);
  const totalServed = counters.reduce((sum, c) => sum + (c.stats?.served || 0), 0);
  const activeCounters = counters.filter((c) => c.status === 'ACTIVE').length;
  const totalCounters = counters.length;

  // Format real backend-derived average waiting time
  let avgWaitFormatted = '—';
  if (typeof avgWaitSeconds === 'number' && avgWaitSeconds > 0) {
    avgWaitFormatted = `${Math.round(avgWaitSeconds / 60)}m`;
  }

  const kpis = [
    {
      label: 'WAITING IN QUEUE',
      value: totalWaiting,
      icon: Users,
      color: totalWaiting > 10 ? '#EF4444' : totalWaiting > 5 ? '#F59E0B' : '#00E5A8',
      accentGlow: 'rgba(0, 229, 168, 0.15)',
    },
    {
      label: 'AVG WAIT TIME',
      value: avgWaitFormatted,
      icon: Clock,
      color: '#00D2FF',
      accentGlow: 'rgba(0, 210, 255, 0.15)',
    },
    {
      label: 'COMPLETED TODAY',
      value: totalServed,
      icon: CheckCircle2,
      color: '#00E5A8',
      accentGlow: 'rgba(0, 229, 168, 0.15)',
    },
    {
      label: 'ACTIVE COUNTERS',
      value: (
        <span>
          {activeCounters}
          <span style={{ fontSize: '18px', color: '#64748B', fontWeight: 600 }}>/{totalCounters}</span>
        </span>
      ),
      icon: Monitor,
      color: activeCounters > 0 ? '#00E5A8' : '#94A3B8',
      accentGlow: 'rgba(0, 229, 168, 0.15)',
    },
  ];

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
        gap: '16px',
        marginBottom: '24px',
      }}
    >
      {kpis.map((kpi, idx) => {
        const Icon = kpi.icon;
        return (
          <div
            key={idx}
            className="stat-pill"
            style={{
              padding: '20px 22px',
              alignItems: 'flex-start',
              textAlign: 'left',
              background: 'linear-gradient(135deg, rgba(17, 27, 44, 0.75) 0%, rgba(13, 20, 34, 0.6) 100%)',
            }}
          >
            <div
              style={{
                width: '100%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                marginBottom: '12px',
              }}
            >
              <span
                className="mono"
                style={{
                  fontSize: '11px',
                  fontWeight: 600,
                  color: '#94A3B8',
                  letterSpacing: '0.06em',
                }}
              >
                {kpi.label}
              </span>
              <div
                style={{
                  width: '32px',
                  height: '32px',
                  borderRadius: '10px',
                  background: 'rgba(255, 255, 255, 0.04)',
                  border: '1px solid var(--border-subtle)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: kpi.color,
                }}
              >
                <Icon size={16} />
              </div>
            </div>

            <div
              className="mono"
              style={{
                fontSize: '32px',
                fontWeight: 800,
                color: '#F8FAFC',
                lineHeight: 1,
                letterSpacing: '-0.03em',
              }}
            >
              {kpi.value}
            </div>
          </div>
        );
      })}
    </div>
  );
}
