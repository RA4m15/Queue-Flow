import React from 'react';

export default function QueueTable({ queues = [] }) {
  if (queues.length === 0) {
    return (
      <div className="q-card table-empty">
        No active queues found for today.
      </div>
    );
  }

  return (
    <section className="table-panel">
      <span className="eyebrow">Facility queue telemetry</span>

      {/* Horizontal scroll is contained here so the page never overflows. */}
      <div className="q-card table-scroll">
        <table className="data-table">
          <thead>
            <tr>
              <th>Service</th>
              <th>Prefix</th>
              <th className="num">Waiting</th>
              <th className="num">Served</th>
              <th className="num">Issued</th>
              <th>Avg service</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {queues.map((q, idx) => {
              const serviceName = q.service?.name || '\u2014';
              const prefix = q.service?.tokenPrefix || '\u2014';
              const waiting = q.waitingCount || 0;
              const completed = q.completedCount || 0;
              const total = q.totalIssued || 0;
              const avgSec = q.avgServiceTimeSeconds;
              const avgDisplay = avgSec ? `${Math.round(avgSec / 60)} min` : 'No data yet';
              const isOpen = q.status === 'OPEN';

              return (
                <tr key={q._id || idx}>
                  <td className="strong">{serviceName}</td>

                  <td>
                    <span className="prefix-chip mono">{prefix}</span>
                  </td>

                  <td className="num">
                    <span
                      className="mono num-strong"
                      style={{
                        color: waiting > 10
                          ? 'var(--color-danger)'
                          : waiting > 5
                            ? 'var(--color-warning)'
                            : 'var(--text-primary)',
                      }}
                    >
                      {waiting}
                    </span>
                  </td>

                  <td className="num">
                    <span className="mono" style={{ color: 'var(--color-success)', fontWeight: 600 }}>
                      {completed}
                    </span>
                  </td>

                  <td className="num">
                    <span className="mono muted">{total}</span>
                  </td>

                  <td className="muted">{avgDisplay}</td>

                  <td>
                    <span
                      className={`badge ${isOpen ? 'badge-serving' : 'badge-closed'}`}
                    >
                      {q.status || '\u2014'}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
