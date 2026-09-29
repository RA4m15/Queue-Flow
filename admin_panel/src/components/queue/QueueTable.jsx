import React from 'react';

export default function QueueTable({ queues = [] }) {
  if (queues.length === 0) {
    return (
      <div
        className="q-card"
        style={{
          padding: '28px',
          textAlign: 'center',
          color: '#64748B',
          fontSize: '13px',
          borderRadius: '16px',
        }}
      >
        No active queues found for today.
      </div>
    );
  }

  return (
    <div style={{ marginBottom: '24px' }}>
      <p className="mono" style={{ fontSize: '10px', letterSpacing: '0.1em', color: '#64748B', marginBottom: '10px', textTransform: 'uppercase' }}>
        FACILITY QUEUE TELEMETRY
      </p>

      <div
        className="q-card"
        style={{
          overflow: 'hidden',
          background: 'rgba(13, 20, 34, 0.8)',
          border: '1px solid var(--border-subtle)',
        }}
      >
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '13px' }}>
            <thead>
              <tr
                style={{
                  background: 'rgba(17, 27, 44, 0.85)',
                  borderBottom: '1px solid var(--border-subtle)',
                  color: '#94A3B8',
                  fontSize: '11px',
                  fontFamily: 'var(--font-mono)',
                  letterSpacing: '0.04em',
                }}
              >
                <th style={{ padding: '12px 16px', fontWeight: 600 }}>SERVICE</th>
                <th style={{ padding: '12px 16px', fontWeight: 600 }}>PREFIX</th>
                <th style={{ padding: '12px 16px', fontWeight: 600 }}>WAITING</th>
                <th style={{ padding: '12px 16px', fontWeight: 600 }}>SERVED</th>
                <th style={{ padding: '12px 16px', fontWeight: 600 }}>TOTAL ISSUED</th>
                <th style={{ padding: '12px 16px', fontWeight: 600 }}>AVG SERVICE TIME</th>
                <th style={{ padding: '12px 16px', fontWeight: 600 }}>STATUS</th>
              </tr>
            </thead>
            <tbody>
              {queues.map((q, idx) => {
                const serviceName = q.service?.name || '—';
                const prefix = q.service?.tokenPrefix || '—';
                const waiting = q.waitingCount || 0;
                const completed = q.completedCount || 0;
                const total = q.totalIssued || 0;
                const avgSec = q.avgServiceTimeSeconds;
                const avgDisplay = avgSec
                  ? `${Math.round(avgSec / 60)} min`
                  : 'Estimate unavailable';

                return (
                  <tr
                    key={q._id || idx}
                    style={{
                      borderBottom: idx < queues.length - 1 ? '1px solid var(--border-subtle)' : 'none',
                      transition: 'background 0.15s ease',
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255, 255, 255, 0.03)')}
                    onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                  >
                    <td style={{ padding: '13px 16px', fontWeight: 600, color: '#F8FAFC' }}>
                      {serviceName}
                    </td>

                    <td style={{ padding: '13px 16px' }}>
                      <span
                        className="mono"
                        style={{
                          fontSize: '11px',
                          padding: '2px 8px',
                          borderRadius: '6px',
                          background: 'rgba(0, 229, 168, 0.12)',
                          color: '#00E5A8',
                          border: '1px solid rgba(0, 229, 168, 0.25)',
                          fontWeight: 700,
                        }}
                      >
                        {prefix}
                      </span>
                    </td>

                    <td style={{ padding: '13px 16px' }}>
                      <span
                        className="mono"
                        style={{
                          fontSize: '14px',
                          fontWeight: 700,
                          color: waiting > 10 ? '#EF4444' : waiting > 5 ? '#FBBF24' : '#F8FAFC',
                        }}
                      >
                        {waiting}
                      </span>
                    </td>

                    <td style={{ padding: '13px 16px', color: '#00E5A8', fontWeight: 600 }} className="mono">
                      {completed}
                    </td>

                    <td style={{ padding: '13px 16px', color: '#94A3B8' }} className="mono">
                      {total}
                    </td>

                    <td style={{ padding: '13px 16px', color: '#94A3B8' }}>
                      {avgDisplay}
                    </td>

                    <td style={{ padding: '13px 16px' }}>
                      <span
                        className="badge"
                        style={{
                          fontSize: '9px',
                          background: q.status === 'OPEN' ? 'rgba(0, 229, 168, 0.12)' : 'rgba(239, 68, 68, 0.12)',
                          color: q.status === 'OPEN' ? '#00E5A8' : '#EF4444',
                          borderColor: q.status === 'OPEN' ? 'rgba(0, 229, 168, 0.3)' : 'rgba(239, 68, 68, 0.3)',
                        }}
                      >
                        {q.status || '—'}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
