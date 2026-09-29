import React, { useState } from 'react';
import { useSocket } from '../context/SocketContext';
import { useQueue } from '../hooks/useQueue';
import { useCounters } from '../hooks/useCounters';
import { useCrowd } from '../hooks/useCrowd';
import { useAnalytics } from '../hooks/useAnalytics';
import StatPills from '../components/dashboard/StatPills';
import CrowdWidget from '../components/dashboard/CrowdWidget';
import CounterCard from '../components/counters/CounterCard';
import AssignServiceModal from '../components/counters/AssignServiceModal';
import QueueTable from '../components/queue/QueueTable';
import LiveLog from '../components/dashboard/LiveLog';
import LoadingSpinner from '../components/common/LoadingSpinner';
import ErrorMessage from '../components/common/ErrorMessage';
import { RefreshCw, Radio } from 'lucide-react';

export default function Dashboard() {
  const { activeCenterId } = useSocket();
  const { queues, liveLog, loading: queueLoading, error: queueError, refreshQueue } = useQueue(activeCenterId);
  const {
    counters,
    loading: countersLoading,
    error: countersError,
    actionLoadingId,
    callNext,
    startServing,
    complete,
    skip,
    updateStatus,
    assignService,
    refreshCounters,
  } = useCounters(activeCenterId);
  const { crowdData, isReadingStale, refreshCrowd } = useCrowd(activeCenterId);
  const { analytics, refreshAnalytics } = useAnalytics(activeCenterId);

  const [selectedCounterForAssign, setSelectedCounterForAssign] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  const handleRefreshAll = async () => {
    setRefreshing(true);
    try {
      await Promise.all([
        refreshQueue(),
        refreshCounters(),
        refreshCrowd(),
        refreshAnalytics?.(),
      ]);
    } finally {
      setRefreshing(false);
    }
  };

  const isLoading = queueLoading || countersLoading;
  const error = queueError || countersError;

  return (
    <div style={{ padding: '24px 28px', maxWidth: '1600px', margin: '0 auto' }}>
      {/* Header controls */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '24px' }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <h1 style={{ fontSize: '22px', fontWeight: 800, color: 'var(--text-primary)', letterSpacing: '-0.02em' }}>
              Live Operations Command
            </h1>
            <span
              className="mono"
              style={{
                fontSize: '10px',
                fontWeight: 700,
                padding: '2px 8px',
                borderRadius: '6px',
                background: 'color-mix(in srgb, var(--color-primary) 12%, transparent)',
                color: 'var(--color-primary)',
                border: '1px solid color-mix(in srgb, var(--color-primary) 30%, transparent)',
              }}
            >
              REALTIME MESH
            </span>
          </div>
          <p style={{ fontSize: '13px', color: 'var(--text-secondary)', marginTop: '3px' }}>
            Real-time counter orchestration, IoT crowd footfall, and synchronized queue state
          </p>
        </div>

        <button
          onClick={handleRefreshAll}
          disabled={refreshing}
          className="btn-secondary"
          style={{ fontSize: '12px', padding: '8px 16px', gap: '8px' }}
          title="Force refresh facility telemetry"
        >
          <RefreshCw size={13} className={refreshing ? 'animate-spin' : ''} />
          <span>{refreshing ? 'Synchronizing...' : 'Sync Telemetry'}</span>
        </button>
      </div>

      {error && <ErrorMessage message={error} onRetry={handleRefreshAll} />}

      {isLoading && !refreshing ? (
        <LoadingSpinner message="Connecting to facility queue streams..." />
      ) : (
        <>
          {/* Top Metrics Stat Pills */}
          <StatPills
            queues={queues}
            counters={counters}
            avgWaitSeconds={analytics?.summary?.avgWaitSeconds}
            metrics={analytics?.summary}
          />

          {/* IoT Live Footfall Card */}
          <CrowdWidget
            crowdData={crowdData}
            isReadingStale={isReadingStale}
          />

          {/* Main 2-Column Grid: Counters on left, Live Log & Queues on right */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))', gap: '24px', alignItems: 'start' }}>
            {/* Left Column: Counters */}
            <div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
                <p className="mono" style={{ fontSize: '10px', letterSpacing: '0.1em', color: 'var(--text-muted)', textTransform: 'uppercase' }}>
                  FACILITY COUNTERS ({counters.length})
                </p>
              </div>

              {counters.length === 0 ? (
                <div
                  className="q-card"
                  style={{
                    padding: '36px 24px',
                    textAlign: 'center',
                    color: 'var(--text-muted)',
                    fontSize: '13px',
                    borderRadius: '18px',
                  }}
                >
                  No active counters configured for this facility.
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', marginBottom: '24px' }}>
                  {counters.map((c) => (
                    <CounterCard
                      key={c._id}
                      counter={c}
                      isLoading={actionLoadingId === c._id}
                      onCallNext={callNext}
                      onStartServing={startServing}
                      onComplete={complete}
                      onSkip={skip}
                      onUpdateStatus={updateStatus}
                      onOpenAssign={setSelectedCounterForAssign}
                    />
                  ))}
                </div>
              )}
            </div>

            {/* Right Column: Live Event Log & Service Queues */}
            <div>
              <LiveLog log={liveLog} />
              <QueueTable queues={queues} />
            </div>
          </div>
        </>
      )}

      {/* Assign Service Modal */}
      {selectedCounterForAssign && (
        <AssignServiceModal
          counter={selectedCounterForAssign}
          centerId={activeCenterId}
          onClose={() => setSelectedCounterForAssign(null)}
          onAssign={assignService}
        />
      )}
    </div>
  );
}
