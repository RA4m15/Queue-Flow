import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import { useSocket } from '../context/SocketContext';
import { counterAPI } from '../services/api';
import {
  Play,
  CheckCircle2,
  SkipForward,
  RotateCcw,
  Coffee,
  PowerOff,
  Power,
  Users,
  Clock,
  Radio,
  AlertTriangle,
  RefreshCw,
  Layers,
  ChevronRight,
  ShieldAlert,
} from 'lucide-react';
import LoadingSpinner from '../components/common/LoadingSpinner';

export default function OperatorPortal() {
  const { user } = useAuth();
  const { isConnected, on, setActiveCenterId } = useSocket();

  const [counterData, setCounterData] = useState(null);
  const [queueData, setQueueData] = useState(null);
  const [waitingTokens, setWaitingTokens] = useState([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [successMessage, setSuccessMessage] = useState('');
  const [confirmSkipModal, setConfirmSkipModal] = useState(false);

  // Fetch operator counter data from backend
  const fetchOperatorState = useCallback(async () => {
    try {
      setErrorMessage('');
      const res = await counterAPI.getOperatorCounter();
      if (res.success && res.data) {
        setCounterData(res.data.counter);
        setQueueData(res.data.queue);
        setWaitingTokens(res.data.waitingTokens || []);
        if (res.data.counter?.centerId?._id) {
          setActiveCenterId(res.data.counter.centerId._id);
        }
      }
    } catch (err) {
      setErrorMessage(err.message || 'Failed to load operator counter data');
    } finally {
      setLoading(false);
    }
  }, [setActiveCenterId]);

  useEffect(() => {
    fetchOperatorState();
  }, [fetchOperatorState]);

  // Real-time socket events for counter and queue updates
  useEffect(() => {
    const unsubQueue = on('queue.updated', () => {
      fetchOperatorState();
    });

    const unsubCounter = on('counter.updated', (payload) => {
      if (payload?.counter?._id === counterData?._id) {
        setCounterData((prev) => ({ ...prev, ...payload.counter }));
      }
    });

    const unsubCalled = on('token.called', (payload) => {
      if (payload?.counter?._id === counterData?._id) {
        fetchOperatorState();
      }
    });

    const unsubServing = on('token.serving', () => {
      fetchOperatorState();
    });

    const unsubCompleted = on('token.completed', () => {
      fetchOperatorState();
    });

    const unsubSkipped = on('token.skipped', () => {
      fetchOperatorState();
    });

    return () => {
      unsubQueue?.();
      unsubCounter?.();
      unsubCalled?.();
      unsubServing?.();
      unsubCompleted?.();
      unsubSkipped?.();
    };
  }, [on, counterData?._id, fetchOperatorState]);

  // Action Handlers
  const handleCallNext = async () => {
    if (!counterData?._id) return;
    setActionLoading(true);
    setErrorMessage('');
    setSuccessMessage('');
    try {
      const res = await counterAPI.callNext(counterData._id);
      if (res.success) {
        if (res.data?.token) {
          setSuccessMessage(`Token ${res.data.token.tokenCode} called successfully`);
        } else {
          setSuccessMessage('No more waiting tokens in queue');
        }
        await fetchOperatorState();
      }
    } catch (err) {
      setErrorMessage(err.message || 'Failed to call next token');
    } finally {
      setActionLoading(false);
    }
  };

  const handleRecall = async () => {
    if (!counterData?._id) return;
    setActionLoading(true);
    setErrorMessage('');
    setSuccessMessage('');
    try {
      const res = await counterAPI.recall(counterData._id);
      if (res.success) {
        setSuccessMessage(`Token ${res.data?.token?.tokenCode} re-called!`);
      }
    } catch (err) {
      setErrorMessage(err.message || 'Failed to re-call token');
    } finally {
      setActionLoading(false);
    }
  };

  const handleStartServing = async () => {
    if (!counterData?._id) return;
    setActionLoading(true);
    setErrorMessage('');
    setSuccessMessage('');
    try {
      const res = await counterAPI.startServing(counterData._id);
      if (res.success) {
        setSuccessMessage(`Token ${res.data?.token?.tokenCode} is now SERVING`);
        await fetchOperatorState();
      }
    } catch (err) {
      setErrorMessage(err.message || 'Failed to start serving token');
    } finally {
      setActionLoading(false);
    }
  };

  const handleComplete = async () => {
    if (!counterData?._id) return;
    setActionLoading(true);
    setErrorMessage('');
    setSuccessMessage('');
    try {
      const res = await counterAPI.complete(counterData._id);
      if (res.success) {
        setSuccessMessage(`Token ${res.data?.token?.tokenCode} COMPLETED successfully`);
        await fetchOperatorState();
      }
    } catch (err) {
      setErrorMessage(err.message || 'Failed to complete token');
    } finally {
      setActionLoading(false);
    }
  };

  const handleSkip = async () => {
    if (!counterData?._id) return;
    setActionLoading(true);
    setErrorMessage('');
    setSuccessMessage('');
    setConfirmSkipModal(false);
    try {
      const res = await counterAPI.skip(counterData._id);
      if (res.success) {
        setSuccessMessage(`Token skipped`);
        await fetchOperatorState();
      }
    } catch (err) {
      setErrorMessage(err.message || 'Failed to skip token');
    } finally {
      setActionLoading(false);
    }
  };

  const handleStatusChange = async (nextStatus) => {
    if (!counterData?._id) return;
    setActionLoading(true);
    setErrorMessage('');
    setSuccessMessage('');
    try {
      const res = await counterAPI.updateStatus(counterData._id, nextStatus);
      if (res.success) {
        setSuccessMessage(`Counter status changed to ${nextStatus}`);
        await fetchOperatorState();
      }
    } catch (err) {
      setErrorMessage(err.message || 'Failed to update counter status');
    } finally {
      setActionLoading(false);
    }
  };

  if (loading) {
    return <LoadingSpinner message="Connecting to assigned counter..." />;
  }

  if (!counterData) {
    return (
      <div style={{ padding: '40px 24px', maxWidth: '800px', margin: '40px auto', textAlign: 'center' }}>
        <div
          style={{
            background: 'var(--bg-card)',
            border: '1px solid var(--border-subtle)',
            borderRadius: '16px',
            padding: '48px 32px',
          }}
        >
          <ShieldAlert size={48} color="#F59E0B" style={{ marginBottom: '16px' }} />
          <h2 style={{ fontSize: '1.5rem', fontWeight: 600, color: 'var(--text-primary)', marginBottom: '8px' }}>
            No Assigned Counter Found
          </h2>
          <p style={{ color: 'var(--text-secondary)', marginBottom: '24px', lineHeight: 1.6 }}>
            You are logged in as <strong>{user?.name}</strong> ({user?.role}). An administrator has not statically assigned your account to an active counter in this service center yet.
          </p>
          <button
            onClick={fetchOperatorState}
            className="btn btn-outline"
            style={{ display: 'inline-flex', alignItems: 'center', gap: '8px' }}
          >
            <RefreshCw size={16} /> Re-check Counter Assignment
          </button>
        </div>
      </div>
    );
  }

  const currentToken = counterData.currentTokenId;
  const isCalled = currentToken && currentToken.status === 'CALLED';
  const isServing = currentToken && currentToken.status === 'SERVING';
  const isBreak = counterData.status === 'BREAK';
  const isClosed = counterData.status === 'CLOSED';
  const isActive = counterData.status === 'ACTIVE';

  return (
    <div style={{ padding: '24px 28px', maxWidth: '1400px', margin: '0 auto' }}>
      {/* Top Header Bar */}
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '16px',
          marginBottom: '24px',
          background: 'var(--bg-card)',
          padding: '16px 24px',
          borderRadius: '14px',
          border: '1px solid var(--border-subtle)',
        }}
      >
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <h1 style={{ fontSize: '1.4rem', fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>
              {counterData.name || `Counter ${counterData.number}`}
            </h1>
            <span
              style={{
                fontSize: '0.75rem',
                fontWeight: 600,
                padding: '3px 10px',
                borderRadius: '12px',
                background: isActive ? 'rgba(0, 229, 168, 0.15)' : isBreak ? 'rgba(245, 158, 11, 0.15)' : 'rgba(148, 163, 184, 0.15)',
                color: isActive ? 'var(--color-primary)' : isBreak ? '#F59E0B' : '#94A3B8',
                border: `1px solid ${isActive ? 'rgba(0, 229, 168, 0.3)' : isBreak ? 'rgba(245, 158, 11, 0.3)' : 'rgba(148, 163, 184, 0.3)'}`,
              }}
            >
              {counterData.status}
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '16px', marginTop: '6px', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
            <span>Operator: <strong style={{ color: 'var(--text-primary)' }}>{user?.name}</strong></span>
            <span>•</span>
            <span>Center: <strong style={{ color: 'var(--text-primary)' }}>{counterData.centerId?.name || 'Assigned Center'}</strong></span>
            <span>•</span>
            <span>Service: <strong style={{ color: 'var(--text-primary)' }}>{counterData.serviceId?.name || 'Unassigned'}</strong></span>
          </div>
        </div>

        {/* Real-time connection badge & manual refresh */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              padding: '6px 12px',
              borderRadius: '20px',
              background: isConnected ? 'rgba(0, 229, 168, 0.1)' : 'rgba(239, 68, 68, 0.1)',
              border: `1px solid ${isConnected ? 'rgba(0, 229, 168, 0.25)' : 'rgba(239, 68, 68, 0.25)'}`,
              fontSize: '0.75rem',
              color: isConnected ? 'var(--color-primary)' : '#EF4444',
            }}
          >
            <Radio size={12} className={isConnected ? 'pulse' : ''} />
            {isConnected ? 'LIVE CONNECTED' : 'OFFLINE'}
          </div>

          <button
            onClick={fetchOperatorState}
            disabled={actionLoading}
            className="btn btn-outline"
            style={{ padding: '8px 14px', fontSize: '0.8rem', display: 'flex', alignItems: 'center', gap: '6px' }}
          >
            <RefreshCw size={14} className={actionLoading ? 'spin' : ''} />
            Refresh
          </button>
        </div>
      </div>

      {/* Alert Banners */}
      {errorMessage && (
        <div
          style={{
            background: 'rgba(239, 68, 68, 0.15)',
            border: '1px solid rgba(239, 68, 68, 0.35)',
            color: '#FCA5A5',
            padding: '12px 18px',
            borderRadius: '10px',
            marginBottom: '20px',
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            fontSize: '0.9rem',
          }}
        >
          <AlertTriangle size={18} color="#EF4444" />
          <span>{errorMessage}</span>
        </div>
      )}

      {successMessage && (
        <div
          style={{
            background: 'rgba(0, 229, 168, 0.12)',
            border: '1px solid rgba(0, 229, 168, 0.3)',
            color: 'var(--color-primary)',
            padding: '12px 18px',
            borderRadius: '10px',
            marginBottom: '20px',
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            fontSize: '0.9rem',
          }}
        >
          <CheckCircle2 size={18} color="var(--color-primary)" />
          <span>{successMessage}</span>
        </div>
      )}

      {/* Main Grid: Operator Action Center & Queue Peek */}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(320px, 1fr) 360px', gap: '24px' }}>
        {/* Left Column: Current Customer / Hero Card & Core Actions */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
          {/* Hero Token Card */}
          <div
            className="q-card"
            style={{
              padding: '32px',
              textAlign: 'center',
              border: isServing
                ? '1px solid rgba(0, 229, 168, 0.45)'
                : isCalled
                ? '1px solid rgba(59, 130, 246, 0.45)'
                : '1px solid var(--border-subtle)',
              boxShadow: isServing
                ? '0 0 30px rgba(0, 229, 168, 0.12)'
                : isCalled
                ? '0 0 30px rgba(59, 130, 246, 0.12)'
                : 'none',
              background: isServing
                ? 'linear-gradient(135deg, rgba(17, 27, 44, 0.95) 0%, rgba(13, 20, 34, 0.85) 100%)'
                : 'var(--bg-card)',
            }}
          >
            <div style={{ fontSize: '0.85rem', textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-secondary)', marginBottom: '8px' }}>
              Current Customer at Counter
            </div>

            {currentToken ? (
              <div>
                <div
                  style={{
                    fontSize: '4rem',
                    fontWeight: 800,
                    letterSpacing: '-0.02em',
                    color: isServing ? 'var(--color-primary)' : '#60A5FA',
                    margin: '12px 0',
                    fontFamily: 'monospace',
                  }}
                >
                  {currentToken.tokenCode}
                </div>

                <div style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', padding: '6px 16px', borderRadius: '20px', background: isServing ? 'rgba(0, 229, 168, 0.15)' : 'rgba(59, 130, 246, 0.15)', color: isServing ? 'var(--color-primary)' : '#60A5FA', fontWeight: 700, fontSize: '0.85rem', marginBottom: '24px' }}>
                  <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: isServing ? 'var(--color-primary)' : '#60A5FA' }} />
                  {currentToken.status}
                </div>

                {currentToken.calledAt && (
                  <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '24px' }}>
                    Called at: {new Date(currentToken.calledAt).toLocaleTimeString()}
                    {currentToken.servingAt && ` • Serving started: ${new Date(currentToken.servingAt).toLocaleTimeString()}`}
                  </div>
                )}
              </div>
            ) : (
              <div style={{ padding: '36px 0' }}>
                <div style={{ fontSize: '3rem', fontWeight: 800, color: 'var(--text-disabled)', margin: '8px 0' }}>
                  IDLE
                </div>
                <p style={{ color: 'var(--text-secondary)', fontSize: '0.95rem' }}>
                  No customer is currently called at this counter.
                </p>
              </div>
            )}

            {/* Action Buttons Matrix */}
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
                gap: '12px',
                marginTop: '16px',
                paddingTop: '20px',
                borderTop: '1px solid var(--border-subtle)',
              }}
            >
              {/* Call Next Button */}
              <button
                onClick={handleCallNext}
                disabled={actionLoading || isClosed || isBreak}
                className="btn btn-primary"
                style={{
                  padding: '14px 18px',
                  fontWeight: 700,
                  fontSize: '0.95rem',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '8px',
                  opacity: isClosed || isBreak ? 0.5 : 1,
                }}
              >
                <Play size={18} />
                CALL NEXT
              </button>

              {/* Re-call Button (only when CALLED) */}
              <button
                onClick={handleRecall}
                disabled={actionLoading || !isCalled}
                className="btn"
                style={{
                  padding: '14px 18px',
                  fontWeight: 600,
                  fontSize: '0.9rem',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '8px',
                  background: isCalled ? 'rgba(59, 130, 246, 0.2)' : 'rgba(255, 255, 255, 0.05)',
                  color: isCalled ? '#60A5FA' : 'var(--text-disabled)',
                  border: isCalled ? '1px solid rgba(59, 130, 246, 0.4)' : '1px solid var(--border-subtle)',
                }}
              >
                <RotateCcw size={16} />
                RE-CALL
              </button>

              {/* Start Serving Button */}
              <button
                onClick={handleStartServing}
                disabled={actionLoading || !isCalled}
                className="btn"
                style={{
                  padding: '14px 18px',
                  fontWeight: 600,
                  fontSize: '0.9rem',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '8px',
                  background: isCalled ? 'rgba(0, 229, 168, 0.2)' : 'rgba(255, 255, 255, 0.05)',
                  color: isCalled ? 'var(--color-primary)' : 'var(--text-disabled)',
                  border: isCalled ? '1px solid rgba(0, 229, 168, 0.4)' : '1px solid var(--border-subtle)',
                }}
              >
                <CheckCircle2 size={16} />
                START SERVING
              </button>

              {/* Complete Button */}
              <button
                onClick={handleComplete}
                disabled={actionLoading || (!isServing && !isCalled)}
                className="btn"
                style={{
                  padding: '14px 18px',
                  fontWeight: 600,
                  fontSize: '0.9rem',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '8px',
                  background: isServing || isCalled ? 'rgba(16, 185, 129, 0.2)' : 'rgba(255, 255, 255, 0.05)',
                  color: isServing || isCalled ? '#34D399' : 'var(--text-disabled)',
                  border: isServing || isCalled ? '1px solid rgba(16, 185, 129, 0.4)' : '1px solid var(--border-subtle)',
                }}
              >
                <CheckCircle2 size={16} />
                COMPLETE
              </button>

              {/* Skip Button */}
              <button
                onClick={() => setConfirmSkipModal(true)}
                disabled={actionLoading || (!isServing && !isCalled)}
                className="btn"
                style={{
                  padding: '14px 18px',
                  fontWeight: 600,
                  fontSize: '0.9rem',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '8px',
                  background: isServing || isCalled ? 'rgba(239, 68, 68, 0.15)' : 'rgba(255, 255, 255, 0.05)',
                  color: isServing || isCalled ? '#F87171' : 'var(--text-disabled)',
                  border: isServing || isCalled ? '1px solid rgba(239, 68, 68, 0.3)' : '1px solid var(--border-subtle)',
                }}
              >
                <SkipForward size={16} />
                SKIP
              </button>
            </div>
          </div>

          {/* Counter Status Controls */}
          <div
            className="q-card"
            style={{
              padding: '20px 24px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '16px',
            }}
          >
            <div>
              <div style={{ fontWeight: 600, color: 'var(--text-primary)', fontSize: '0.95rem' }}>Counter Operating State</div>
              <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Manage your availability for token assignment</div>
            </div>

            <div style={{ display: 'flex', gap: '8px' }}>
              <button
                onClick={() => handleStatusChange('ACTIVE')}
                disabled={actionLoading || isActive}
                className="btn"
                style={{
                  padding: '8px 14px',
                  fontSize: '0.8rem',
                  fontWeight: 600,
                  background: isActive ? 'rgba(0, 229, 168, 0.2)' : 'rgba(255, 255, 255, 0.05)',
                  color: isActive ? 'var(--color-primary)' : 'var(--text-secondary)',
                  border: isActive ? '1px solid var(--color-primary)' : '1px solid var(--border-subtle)',
                }}
              >
                <Power size={14} style={{ marginRight: '6px' }} />
                ACTIVE
              </button>

              <button
                onClick={() => handleStatusChange('BREAK')}
                disabled={actionLoading || isBreak}
                className="btn"
                style={{
                  padding: '8px 14px',
                  fontSize: '0.8rem',
                  fontWeight: 600,
                  background: isBreak ? 'rgba(245, 158, 11, 0.2)' : 'rgba(255, 255, 255, 0.05)',
                  color: isBreak ? '#F59E0B' : 'var(--text-secondary)',
                  border: isBreak ? '1px solid #F59E0B' : '1px solid var(--border-subtle)',
                }}
              >
                <Coffee size={14} style={{ marginRight: '6px' }} />
                BREAK
              </button>

              <button
                onClick={() => handleStatusChange('CLOSED')}
                disabled={actionLoading || isClosed}
                className="btn"
                style={{
                  padding: '8px 14px',
                  fontSize: '0.8rem',
                  fontWeight: 600,
                  background: isClosed ? 'rgba(239, 68, 68, 0.2)' : 'rgba(255, 255, 255, 0.05)',
                  color: isClosed ? '#F87171' : 'var(--text-secondary)',
                  border: isClosed ? '1px solid #EF4444' : '1px solid var(--border-subtle)',
                }}
              >
                <PowerOff size={14} style={{ marginRight: '6px' }} />
                CLOSE
              </button>
            </div>
          </div>
        </div>

        {/* Right Column: Queue Summary & Upcoming Waiting Customers */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
          {/* Quick Metrics */}
          <div
            className="q-card"
            style={{
              padding: '20px 24px',
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: '16px',
            }}
          >
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.75rem', color: 'var(--text-secondary)', marginBottom: '4px' }}>
                <Users size={14} /> PEOPLE WAITING
              </div>
              <div style={{ fontSize: '1.8rem', fontWeight: 800, color: 'var(--text-primary)' }}>
                {queueData?.waitingCount ?? waitingTokens.length}
              </div>
            </div>

            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.75rem', color: 'var(--text-secondary)', marginBottom: '4px' }}>
                <Clock size={14} /> EST WAIT TIME
              </div>
              <div style={{ fontSize: '1.8rem', fontWeight: 800, color: 'var(--color-primary)' }}>
                {queueData?.estimatedWaitMinutes ?? (counterData.serviceId?.avgServiceTimeMinutes || 10)}m
              </div>
            </div>
          </div>

          {/* Next in Line Queue List */}
          <div className="q-card" style={{ padding: '24px', flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
              <div style={{ fontSize: '0.9rem', fontWeight: 700, color: 'var(--text-primary)' }}>
                Next in Line ({waitingTokens.length})
              </div>
              <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>No Customer PII</span>
            </div>

            {waitingTokens.length === 0 ? (
              <div style={{ padding: '32px 0', textAlign: 'center', color: 'var(--text-secondary)' }}>
                <Layers size={32} color="var(--text-disabled)" style={{ marginBottom: '8px' }} />
                <p style={{ margin: 0, fontSize: '0.85rem' }}>No tokens waiting in queue</p>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {waitingTokens.map((t, idx) => (
                  <div
                    key={t._id || idx}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '10px 14px',
                      background: 'rgba(255, 255, 255, 0.03)',
                      borderRadius: '8px',
                      border: idx === 0 ? '1px solid rgba(0, 229, 168, 0.3)' : '1px solid var(--border-subtle)',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                      <span
                        style={{
                          width: '24px',
                          height: '24px',
                          borderRadius: '50%',
                          background: idx === 0 ? 'rgba(0, 229, 168, 0.2)' : 'rgba(255, 255, 255, 0.08)',
                          color: idx === 0 ? 'var(--color-primary)' : 'var(--text-secondary)',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          fontSize: '0.75rem',
                          fontWeight: 700,
                        }}
                      >
                        {idx + 1}
                      </span>
                      <strong style={{ fontSize: '1rem', fontFamily: 'monospace', color: 'var(--text-primary)' }}>
                        {t.tokenCode}
                      </strong>
                    </div>

                    <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                      ~{t.waitEstimateMinutes || 5} min
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Confirmation Modal for Skip */}
      {confirmSkipModal && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0, 0, 0, 0.75)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
            backdropFilter: 'blur(4px)',
          }}
        >
          <div
            style={{
              background: '#0D1422',
              border: '1px solid var(--border-subtle)',
              borderRadius: '16px',
              padding: '28px',
              maxWidth: '420px',
              width: '90%',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '16px' }}>
              <div
                style={{
                  width: '40px',
                  height: '40px',
                  borderRadius: '10px',
                  background: 'rgba(239, 68, 68, 0.15)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <AlertTriangle size={20} color="#EF4444" />
              </div>
              <h3 style={{ margin: 0, fontSize: '1.2rem', color: 'var(--text-primary)' }}>Confirm Skip Token</h3>
            </div>

            <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', lineHeight: 1.5, marginBottom: '24px' }}>
              Are you sure you want to skip token <strong>{currentToken?.tokenCode}</strong>? This will remove the token from active serving and notify the customer.
            </p>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
              <button
                onClick={() => setConfirmSkipModal(false)}
                className="btn btn-outline"
                style={{ padding: '8px 16px' }}
              >
                Cancel
              </button>
              <button
                onClick={handleSkip}
                className="btn"
                style={{ padding: '8px 16px', background: '#EF4444', color: '#fff', fontWeight: 600 }}
              >
                Yes, Skip Token
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
