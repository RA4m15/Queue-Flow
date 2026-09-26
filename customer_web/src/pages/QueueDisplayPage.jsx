import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, Link } from 'react-router-dom';
import { queueAPI, serviceCenterAPI } from '../services/api';
import { connectSocket, onSocketReconnect } from '../services/socket';
import { announceTokenCall, isMuted, setMuted } from '../utils/announcer';

export function QueueDisplayPage() {
  const { centerId: paramCenterId } = useParams();

  const [centers, setCenters] = useState([]);
  const [selectedCenterId, setSelectedCenterId] = useState(paramCenterId || '');
  const [displayData, setDisplayData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [activeCallout, setActiveCallout] = useState(null);
  const [muted, setMutedState] = useState(isMuted());
  const [currentTime, setCurrentTime] = useState(new Date().toLocaleTimeString());
  const [isFullscreen, setIsFullscreen] = useState(false);

  // Keep live clock ticking every second
  useEffect(() => {
    const timer = setInterval(() => {
      setCurrentTime(new Date().toLocaleTimeString());
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  // Load available centers if none provided in URL
  useEffect(() => {
    async function loadCenters() {
      try {
        const res = await serviceCenterAPI.list();
        const list = res.data?.centers || [];
        setCenters(list);
        if (!selectedCenterId && list.length > 0) {
          setSelectedCenterId(list[0]._id);
        }
      } catch (err) {
        console.error('Failed to load centers:', err);
      }
    }
    loadCenters();
  }, [selectedCenterId]);

  // Fetch authoritative display data
  const fetchDisplay = useCallback(async (id = selectedCenterId) => {
    if (!id) {
      setLoading(false);
      return;
    }
    try {
      setError(null);
      const res = await queueAPI.getCenterDisplay(id);
      setDisplayData(res.data);
    } catch (err) {
      setError(err.message || 'Failed to load queue display');
    } finally {
      setLoading(false);
    }
  }, [selectedCenterId]);

  useEffect(() => {
    fetchDisplay(selectedCenterId);
    // Background polling fallback every 20s
    const pollInterval = setInterval(() => {
      fetchDisplay(selectedCenterId);
    }, 20000);
    return () => clearInterval(pollInterval);
  }, [selectedCenterId, fetchDisplay]);

  // Real-time Socket.IO integration
  useEffect(() => {
    if (!selectedCenterId) return;

    const socket = connectSocket();
    socket.emit('join:center', selectedCenterId);

    const unsubReconnect = onSocketReconnect(() => {
      socket.emit('join:center', selectedCenterId);
      fetchDisplay(selectedCenterId);
    });

    const handleTokenCalled = (data) => {
      const token = data?.token;
      const counter = data?.counter;
      if (!token) return;

      const counterName = counter?.displayLabel || counter?.name || (token.counterId ? `Counter ${token.counterId.number || ''}` : 'Counter');

      // Trigger prominent visual callout banner
      setActiveCallout({
        tokenCode: token.tokenCode,
        counterName,
        calledAt: token.calledAt || new Date().toISOString(),
      });

      // Trigger speech announcement (safely deduplicated)
      announceTokenCall({
        tokenCode: token.tokenCode,
        counterName,
        tokenId: token._id,
        calledAt: token.calledAt,
      });

      // Refetch authoritative display state
      fetchDisplay(selectedCenterId);
    };

    const handleQueueChange = () => {
      fetchDisplay(selectedCenterId);
    };

    socket.on('token.called', handleTokenCalled);
    socket.on('token.serving', handleQueueChange);
    socket.on('token.completed', handleQueueChange);
    socket.on('token.skipped', handleQueueChange);
    socket.on('token.cancelled', handleQueueChange);
    socket.on('token.expired', handleQueueChange);
    socket.on('queue.updated', handleQueueChange);

    return () => {
      unsubReconnect();
      socket.off('token.called', handleTokenCalled);
      socket.off('token.serving', handleQueueChange);
      socket.off('token.completed', handleQueueChange);
      socket.off('token.skipped', handleQueueChange);
      socket.off('token.cancelled', handleQueueChange);
      socket.off('token.expired', handleQueueChange);
      socket.off('queue.updated', handleQueueChange);
    };
  }, [selectedCenterId, fetchDisplay]);

  // Dismiss callout banner after 12 seconds
  useEffect(() => {
    if (!activeCallout) return;
    const timeout = setTimeout(() => {
      setActiveCallout(null);
    }, 12000);
    return () => clearTimeout(timeout);
  }, [activeCallout]);

  const toggleMute = () => {
    const next = !muted;
    setMutedState(next);
    setMuted(next);
  };

  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().then(() => setIsFullscreen(true)).catch(() => {});
    } else {
      document.exitFullscreen().then(() => setIsFullscreen(false)).catch(() => {});
    }
  };

  return (
    <div
      style={{
        minHeight: '85vh',
        display: 'flex',
        flexDirection: 'column',
        gap: '1.25rem',
      }}
    >
      {/* Top TV Header Bar */}
      <header
        className="qf-card"
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '0.85rem 1.5rem',
          flexWrap: 'wrap',
          gap: '1rem',
          background: 'rgba(10, 16, 30, 0.85)',
          borderBottom: '2px solid rgba(0, 229, 168, 0.25)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
          <div>
            <h1 style={{ fontSize: '1.25rem', fontWeight: 800, color: 'var(--text-main)', margin: 0 }}>
              {displayData?.center?.name || 'QueueFlow Live Display'}
            </h1>
            <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
              Lobby Display • Code: {displayData?.center?.code || '---'}
            </span>
          </div>

          {centers.length > 1 && (
            <select
              value={selectedCenterId}
              onChange={(e) => setSelectedCenterId(e.target.value)}
              className="qf-input"
              style={{ padding: '0.35rem 0.6rem', fontSize: '0.8rem', maxWidth: '200px' }}
              aria-label="Select Service Center"
            >
              {centers.map((c) => (
                <option key={c._id} value={c._id}>
                  {c.name}
                </option>
              ))}
            </select>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '1.25rem' }}>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: '1.15rem', fontWeight: 700, color: 'var(--color-cyan)', fontFamily: 'monospace' }}>
              {currentTime}
            </div>
            <div style={{ fontSize: '0.75rem', color: 'var(--color-primary)', display: 'flex', alignItems: 'center', gap: '0.3rem', justifyContent: 'flex-end' }}>
              <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: 'var(--color-primary)', display: 'inline-block' }} />
              Live Sync
            </div>
          </div>

          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button
              type="button"
              onClick={toggleMute}
              className="btn-secondary"
              style={{ padding: '0.4rem 0.75rem', fontSize: '0.8rem' }}
              title={muted ? 'Unmute Audio Announcements' : 'Mute Audio Announcements'}
            >
              {muted ? '🔇 Muted' : '🔊 Audio On'}
            </button>

            <button
              type="button"
              onClick={toggleFullscreen}
              className="btn-secondary"
              style={{ padding: '0.4rem 0.75rem', fontSize: '0.8rem' }}
              title="Toggle Fullscreen Mode for TV"
            >
              {isFullscreen ? 'Exit Fullscreen' : '⛶ Fullscreen'}
            </button>
          </div>
        </div>
      </header>

      {/* Prominent High-Visibility Callout Announcement Banner */}
      {activeCallout && (
        <div
          role="alert"
          aria-live="assertive"
          className="qf-card pulse-mint"
          style={{
            background: 'linear-gradient(135deg, rgba(0, 229, 168, 0.35) 0%, rgba(0, 210, 255, 0.25) 100%)',
            border: '3px solid var(--color-primary)',
            padding: '1.75rem',
            textAlign: 'center',
            boxShadow: '0 0 35px rgba(0, 229, 168, 0.3)',
          }}
        >
          <div style={{ fontSize: '1rem', textTransform: 'uppercase', letterSpacing: '0.15em', color: 'var(--color-primary)', fontWeight: 800, marginBottom: '0.35rem' }}>
            🔔 NOW CALLING
          </div>
          <div style={{ fontSize: '3rem', fontWeight: 900, color: '#FFFFFF', letterSpacing: '0.08em', marginBottom: '0.5rem', fontFamily: 'monospace' }}>
            {activeCallout.tokenCode}
          </div>
          <div style={{ fontSize: '1.4rem', fontWeight: 700, color: 'var(--color-cyan)' }}>
            PLEASE PROCEED TO <span style={{ color: '#FFFFFF', textDecoration: 'underline' }}>{activeCallout.counterName}</span>
          </div>
        </div>
      )}

      {loading && !displayData ? (
        <div className="qf-card" style={{ padding: '3rem', textAlign: 'center', color: 'var(--text-muted)' }}>
          Loading live queue telemetry...
        </div>
      ) : error ? (
        <div className="qf-card" style={{ padding: '2rem', textAlign: 'center', color: 'var(--color-danger)' }}>
          {error}
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: '1.25rem' }}>
          {/* Left Column: NOW SERVING Grid */}
          <section className="qf-card" style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border-subtle)', paddingBottom: '0.75rem' }}>
              <h2 style={{ fontSize: '1.2rem', fontWeight: 800, color: 'var(--color-primary)', margin: 0, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <span>🎯</span> CURRENTLY SERVING
              </h2>
              <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
                {displayData?.nowServing?.length || 0} active at counters
              </span>
            </div>

            {(!displayData?.nowServing || displayData.nowServing.length === 0) ? (
              <div style={{ padding: '3rem 1rem', textAlign: 'center', color: 'var(--text-muted)' }}>
                <div style={{ fontSize: '2rem', marginBottom: '0.5rem' }}>⏳</div>
                <div style={{ fontWeight: 600 }}>No tokens currently called</div>
                <div style={{ fontSize: '0.85rem' }}>Next ticket will appear here when called by a teller</div>
              </div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: '1rem' }}>
                {displayData.nowServing.map((item) => (
                  <div
                    key={item._id}
                    style={{
                      background: 'rgba(8, 14, 28, 0.8)',
                      border: '1px solid rgba(0, 229, 168, 0.35)',
                      borderRadius: '12px',
                      padding: '1.25rem',
                      textAlign: 'center',
                      boxShadow: '0 4px 15px rgba(0,0,0,0.3)',
                    }}
                  >
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '0.25rem' }}>
                      {item.serviceId?.name || 'Service'}
                    </div>
                    <div style={{ fontSize: '2.4rem', fontWeight: 900, color: 'var(--color-primary)', fontFamily: 'monospace', margin: '0.2rem 0' }}>
                      {item.tokenCode}
                    </div>
                    <div style={{ fontSize: '1.1rem', fontWeight: 700, color: 'var(--color-cyan)', marginTop: '0.35rem' }}>
                      {item.counterId?.displayLabel || item.counterId?.name || `Counter ${item.counterId?.number || ''}`}
                    </div>
                    <span
                      style={{
                        display: 'inline-block',
                        fontSize: '0.7rem',
                        fontWeight: 700,
                        padding: '0.15rem 0.5rem',
                        borderRadius: '999px',
                        marginTop: '0.5rem',
                        background: item.status === 'SERVING' ? 'rgba(0, 229, 168, 0.15)' : 'rgba(245, 158, 11, 0.15)',
                        color: item.status === 'SERVING' ? 'var(--color-primary)' : '#F59E0B',
                      }}
                    >
                      {item.status}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {/* Active Counters Status Bar */}
            <div style={{ marginTop: 'auto', paddingTop: '1rem', borderTop: '1px solid var(--border-subtle)' }}>
              <div style={{ fontSize: '0.85rem', fontWeight: 700, color: 'var(--text-secondary)', marginBottom: '0.5rem' }}>
                ACTIVE STATIONS
              </div>
              <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
                {displayData?.counters?.map((c) => (
                  <div
                    key={c._id}
                    style={{
                      background: 'rgba(15, 23, 42, 0.6)',
                      border: '1px solid var(--border-subtle)',
                      borderRadius: '8px',
                      padding: '0.5rem 0.85rem',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.6rem',
                      fontSize: '0.85rem',
                    }}
                  >
                    <span
                      style={{
                        width: '8px',
                        height: '8px',
                        borderRadius: '50%',
                        background: c.status === 'ACTIVE' ? (c.servingToken ? 'var(--color-primary)' : 'var(--color-cyan)') : '#64748B',
                      }}
                    />
                    <span style={{ fontWeight: 600 }}>{c.displayLabel || c.name}</span>
                    <span style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>
                      {c.servingToken ? c.servingToken.tokenCode : (c.status === 'ACTIVE' ? 'Idle' : 'Closed')}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </section>

          {/* Right Column: UPCOMING IN LINE (NEXT) */}
          <section className="qf-card" style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <div style={{ borderBottom: '1px solid var(--border-subtle)', paddingBottom: '0.75rem' }}>
              <h2 style={{ fontSize: '1.2rem', fontWeight: 800, color: 'var(--color-cyan)', margin: 0, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <span>📋</span> UPCOMING TICKETS
              </h2>
              <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                Next in line across open services
              </span>
            </div>

            {(!displayData?.nextInQueue || displayData.nextInQueue.length === 0) ? (
              <div style={{ padding: '2rem 1rem', textAlign: 'center', color: 'var(--text-muted)' }}>
                No customers waiting in line
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
                {displayData.nextInQueue.slice(0, 10).map((ticket, idx) => (
                  <div
                    key={ticket._id}
                    style={{
                      background: 'rgba(8, 12, 22, 0.7)',
                      border: '1px solid var(--border-subtle)',
                      borderRadius: '8px',
                      padding: '0.65rem 1rem',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                      <span
                        style={{
                          fontSize: '0.8rem',
                          fontWeight: 700,
                          color: 'var(--text-muted)',
                          width: '24px',
                        }}
                      >
                        #{idx + 1}
                      </span>
                      <span
                        style={{
                          fontSize: '1.2rem',
                          fontWeight: 800,
                          color: 'var(--text-main)',
                          fontFamily: 'monospace',
                        }}
                      >
                        {ticket.tokenCode}
                      </span>
                    </div>

                    <div style={{ textAlign: 'right' }}>
                      <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                        {ticket.serviceId?.name || 'Service'}
                      </div>
                      {ticket.waitEstimateMinutes !== undefined && (
                        <div style={{ fontSize: '0.7rem', color: 'var(--color-primary)' }}>
                          ~{ticket.waitEstimateMinutes}m wait
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Service Queue Stats */}
            <div style={{ marginTop: 'auto', paddingTop: '1rem', borderTop: '1px solid var(--border-subtle)' }}>
              <div style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '0.5rem' }}>
                Service Wait Times
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem', fontSize: '0.8rem' }}>
                {displayData?.queues?.map((q) => (
                  <div key={q.queueId} style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text-secondary)' }}>
                    <span>{q.service?.name}</span>
                    <span style={{ color: 'var(--color-primary)', fontWeight: 600 }}>
                      {q.waitingCount} waiting (~{q.estimatedWaitMinutes}m)
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
