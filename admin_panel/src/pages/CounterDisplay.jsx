import React, { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { counterAPI } from '../services/api';
import { getSocket, joinCounterRoom, leaveCounterRoom, joinCenterRoom, leaveCenterRoom } from '../services/socket';
import { Maximize2, Minimize2, Radio } from 'lucide-react';

export default function CounterDisplay() {
  const { id } = useParams();
  const [counter, setCounter] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [lastUpdated, setLastUpdated] = useState(Date.now());
  const [socketStatus, setSocketStatus] = useState(() => {
    const s = getSocket();
    return s.connected ? 'CONNECTED' : 'CONNECTING';
  });

  // Track socket connection state for real-time indicator
  useEffect(() => {
    const socket = getSocket();
    const handleConnect = () => setSocketStatus('CONNECTED');
    const handleDisconnect = () => setSocketStatus('DISCONNECTED');
    const handleConnectError = () => setSocketStatus('DISCONNECTED');

    if (socket.connected) {
      setSocketStatus('CONNECTED');
    }

    socket.on('connect', handleConnect);
    socket.on('disconnect', handleDisconnect);
    socket.on('connect_error', handleConnectError);

    return () => {
      socket.off('connect', handleConnect);
      socket.off('disconnect', handleDisconnect);
      socket.off('connect_error', handleConnectError);
    };
  }, []);

  // Load initial counter details
  useEffect(() => {
    async function loadCounter() {
      try {
        setError(null);
        const res = await counterAPI.getById(id);
        if (res.success && res.data?.counter) {
          setCounter(res.data.counter);
        }
      } catch (err) {
        console.error('Failed to load counter:', err);
        setError(err.message || 'Counter not found');
      } finally {
        setLoading(false);
      }
    }
    loadCounter();
  }, [id]);

  // Socket room joining and real-time updates
  useEffect(() => {
    if (!counter?._id || !counter?.centerId) return;

    const socket = getSocket();
    const centerId = typeof counter.centerId === 'object' ? counter.centerId._id : counter.centerId;
    joinCenterRoom(centerId);
    joinCounterRoom(centerId, counter._id);

    const isCounterMatch = (counterObj, targetCounterId) => {
      if (!counterObj || !targetCounterId) return false;
      const cid = counterObj._id?.toString() || counterObj.id?.toString() || (typeof counterObj === 'string' ? counterObj : null);
      return cid === targetCounterId.toString();
    };

    const isTokenMatch = (prevCounter, token) => {
      if (!token || !prevCounter) return false;
      const curId = prevCounter.currentTokenId?._id?.toString() || (typeof prevCounter.currentTokenId === 'string' ? prevCounter.currentTokenId : null);
      const targetId = token._id?.toString() || token.id?.toString();
      const tokenCounterId = token.counterId?._id?.toString() || token.counterId?.toString();
      return (tokenCounterId && tokenCounterId === prevCounter._id.toString()) || (curId && curId === targetId);
    };

    function handleCounterUpdate(data) {
      if (data.counter && isCounterMatch(data.counter, counter._id)) {
        setCounter((prev) => ({ ...prev, ...data.counter }));
        setLastUpdated(Date.now());
      }
    }

    function handleTokenCalled(data) {
      if (data.counter && isCounterMatch(data.counter, counter._id)) {
        setCounter((prev) => ({
          ...prev,
          ...data.counter,
          currentTokenId: data.token,
          status: 'ACTIVE',
        }));
        setLastUpdated(Date.now());
      }
    }

    function handleTokenServing(data) {
      setCounter((prev) => {
        if (!prev) return prev;
        if (isTokenMatch(prev, data.token)) {
          setLastUpdated(Date.now());
          return {
            ...prev,
            currentTokenId: data.token,
            status: 'ACTIVE',
          };
        }
        return prev;
      });
    }

    function handleTokenCompleted(data) {
      setCounter((prev) => {
        if (!prev) return prev;
        if (isCounterMatch(data.counter, prev._id) || isTokenMatch(prev, data.token)) {
          setLastUpdated(Date.now());
          return {
            ...prev,
            ...(data.counter || {}),
            currentTokenId: null,
          };
        }
        return prev;
      });
    }

    function handleTokenSkipped(data) {
      setCounter((prev) => {
        if (!prev) return prev;
        if (isTokenMatch(prev, data.token)) {
          setLastUpdated(Date.now());
          return {
            ...prev,
            currentTokenId: null,
          };
        }
        return prev;
      });
    }

    function handleTokenCancelled(data) {
      setCounter((prev) => {
        if (!prev) return prev;
        if (isTokenMatch(prev, data.token)) {
          setLastUpdated(Date.now());
          return {
            ...prev,
            currentTokenId: null,
          };
        }
        return prev;
      });
    }

    function handleTokenExpired(data) {
      setCounter((prev) => {
        if (!prev) return prev;
        if (isTokenMatch(prev, data.token)) {
          setLastUpdated(Date.now());
          return {
            ...prev,
            currentTokenId: null,
          };
        }
        return prev;
      });
    }

    socket.on('counter.updated', handleCounterUpdate);
    socket.on('token.called', handleTokenCalled);
    socket.on('token.serving', handleTokenServing);
    socket.on('token.completed', handleTokenCompleted);
    socket.on('token.skipped', handleTokenSkipped);
    socket.on('token.cancelled', handleTokenCancelled);
    socket.on('token.expired', handleTokenExpired);

    return () => {
      leaveCounterRoom(centerId, counter._id);
      leaveCenterRoom(centerId);
      socket.off('counter.updated', handleCounterUpdate);
      socket.off('token.called', handleTokenCalled);
      socket.off('token.serving', handleTokenServing);
      socket.off('token.completed', handleTokenCompleted);
      socket.off('token.skipped', handleTokenSkipped);
      socket.off('token.cancelled', handleTokenCancelled);
      socket.off('token.expired', handleTokenExpired);
    };
  }, [counter?._id, counter?.centerId]);

  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {});
      setIsFullscreen(true);
    } else {
      document.exitFullscreen().catch(() => {});
      setIsFullscreen(false);
    }
  };

  if (loading) {
    return (
      <div style={{ minHeight: '100vh', background: '#0a0d0b', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#ffffff' }}>
        <p style={{ fontFamily: 'var(--font-main)', fontSize: '18px' }}>Connecting display to counter...</p>
      </div>
    );
  }

  if (error || !counter) {
    return (
      <div style={{ minHeight: '100vh', background: '#0a0d0b', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: '#ffffff', padding: '24px' }}>
        <h2 style={{ fontSize: '24px', fontWeight: 700, color: '#ef4444', marginBottom: '8px' }}>Display Error</h2>
        <p style={{ color: '#a8a29e' }}>{error || 'Counter could not be loaded'}</p>
      </div>
    );
  }

  const currentToken = counter.currentTokenId;
  const tokenCode = currentToken?.tokenCode || (typeof currentToken === 'string' ? currentToken : null);
  const isServing = !!tokenCode && counter.status === 'ACTIVE';

  const statusColor = socketStatus === 'CONNECTED' ? '#00E5A8' : socketStatus === 'CONNECTING' ? '#F59E0B' : '#EF4444';
  const statusLabel = socketStatus === 'CONNECTED' ? 'ONLINE' : socketStatus === 'CONNECTING' ? 'CONNECTING' : 'OFFLINE / RECONNECTING';

  return (
    <div
      style={{
        minHeight: '100vh',
        background: '#05070D',
        color: '#F8FAFC',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        padding: '36px 48px',
        position: 'relative',
        userSelect: 'none',
        overflow: 'hidden',
      }}
    >
      {/* Real-time synchronization offline notice */}
      {socketStatus !== 'CONNECTED' && (
        <div
          style={{
            position: 'absolute',
            top: '20px',
            left: '50%',
            transform: 'translateX(-50%)',
            background: 'rgba(239, 68, 68, 0.15)',
            border: '1px solid rgba(239, 68, 68, 0.35)',
            color: '#FCA5A5',
            padding: '6px 16px',
            borderRadius: '10px',
            fontSize: '12px',
            fontFamily: 'var(--font-mono)',
            zIndex: 30,
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
          }}
        >
          <span>⚠️ Real-time synchronization unavailable. Reconnecting...</span>
        </div>
      )}

      {/* Background radial glow */}
      <div
        style={{
          position: 'absolute',
          top: '40%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          width: '650px',
          height: '650px',
          borderRadius: '50%',
          background: isServing
            ? 'radial-gradient(circle, rgba(0, 229, 168, 0.18) 0%, rgba(5, 7, 13, 0) 70%)'
            : 'radial-gradient(circle, rgba(0, 210, 255, 0.08) 0%, rgba(5, 7, 13, 0) 70%)',
          pointerEvents: 'none',
          transition: 'background 0.5s ease',
        }}
      />

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', zIndex: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          <div
            style={{
              padding: '6px 16px',
              borderRadius: '12px',
              background: 'rgba(0, 229, 168, 0.08)',
              border: '1px solid rgba(0, 229, 168, 0.25)',
              fontFamily: 'var(--font-mono)',
              fontSize: '14px',
              fontWeight: 700,
              color: '#00E5A8',
              letterSpacing: '0.05em',
            }}
          >
            {counter.displayLabel || counter.name || `COUNTER ${counter.number}`}
          </div>

          <span style={{ fontSize: '15px', color: 'rgba(255, 255, 255, 0.6)', fontWeight: 500 }}>
            {counter.serviceId?.name || '—'}
          </span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span className="pulsing-dot">
              <span className="pulsing-dot-ping" style={{ backgroundColor: statusColor }}></span>
              <span className="pulsing-dot-core" style={{ backgroundColor: statusColor }}></span>
            </span>
            <span className="mono" style={{ fontSize: '12px', fontWeight: 700, color: statusColor, letterSpacing: '0.05em' }}>
              {statusLabel}
            </span>
          </div>

          <button
            onClick={toggleFullscreen}
            style={{
              background: 'rgba(255, 255, 255, 0.08)',
              border: 'none',
              borderRadius: '10px',
              padding: '8px 12px',
              color: '#ffffff',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              fontSize: '12px',
              fontWeight: 600,
            }}
          >
            {isFullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
            <span>{isFullscreen ? 'Exit Fullscreen' : 'Fullscreen'}</span>
          </button>
        </div>
      </div>

      {/* Main Center Display Content */}
      <div style={{ textAlign: 'center', margin: 'auto 0', zIndex: 10 }}>
        <p
          className="mono"
          style={{
            fontSize: '18px',
            letterSpacing: '0.25em',
            color: 'rgba(255, 255, 255, 0.45)',
            textTransform: 'uppercase',
            marginBottom: '16px',
          }}
        >
          {counter.status === 'BREAK'
            ? 'COUNTER ON BREAK'
            : counter.status === 'CLOSED'
            ? 'COUNTER CLOSED'
            : isServing
            ? 'NOW CALLING / SERVING'
            : 'WAITING FOR NEXT CUSTOMER'}
        </p>

        {/* Large Token Code */}
        <div
          key={lastUpdated}
          style={{
            fontSize: 'clamp(72px, 16vw, 160px)',
            fontFamily: 'var(--font-mono)',
            fontWeight: 800,
            letterSpacing: '0.04em',
            color: isServing ? '#00E5A8' : 'rgba(255, 255, 255, 0.2)',
            textShadow: isServing ? '0 0 60px rgba(0, 229, 168, 0.5)' : 'none',
            lineHeight: 1,
            margin: '20px 0',
          }}
        >
          {tokenCode || '— — —'}
        </div>

        <p
          style={{
            fontSize: 'clamp(16px, 2.5vw, 24px)',
            fontWeight: 600,
            color: isServing ? '#00E5A8' : 'rgba(255, 255, 255, 0.4)',
            letterSpacing: '0.04em',
            textTransform: 'uppercase',
          }}
        >
          {isServing ? 'PLEASE PROCEED TO COUNTER' : 'PLEASE TAKE A SEAT'}
        </p>
      </div>

      {/* Bottom Footer */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          borderTop: '1px solid rgba(255, 255, 255, 0.08)',
          paddingTop: '20px',
          zIndex: 10,
          color: 'rgba(255, 255, 255, 0.35)',
          fontSize: '13px',
        }}
      >
        <span className="mono">QueueFlow Smart Display System</span>
        <span>Please have your QR code or identification ready</span>
      </div>
    </div>
  );
}
