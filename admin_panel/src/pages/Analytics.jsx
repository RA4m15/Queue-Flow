import React from 'react';
import { useSocket } from '../context/SocketContext';
import { useAnalytics } from '../hooks/useAnalytics';
import LoadingSpinner from '../components/common/LoadingSpinner';
import ErrorMessage from '../components/common/ErrorMessage';
import EmptyState from '../components/common/EmptyState';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  BarChart,
  Bar,
  Cell,
  PieChart,
  Pie,
  Legend,
} from 'recharts';
import { RefreshCw, TrendingUp, BarChart2, PieChart as PieIcon, Clock } from 'lucide-react';

const SERVICE_COLORS = ['var(--color-primary)', 'var(--color-cyan)', 'var(--color-cyan)', 'var(--color-cyan)', 'var(--color-danger)', 'var(--color-warning)', 'var(--color-success)'];

export default function Analytics() {
  const { activeCenterId } = useSocket();
  const { analytics, loading, error, refreshAnalytics } = useAnalytics(activeCenterId);

  const summary = analytics?.summary || {};
  const hourlyFootfall = analytics?.hourlyFootfall || [];
  const serviceDemand = analytics?.serviceDemand || [];
  const counters = analytics?.counters || [];

  // Format service demand data for Pie chart
  const pieData = serviceDemand
    .filter((s) => (s.total || s.completed || 0) > 0)
    .map((s, idx) => ({
      name: s.name,
      value: s.total || s.completed || 0,
      color: SERVICE_COLORS[idx % SERVICE_COLORS.length],
    }));

  // Format counter utilization data from backend API
  const utilData = counters.map((c) => ({
    name: c.name,
    util: typeof c.utilizationPercent === 'number' ? c.utilizationPercent : null,
    served: c.served || 0,
  }));

  const darkTooltipStyle = {
    background: 'var(--bg-card)',
    border: '1px solid rgba(255, 255, 255, 0.15)',
    borderRadius: 12,
    fontSize: 12,
    color: 'var(--text-primary)',
    boxShadow: '0 8px 30px rgba(0, 0, 0, 0.7)',
    fontFamily: 'var(--font-mono)',
  };

  return (
    <div style={{ padding: '24px 28px', maxWidth: '1600px', margin: '0 auto' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '24px' }}>
        <div>
          <h1 style={{ fontSize: '22px', fontWeight: 800, color: 'var(--text-primary)', letterSpacing: '-0.02em' }}>
            Operational Analytics & Telemetry
          </h1>
          <p style={{ fontSize: '13px', color: 'var(--text-secondary)', marginTop: '3px' }}>
            Historical queue performance, counter utilization, and IoT footfall trends
          </p>
        </div>

        <button
          onClick={refreshAnalytics}
          disabled={loading}
          className="btn-secondary"
          style={{ fontSize: '12px', padding: '8px 16px', gap: '8px' }}
        >
          <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
          <span>Refresh Analytics</span>
        </button>
      </div>

      {error && <ErrorMessage message={error} onRetry={refreshAnalytics} />}

      {loading ? (
        <LoadingSpinner message="Aggregating telemetry datasets..." />
      ) : (
        <>
          {/* Top Summary Stats */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '16px', marginBottom: '24px' }}>
            <div className="stat-pill" style={{ alignItems: 'flex-start', textAlign: 'left', padding: '18px 20px' }}>
              <span className="stat-pill-label">Total Issued Today</span>
              <span className="stat-pill-val" style={{ color: 'var(--text-primary)', marginTop: '8px' }}>
                {summary.totalIssued ?? 0}
              </span>
            </div>

            <div className="stat-pill" style={{ alignItems: 'flex-start', textAlign: 'left', padding: '18px 20px' }}>
              <span className="stat-pill-label">Completed Services</span>
              <span className="stat-pill-val" style={{ color: 'var(--color-primary)', marginTop: '8px' }}>
                {summary.totalServed ?? 0}
              </span>
            </div>

            <div className="stat-pill" style={{ alignItems: 'flex-start', textAlign: 'left', padding: '18px 20px' }}>
              <span className="stat-pill-label">Average Wait Time</span>
              <span className="stat-pill-val" style={{ color: 'var(--color-cyan)', marginTop: '8px' }}>
                {summary.avgWaitSeconds ? `${Math.round(summary.avgWaitSeconds / 60)}m` : '—'}
              </span>
            </div>

            <div className="stat-pill" style={{ alignItems: 'flex-start', textAlign: 'left', padding: '18px 20px' }}>
              <span className="stat-pill-label">Current Crowd</span>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px', marginTop: '8px' }}>
                <span className="stat-pill-val" style={{ color: 'var(--text-primary)' }}>
                  {summary.currentCrowd ?? '—'}
                </span>
                <span className="stat-pill-sub" style={{ color: 'var(--color-primary)' }}>
                  {typeof summary.crowdPercent === 'number' ? `${summary.crowdPercent}% full` : ''}
                </span>
              </div>
            </div>
          </div>

          {/* Charts Grid */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(440px, 1fr))', gap: '24px' }}>
            {/* Hourly Footfall Chart */}
            <div className="q-card" style={{ padding: '22px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                <TrendingUp size={16} color="var(--color-primary)" />
                <h3 style={{ fontSize: '15px', fontWeight: 700, color: 'var(--text-primary)' }}>
                  Hourly Visitor Footfall
                </h3>
              </div>
              <p style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '18px' }}>
                Entries logged by IoT optical sensor sensors by hour today
              </p>

              {hourlyFootfall.length === 0 ? (
                <EmptyState title="No footfall recorded yet" description="Footfall events will plot here as visitors arrive." />
              ) : (
                <div style={{ width: '100%', height: '240px' }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={hourlyFootfall} margin={{ top: 8, right: 12, left: -20, bottom: 0 }}>
                      <XAxis dataKey="hour" tick={{ fontSize: 10, fill: 'var(--text-muted)', fontFamily: 'JetBrains Mono' }} axisLine={{ stroke: 'var(--bg-card-alt)' }} tickLine={false} />
                      <YAxis tick={{ fontSize: 10, fill: 'var(--text-muted)', fontFamily: 'JetBrains Mono' }} axisLine={{ stroke: 'var(--bg-card-alt)' }} tickLine={false} />
                      <Tooltip
                        contentStyle={darkTooltipStyle}
                        formatter={(value) => [`${value} visitors`, 'Visitors']}
                      />
                      <Line
                        type="monotone"
                        dataKey="count"
                        stroke="var(--color-primary)"
                        strokeWidth={2.5}
                        dot={{ r: 4, fill: 'var(--color-primary)', stroke: 'var(--bg-card)', strokeWidth: 2 }}
                        activeDot={{ r: 6, fill: 'var(--color-primary)',  }}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              )}
            </div>

            {/* Counter Utilization Chart */}
            <div className="q-card" style={{ padding: '22px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                <BarChart2 size={16} color="var(--color-cyan)" />
                <h3 style={{ fontSize: '15px', fontWeight: 700, color: 'var(--text-primary)' }}>
                  Counter Utilization
                </h3>
              </div>
              <p style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '18px' }}>
                Active time utilization percentage per counter
              </p>

              {utilData.length === 0 ? (
                <EmptyState title="No counter activity" description="Counters will display here once operational." />
              ) : utilData.every((d) => d.util === null) ? (
                <EmptyState title="Utilization unavailable" description="Counter utilization metrics are currently unavailable." />
              ) : (
                <>
                  <div style={{ width: '100%', height: '240px' }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={utilData} margin={{ top: 8, right: 12, left: -20, bottom: 0 }}>
                        <XAxis dataKey="name" tick={{ fontSize: 10, fill: 'var(--text-muted)', fontFamily: 'JetBrains Mono' }} axisLine={{ stroke: 'var(--bg-card-alt)' }} tickLine={false} />
                        <YAxis domain={[0, 100]} unit="%" tick={{ fontSize: 10, fill: 'var(--text-muted)', fontFamily: 'JetBrains Mono' }} axisLine={{ stroke: 'var(--bg-card-alt)' }} tickLine={false} />
                        <Tooltip
                          contentStyle={darkTooltipStyle}
                          formatter={(val) => [
                            val !== null && val !== undefined ? `${val}% utilization` : 'Utilization unavailable',
                            'Utilization',
                          ]}
                        />
                        <Bar dataKey="util" radius={[6, 6, 0, 0]}>
                          {utilData.map((d, i) => (
                            <Cell
                              key={i}
                              fill={d.util !== null ? (d.util > 70 ? 'var(--color-primary)' : d.util > 30 ? 'var(--color-cyan)' : 'var(--color-cyan)') : 'transparent'}
                            />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                  <div style={{ marginTop: '12px', display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                    {utilData.map((d, i) => (
                      <span
                        key={i}
                        className="mono"
                        style={{
                          fontSize: '11px',
                          padding: '4px 10px',
                          borderRadius: '8px',
                          background: 'var(--bg-card-alt)',
                          border: '1px solid var(--border-subtle)',
                          color: d.util !== null ? 'var(--text-primary)' : 'var(--text-muted)',
                        }}
                      >
                        {d.name}: {d.util !== null ? `${d.util}%` : '—'}
                      </span>
                    ))}
                  </div>
                </>
              )}
            </div>

            {/* Service Demand Distribution */}
            <div className="q-card" style={{ padding: '22px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                <PieIcon size={16} color="var(--color-cyan)" />
                <h3 style={{ fontSize: '15px', fontWeight: 700, color: 'var(--text-primary)' }}>
                  Service Demand Breakdown
                </h3>
              </div>
              <p style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '18px' }}>
                Tokens requested by service category
              </p>

              {pieData.length === 0 ? (
                <EmptyState title="No service data" description="Token categories will show here once tokens are requested." />
              ) : (
                <div style={{ width: '100%', height: '240px' }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie data={pieData} dataKey="value" cx="50%" cy="50%" outerRadius={75} innerRadius={45} paddingAngle={4}>
                        {pieData.map((entry, index) => (
                          <Cell key={`cell-${index}`} fill={entry.color} stroke="var(--bg-card)" strokeWidth={2} />
                        ))}
                      </Pie>
                      <Tooltip contentStyle={darkTooltipStyle} />
                      <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 11, fontFamily: 'JetBrains Mono', color: 'var(--text-secondary)' }} />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
              )}
            </div>

            {/* Average Service Time Section */}
            <div className="q-card" style={{ padding: '22px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                <Clock size={16} color="var(--color-warning)" />
                <h3 style={{ fontSize: '15px', fontWeight: 700, color: 'var(--text-primary)' }}>
                  Average Service Time
                </h3>
              </div>
              <p style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '18px' }}>
                Average service duration per completed token by service category
              </p>

              {(!analytics?.queues || analytics.queues.length === 0) ? (
                <EmptyState title="No queue data" description="Queues will appear here." />
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  {analytics.queues?.map((q, idx) => {
                    const avgSec = q.avgServiceTimeSeconds;
                    const avgDisplay = avgSec ? `~${Math.round(avgSec / 60)}m avg` : 'Estimate unavailable';
                    return (
                      <div
                        key={idx}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          padding: '12px 16px',
                          borderRadius: '12px',
                          background: 'var(--bg-card-alt)',
                          border: '1px solid var(--border-subtle)',
                        }}
                      >
                        <div>
                          <p style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)' }}>
                            {q.service?.name || '—'}
                          </p>
                          <p style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>
                            {q.waitingCount || 0} waiting • {q.completedCount || 0} completed
                          </p>
                        </div>
                        <span className="mono" style={{ fontSize: '12px', fontWeight: 700, color: avgSec ? 'var(--color-primary)' : 'var(--text-muted)' }}>
                          {avgDisplay}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
