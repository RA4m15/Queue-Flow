import React from 'react';
import { ExternalLink, Settings, Play, CheckCircle2, SkipForward, Coffee } from 'lucide-react';

export default function CounterCard({
  counter,
  onCallNext,
  onStartServing,
  onComplete,
  onSkip,
  onUpdateStatus,
  onOpenAssign,
  isLoading = false,
}) {
  const isBreak = counter.status === 'BREAK';
  const isClosed = counter.status === 'CLOSED';
  const isActive = counter.status === 'ACTIVE';

  const currentToken = counter.currentTokenId;
  const currentTokenCode = currentToken?.tokenCode || (typeof currentToken === 'string' ? currentToken : '—');
  const tokenStatus = currentToken?.status || null;

  const servedCount = counter.stats?.served || 0;
  const serviceName = counter.serviceId?.name || 'Unassigned';

  const handleToggleBreak = () => {
    const nextStatus = isActive ? 'BREAK' : 'ACTIVE';
    onUpdateStatus(counter._id, nextStatus);
  };

  const handleToggleClosed = () => {
    const nextStatus = isClosed ? 'ACTIVE' : 'CLOSED';
    onUpdateStatus(counter._id, nextStatus);
  };

  const isServing = currentTokenCode !== '—' && isActive;

  return (
    <div
      className="q-card"
      style={{
        overflow: 'hidden',
        border: isServing
          ? '1px solid rgba(0, 229, 168, 0.4)'
          : isBreak
          ? '1px solid rgba(245, 158, 11, 0.3)'
          : isClosed
          ? '1px solid rgba(100, 116, 139, 0.25)'
          : '1px solid var(--border-subtle)',
        boxShadow: isServing ? '0 0 20px rgba(0, 229, 168, 0.12)' : 'var(--shadow-sm)',
        background: isServing
          ? 'linear-gradient(135deg, rgba(17, 27, 44, 0.85) 0%, rgba(13, 20, 34, 0.75) 100%)'
          : 'var(--bg-card)',
      }}
    >
      {/* Card Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '14px 18px',
          borderBottom: '1px solid var(--border-subtle)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div
            className="mono"
            style={{
              width: '36px',
              height: '36px',
              borderRadius: '10px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontWeight: 800,
              fontSize: '14px',
              background: isActive ? 'rgba(0, 229, 168, 0.12)' : 'rgba(255, 255, 255, 0.05)',
              color: isActive ? '#00E5A8' : '#64748B',
              border: isActive ? '1px solid rgba(0, 229, 168, 0.25)' : '1px solid var(--border-subtle)',
            }}
          >
            {counter.number ?? '—'}
          </div>

          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <p style={{ fontWeight: 700, fontSize: '15px', color: '#F8FAFC', lineHeight: 1.2 }}>
                {counter.name}
              </p>
              <a
                href={`/counter/${counter._id}`}
                target="_blank"
                rel="noreferrer"
                style={{ color: '#64748B', display: 'flex', alignItems: 'center', transition: 'color 0.15s ease' }}
                title="Open fullscreen display board"
                onMouseEnter={(e) => (e.currentTarget.style.color = '#00E5A8')}
                onMouseLeave={(e) => (e.currentTarget.style.color = '#64748B')}
              >
                <ExternalLink size={13} />
              </a>
            </div>
            <p style={{ fontSize: '12px', color: '#94A3B8', marginTop: '2px' }}>
              {serviceName} • {servedCount} served today
            </p>
          </div>
        </div>

        {/* Status Pill & Settings */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <button
            onClick={() => onOpenAssign(counter)}
            className="btn-secondary"
            style={{ padding: '6px', borderRadius: '8px' }}
            title="Reassign Service"
          >
            <Settings size={13} />
          </button>

          <span
            className="badge"
            style={{
              fontSize: '10px',
              background: isActive
                ? 'rgba(0, 229, 168, 0.12)'
                : isBreak
                ? 'rgba(245, 158, 11, 0.15)'
                : 'rgba(100, 116, 139, 0.15)',
              color: isActive ? '#00E5A8' : isBreak ? '#FBBF24' : '#94A3B8',
              borderColor: isActive
                ? 'rgba(0, 229, 168, 0.3)'
                : isBreak
                ? 'rgba(245, 158, 11, 0.3)'
                : 'rgba(100, 116, 139, 0.25)',
            }}
          >
            {counter.status}
          </span>
        </div>
      </div>

      {/* Serving Area */}
      <div
        style={{
          padding: '16px 18px',
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '16px',
        }}
      >
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
            <p className="mono" style={{ fontSize: '10px', color: '#64748B', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
              NOW SERVING
            </p>
            {tokenStatus && (
              <span
                className={`badge badge-${tokenStatus.toLowerCase()}`}
                style={{ fontSize: '9px', padding: '1px 6px' }}
              >
                {tokenStatus}
              </span>
            )}
          </div>
          <p
            className="mono"
            style={{
              fontSize: '28px',
              fontWeight: 800,
              color: isServing ? '#00E5A8' : '#64748B',
              lineHeight: 1,
              textShadow: isServing ? '0 0 18px rgba(0, 229, 168, 0.3)' : 'none',
            }}
          >
            {currentTokenCode}
          </p>
        </div>

        {/* Dynamic Action Buttons based on Token Lifecycle */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', justifyContent: 'flex-end' }}>
          {/* If a token is currently CALLED -> offer Start Serving or Skip */}
          {tokenStatus === 'CALLED' && (
            <>
              <button
                onClick={() => onStartServing(counter._id)}
                disabled={isLoading}
                className="btn-primary"
                style={{ padding: '7px 14px', fontSize: '12px' }}
                title="Customer has arrived at counter"
              >
                <Play size={13} />
                <span>Start Serving</span>
              </button>
              <button
                onClick={() => onSkip(counter._id, currentToken?._id)}
                disabled={isLoading}
                className="btn-danger"
                style={{ padding: '7px 12px', fontSize: '12px' }}
                title="Customer did not arrive"
              >
                <SkipForward size={13} />
                <span>Skip</span>
              </button>
            </>
          )}

          {/* If a token is currently SERVING -> offer Complete or Skip */}
          {tokenStatus === 'SERVING' && (
            <>
              <button
                onClick={() => onComplete(counter._id)}
                disabled={isLoading}
                className="btn-success"
                style={{ padding: '7px 16px', fontSize: '12px' }}
                title="Finish service"
              >
                <CheckCircle2 size={14} />
                <span>Complete</span>
              </button>
              <button
                onClick={() => onSkip(counter._id, currentToken?._id)}
                disabled={isLoading}
                className="btn-danger"
                style={{ padding: '7px 10px', fontSize: '12px' }}
                title="Abandon / Skip"
              >
                <SkipForward size={13} />
              </button>
            </>
          )}

          {/* If no active token or counter is idle -> Call Next */}
          {(!currentToken || currentTokenCode === '—') && (
            <button
              onClick={() => onCallNext(counter._id)}
              disabled={isLoading || !isActive || !counter.serviceId}
              className="btn-primary"
              style={{ padding: '8px 18px', fontSize: '12px' }}
            >
              <span>Call Next →</span>
            </button>
          )}

          {/* Break / Active switch */}
          {!isClosed && (
            <button
              onClick={handleToggleBreak}
              disabled={isLoading}
              className="btn-secondary"
              style={{ padding: '7px 12px', fontSize: '12px' }}
              title={isActive ? 'Put counter on break' : 'Resume counter from break'}
            >
              <Coffee size={13} />
              <span>{isActive ? 'Break' : 'Resume'}</span>
            </button>
          )}

          {/* Close / Open toggle */}
          <button
            onClick={handleToggleClosed}
            disabled={isLoading}
            className="btn-secondary"
            style={{ padding: '7px 10px', fontSize: '12px' }}
            title={isClosed ? 'Open Counter' : 'Close Counter'}
          >
            <span style={{ fontSize: '11px' }}>{isClosed ? 'Open' : 'Close'}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
