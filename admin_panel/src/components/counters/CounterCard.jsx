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
      className="counter-card"
      data-status={isServing ? 'serving' : isBreak ? 'break' : isClosed ? 'closed' : 'active'}
    >
      {/* Header: identity + live status */}
      <div className="counter-card-head">
        <div className="counter-identity">
          <span
            className="counter-num mono"
            style={isActive ? undefined : { color: 'var(--text-muted)' }}
          >
            {String(counter.number ?? '—').padStart(2, '0')}
          </span>

          <div className="counter-id-text">
            <div className="counter-name-row">
              <p className="counter-name">{counter.name}</p>
              <a
                href={`/counter/${counter._id}`}
                target="_blank"
                rel="noreferrer"
                className="counter-open-link"
                title="Open fullscreen display board"
                aria-label={`Open fullscreen display board for ${counter.name}`}
              >
                <ExternalLink size={13} />
              </a>
            </div>
            <p className="counter-meta">
              {serviceName}
              <span className="counter-meta-sep">&middot;</span>
              {servedCount} served today
            </p>
          </div>
        </div>

        <div className="counter-head-actions">
          <span
            className="counter-state"
            style={{
              color: isActive ? 'var(--color-primary)' : isBreak ? 'var(--color-warning)' : 'var(--text-muted)',
            }}
          >
            <span
              className="counter-state-dot"
              style={{
                background: isActive ? 'var(--color-primary)' : isBreak ? 'var(--color-warning)' : 'var(--text-dim)',
              }}
            />
            {counter.status}
          </span>

          <button
            onClick={() => onOpenAssign(counter)}
            className="btn-secondary btn-icon"
            title="Reassign Service"
            aria-label={`Reassign service for ${counter.name}`}
          >
            <Settings size={14} />
          </button>
        </div>
      </div>

      {/* Now serving + lifecycle actions */}
      <div className="counter-card-body">
        <div className="counter-serving">
          <div className="counter-serving-head">
            <span className="eyebrow">Now serving</span>
            {tokenStatus && (
              <span className={`badge badge-${tokenStatus.toLowerCase()}`}>{tokenStatus}</span>
            )}
          </div>
          <p className="counter-token mono">{currentTokenCode}</p>
        </div>

        <div className="counter-actions">
          {/* CALLED -> Start Serving or Skip */}
          {tokenStatus === 'CALLED' && (
            <>
              <button
                onClick={() => onStartServing(counter._id)}
                disabled={isLoading}
                className="btn-primary btn-compact"
                title="Customer has arrived at counter"
              >
                <Play size={13} />
                <span>Start Serving</span>
              </button>
              <button
                onClick={() => onSkip(counter._id, currentToken?._id)}
                disabled={isLoading}
                className="btn-danger btn-compact"
                title="Customer did not arrive"
              >
                <SkipForward size={13} />
                <span>Skip</span>
              </button>
            </>
          )}

          {/* SERVING -> Complete or Skip */}
          {tokenStatus === 'SERVING' && (
            <>
              <button
                onClick={() => onComplete(counter._id)}
                disabled={isLoading}
                className="btn-success btn-compact"
                title="Finish service"
              >
                <CheckCircle2 size={14} />
                <span>Complete</span>
              </button>
              <button
                onClick={() => onSkip(counter._id, currentToken?._id)}
                disabled={isLoading}
                className="btn-danger btn-icon"
                title="Abandon / Skip"
                aria-label={`Skip current token at ${counter.name}`}
              >
                <SkipForward size={13} />
              </button>
            </>
          )}

          {/* Idle -> Call Next */}
          {(!currentToken || currentTokenCode === '\u2014') && (
            <button
              onClick={() => onCallNext(counter._id)}
              disabled={isLoading || !isActive || !counter.serviceId}
              className="btn-primary btn-compact"
            >
              <span>Call Next &rarr;</span>
            </button>
          )}

          {/* Break / Resume */}
          {!isClosed && (
            <button
              onClick={handleToggleBreak}
              disabled={isLoading}
              className="btn-secondary btn-compact"
              title={isActive ? 'Put counter on break' : 'Resume counter from break'}
            >
              <Coffee size={13} />
              <span>{isActive ? 'Break' : 'Resume'}</span>
            </button>
          )}

          {/* Close / Open */}
          <button
            onClick={handleToggleClosed}
            disabled={isLoading}
            className="btn-secondary btn-compact"
            title={isClosed ? 'Open Counter' : 'Close Counter'}
          >
            <span>{isClosed ? 'Open' : 'Close'}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
