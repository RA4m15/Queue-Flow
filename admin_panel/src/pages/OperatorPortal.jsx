import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useSocket } from '../context/SocketContext';
import useOperatorCounter from '../hooks/useOperatorCounter';
import LoadingSpinner from '../components/common/LoadingSpinner';
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
  ShieldAlert,
  LogOut,
  Building2,
  DoorOpen,
  X,
  UserCog,
  Activity,
} from 'lucide-react';

/** Status → colour ramp, shared by the counter badge and the status buttons. */
const STATUS_COLORS = {
  ACTIVE: 'var(--color-primary)',
  BREAK: 'var(--color-warning)',
  CLOSED: 'var(--color-danger)',
};

const STATUS_BUTTON = [
  { value: 'ACTIVE', label: 'ACTIVE', icon: Power },
  { value: 'BREAK', label: 'BREAK', icon: Coffee },
  { value: 'CLOSED', label: 'CLOSED', icon: PowerOff },
];

const card = {
  background: 'var(--bg-card)',
  border: '1px solid var(--border-subtle)',
  borderRadius: '14px',
};

function StatusBadge({ status }) {
  const color = STATUS_COLORS[status] || 'var(--text-secondary)';
  return (
    <span
      style={{
        fontSize: '0.72rem',
        fontWeight: 700,
        padding: '3px 10px',
        borderRadius: '12px',
        letterSpacing: '0.04em',
        background: `color-mix(in srgb, ${color} 15%, transparent)`,
        color,
        border: `1px solid color-mix(in srgb, ${color} 32%, transparent)`,
      }}
    >
      {status || 'UNKNOWN'}
    </span>
  );
}

export default function OperatorPortal() {
  const { user, logout } = useAuth();
  const { isConnected, on, activeCenterId, setActiveCenterId } = useSocket();
  const navigate = useNavigate();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [confirmSkip, setConfirmSkip] = useState(false);

  const op = useOperatorCounter({ centerId: activeCenterId, on, setActiveCenterId });

  const isAdmin = user?.role === 'ADMIN';
  const canChooseCounter = isAdmin || op.canSelectAnyCounter;

  const handleSignOut = () => {
    logout();
    navigate('/login');
  };

  const handleSkip = async () => {
    setConfirmSkip(false);
    await op.skip();
  };

  if (op.loading && !op.counter) {
    return <LoadingSpinner message="Loading counter state..." />;
  }

  // ── No facility selected ───────────────────────────────────────────────────
  if (!activeCenterId) {
    return (
      <div style={{ padding: '48px 24px', maxWidth: '760px', margin: '0 auto', textAlign: 'center', ...card }}>
        <Building2 size={44} color="var(--color-warning)" style={{ marginBottom: '12px' }} />
        <h2 style={{ fontSize: '1.3rem', color: 'var(--text-primary)', marginBottom: '8px' }}>
          No active facility selected
        </h2>
        <p style={{ color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: 20 }}>
          Pick the service center you are operating from the ACTIVE FACILITY selector above. Every counter,
          token and queue number on this panel comes from that facility only.
        </p>
        <button onClick={op.reload} className="btn btn-outline" style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <RefreshCw size={15} /> Retry
        </button>
      </div>
    );
  }

  // ── No counter selected / assigned ────────────────────────────────────────
  if (!op.counter) {
    const assignedHint = !isAdmin
      ? 'Your account has not been assigned to a counter in this facility by an administrator.'
      : 'Choose which counter in this facility you want to operate.';

    return (
      <div style={{ padding: '48px 24px', maxWidth: '760px', margin: '0 auto', textAlign: 'center', ...card }}>
        <ShieldAlert size={44} color="var(--color-warning)" style={{ marginBottom: '12px' }} />
        <h2 style={{ fontSize: '1.3rem', color: 'var(--text-primary)', marginBottom: '8px' }}>
          {isAdmin ? 'Choose a counter' : 'No assigned counter'}
        </h2>
        <p style={{ color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: 20 }}>
          {op.errorMessage || assignedHint}
        </p>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'center', flexWrap: 'wrap' }}>
          <button
            onClick={() => setPickerOpen(true)}
            className="btn btn-primary"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}
          >
            <DoorOpen size={16} /> CHOOSE COUNTER
          </button>
          <button onClick={op.reload} className="btn btn-outline" style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <RefreshCw size={15} /> Re-check assignment
          </button>
        </div>

        {pickerOpen && (
          <CounterPicker
            counters={op.operableCounters}
            loading={op.countersLoading}
            selectedId={op.selectedCounterId}
            onClose={() => setPickerOpen(false)}
            onSelect={async (id) => {
              setPickerOpen(false);
              await op.selectCounter(id);
            }}
          />
        )}
      </div>
    );
  }

  const { counter, center, service } = op;

  return (
    <div style={{ padding: '20px 24px', maxWidth: '1400px', margin: '0 auto' }}>
      {/* ── Top: facility, connection, identity, sign out ─────────────────── */}
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '14px',
          padding: '12px 18px',
          marginBottom: '14px',
          ...card,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '18px', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Building2 size={16} color="var(--color-primary)" />
            <div>
              <div style={{ fontSize: '9px', letterSpacing: '0.08em', color: 'var(--text-muted)', textTransform: 'uppercase' }}>
                Active Facility
              </div>
              <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)' }}>
                {center?.name || '—'}
                {center?.code ? ` (${center.code})` : ''}
              </div>
            </div>
          </div>

          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              padding: '5px 12px',
              borderRadius: '20px',
              background: isConnected
                ? 'color-mix(in srgb, var(--color-primary) 10%, transparent)'
                : 'color-mix(in srgb, var(--color-danger) 10%, transparent)',
              border: `1px solid ${isConnected ? 'color-mix(in srgb, var(--color-primary) 25%, transparent)' : 'color-mix(in srgb, var(--color-danger) 25%, transparent)'}`,
              fontSize: '0.72rem',
              fontWeight: 700,
              color: isConnected ? 'var(--color-primary)' : 'var(--color-danger)',
            }}
          >
            <Radio size={12} className={isConnected ? 'pulse' : ''} />
            {isConnected ? 'LIVE' : 'OFFLINE'}
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <UserCog size={15} color="var(--text-secondary)" />
            <div>
              <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-primary)', lineHeight: 1.2 }}>
                {user?.name || '—'}
              </div>
              <div style={{ fontSize: '9px', fontWeight: 700, letterSpacing: '0.06em', color: 'var(--color-primary)' }}>
                {user?.role || '—'}
              </div>
            </div>
          </div>
          <button
            onClick={handleSignOut}
            className="btn btn-outline"
            style={{ padding: '7px 12px', fontSize: '12px', display: 'flex', alignItems: 'center', gap: 6 }}
          >
            <LogOut size={13} color="var(--color-danger)" />
            <span style={{ color: 'var(--color-danger)' }}>Sign out</span>
          </button>
        </div>
      </div>

      {/* ── Counter header ─────────────────────────────────────────────────── */}
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '14px',
          padding: '14px 18px',
          marginBottom: '14px',
          ...card,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
          <h1 style={{ fontSize: '1.3rem', fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>
            {counter.name || `Counter ${counter.number}`}
          </h1>
          <StatusBadge status={counter.status} />
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '18px', flexWrap: 'wrap', fontSize: '0.82rem' }}>
          <span style={{ color: 'var(--text-secondary)' }}>
            Operator:{' '}
            <strong style={{ color: 'var(--text-primary)' }}>{counter.staffId?.name || 'Unassigned'}</strong>
          </span>
          <span style={{ color: 'var(--text-secondary)' }}>
            Facility: <strong style={{ color: 'var(--text-primary)' }}>{center?.name || '—'}</strong>
          </span>
          <span style={{ color: 'var(--text-secondary)' }}>
            Service:{' '}
            <strong style={{ color: 'var(--text-primary)' }}>{service?.name || 'Unassigned'}</strong>
          </span>

          {canChooseCounter ? (
            <button
              onClick={() => setPickerOpen(true)}
              className="btn btn-primary"
              style={{ padding: '8px 14px', fontSize: '0.8rem', display: 'flex', alignItems: 'center', gap: 7 }}
            >
              <DoorOpen size={14} /> CHOOSE COUNTER
            </button>
          ) : (
            <span
              title="Your account is bound to this counter by the backend"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '8px 12px',
                fontSize: '0.75rem',
                fontWeight: 600,
                color: 'var(--text-secondary)',
                background: 'var(--bg-card-alt)',
                border: '1px solid var(--border-subtle)',
                borderRadius: '10px',
              }}
            >
              <ShieldAlert size={13} /> Assigned counter — locked
            </span>
          )}

          <button
            onClick={op.reload}
            disabled={op.actionLoading}
            className="btn btn-outline"
            style={{ padding: '8px 12px', fontSize: '0.8rem', display: 'flex', alignItems: 'center', gap: 6 }}
            title="Refresh from backend"
          >
            <RefreshCw size={14} className={op.actionLoading ? 'spin' : ''} />
          </button>
        </div>
      </div>

      {/* ── Banners ────────────────────────────────────────────────────────── */}
      {op.errorMessage && (
        <div
          style={{
            background: 'color-mix(in srgb, var(--color-danger) 14%, transparent)',
            border: '1px solid color-mix(in srgb, var(--color-danger) 35%, transparent)',
            color: 'var(--color-danger)',
            padding: '10px 16px',
            borderRadius: '10px',
            marginBottom: '12px',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            fontSize: '0.88rem',
          }}
        >
          <AlertTriangle size={17} />
          <span>{op.errorMessage}</span>
        </div>
      )}

      {op.successMessage && (
        <div
          style={{
            background: 'color-mix(in srgb, var(--color-primary) 12%, transparent)',
            border: '1px solid color-mix(in srgb, var(--color-primary) 30%, transparent)',
            color: 'var(--color-primary)',
            padding: '10px 16px',
            borderRadius: '10px',
            marginBottom: '12px',
            display: 'flex',
            alignItems: 'flex-start',
            gap: 10,
            fontSize: '0.88rem',
          }}
        >
          <CheckCircle2 size={17} style={{ flexShrink: 0, marginTop: 2 }} />
          <div>
            <span>{op.successMessage}</span>
            {op.actionDetails.length > 0 && (
              <ul
                data-testid="call-next-details"
                style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: '0.8rem', color: 'var(--text-secondary)', lineHeight: 1.5 }}
              >
                {op.actionDetails.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      {/* ── Main: current customer + actions | Queue panel ─────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 340px', gap: '16px', alignItems: 'start' }}>
        {/* Current customer at counter */}
        <div style={{ padding: '28px 24px', textAlign: 'center', ...card }}>
          <div
            style={{
              fontSize: '0.78rem',
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
              color: 'var(--text-secondary)',
              marginBottom: 10,
            }}
          >
            Current Customer at Counter
          </div>

          {op.currentToken ? (
            <div>
              <div
                style={{
                  fontSize: '3.6rem',
                  fontWeight: 800,
                  letterSpacing: '-0.02em',
                  color: op.isServing ? 'var(--color-primary)' : 'var(--color-cyan)',
                  fontFamily: 'monospace',
                  lineHeight: 1.1,
                }}
              >
                {op.currentToken.tokenCode}
              </div>
              <div style={{ margin: '12px 0 6px' }}>
                <StatusBadge status={op.tokenStatus} />
              </div>
              {op.currentToken.calledAt && (
                <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
                  Called at {new Date(op.currentToken.calledAt).toLocaleTimeString()}
                  {op.currentToken.servingAt
                    ? ` • Serving since ${new Date(op.currentToken.servingAt).toLocaleTimeString()}`
                    : ''}
                </div>
              )}
            </div>
          ) : (
            <div style={{ padding: '24px 0' }}>
              <div style={{ fontSize: '2.6rem', fontWeight: 800, color: 'var(--text-disabled)' }}>IDLE</div>
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.88rem' }}>
                No customer is currently called at this counter.
              </p>
            </div>
          )}

          {/* Action buttons */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))',
              gap: '10px',
              marginTop: '20px',
              paddingTop: '18px',
              borderTop: '1px solid var(--border-subtle)',
            }}
          >
            <button
              onClick={op.callNext}
              disabled={op.actionLoading || !op.canCallNext}
              className="btn btn-primary"
              style={{
                padding: '13px 14px',
                fontWeight: 700,
                fontSize: '0.9rem',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
                opacity: op.canCallNext ? 1 : 0.45,
              }}
              title={callNextTooltip(op)}
            >
              <Play size={17} /> CALL NEXT
            </button>

            <button
              onClick={op.startServing}
              disabled={op.actionLoading || !op.canStartServing}
              className="btn"
              style={actionStyle(op.canStartServing, 'var(--color-primary)')}
            >
              <CheckCircle2 size={16} /> START SERVING
            </button>

            <button
              onClick={op.complete}
              disabled={op.actionLoading || !op.canComplete}
              className="btn"
              style={actionStyle(op.canComplete, 'var(--color-success)')}
            >
              <CheckCircle2 size={16} /> COMPLETE
            </button>

            <button
              onClick={() => setConfirmSkip(true)}
              disabled={op.actionLoading || !op.canSkip}
              className="btn"
              style={actionStyle(op.canSkip, 'var(--color-danger)')}
            >
              <SkipForward size={16} /> SKIP
            </button>

            <button
              onClick={op.recall}
              disabled={op.actionLoading || !op.canRecall}
              className="btn"
              style={actionStyle(op.canRecall, 'var(--color-cyan)')}
            >
              <RotateCcw size={16} /> RE-CALL
            </button>
          </div>
        </div>

        {/* Queue side panel */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
            <div style={{ padding: '16px 18px', ...card }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.68rem', color: 'var(--text-secondary)', letterSpacing: '0.05em' }}>
                <Users size={13} /> PEOPLE WAITING
              </div>
              <div style={{ fontSize: '1.9rem', fontWeight: 800, color: 'var(--text-primary)', marginTop: 4 }}>
                {op.waitingCount}
              </div>
            </div>
            <div style={{ padding: '16px 18px', ...card }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.68rem', color: 'var(--text-secondary)', letterSpacing: '0.05em' }}>
                <Clock size={13} /> EST WAIT
              </div>
              <div style={{ fontSize: '1.9rem', fontWeight: 800, color: 'var(--color-primary)', marginTop: 4 }}>
                {op.estimatedWaitMinutes === null ? '—' : `${op.estimatedWaitMinutes}m`}
              </div>
            </div>
          </div>

          <div style={{ padding: '18px', ...card }}>
            <div style={{ fontSize: '0.85rem', fontWeight: 700, color: 'var(--text-primary)', marginBottom: 12 }}>
              Next in Line ({op.waitingTokens.length})
            </div>

            {!op.hasService ? (
              <EmptyQueue message="This counter has no service assigned, so there is no queue to show." />
            ) : op.waitingTokens.length === 0 ? (
              <EmptyQueue message="No tokens waiting in this queue" />
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '7px' }}>
                {op.waitingTokens.map((t, idx) => (
                  <div
                    key={t._id || t.tokenCode}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '9px 12px',
                      background: 'var(--bg-card-alt)',
                      borderRadius: '8px',
                      border:
                        idx === 0
                          ? '1px solid color-mix(in srgb, var(--color-primary) 30%, transparent)'
                          : '1px solid var(--border-subtle)',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                      <span
                        style={{
                          width: '22px',
                          height: '22px',
                          borderRadius: '50%',
                          background:
                            idx === 0
                              ? 'color-mix(in srgb, var(--color-primary) 20%, transparent)'
                              : 'var(--bg-card-alt)',
                          color: idx === 0 ? 'var(--color-primary)' : 'var(--text-secondary)',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          fontSize: '0.7rem',
                          fontWeight: 700,
                        }}
                      >
                        {idx + 1}
                      </span>
                      <strong style={{ fontSize: '0.95rem', fontFamily: 'monospace', color: 'var(--text-primary)' }}>
                        {t.tokenCode}
                      </strong>
                    </div>
                    <span style={{ fontSize: '0.72rem', color: 'var(--text-secondary)' }}>
                      {t.waitEstimateMinutes === null || t.waitEstimateMinutes === undefined
                        ? '—'
                        : `~${t.waitEstimateMinutes} min`}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Bottom: counter operating state ─────────────────────────────────── */}
      <div
        style={{
          marginTop: '16px',
          padding: '14px 18px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '14px',
          flexWrap: 'wrap',
          ...card,
        }}
      >
        <div>
          <div style={{ fontWeight: 600, color: 'var(--text-primary)', fontSize: '0.9rem' }}>
            Counter Operating State
          </div>
          <div style={{ fontSize: '0.76rem', color: 'var(--text-secondary)' }}>
            {op.isClosed
              ? 'Counter is closed — token actions are disabled'
              : op.isBreak
              ? 'Counter is on break — token actions are disabled'
              : 'Counter is active and accepting customers'}
          </div>
        </div>
        <div style={{ display: 'flex', gap: '8px' }}>
          {STATUS_BUTTON.map(({ value, label, icon: Icon }) => {
            const active = op.counterStatus === value;
            const color = STATUS_COLORS[value];
            return (
              <button
                key={value}
                onClick={() => op.setCounterStatus(value)}
                disabled={op.actionLoading || active}
                className="btn"
                style={{
                  padding: '8px 14px',
                  fontSize: '0.78rem',
                  fontWeight: 600,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  background: active ? `color-mix(in srgb, ${color} 20%, transparent)` : 'var(--bg-card-alt)',
                  color: active ? color : 'var(--text-secondary)',
                  border: active ? `1px solid ${color}` : '1px solid var(--border-subtle)',
                }}
              >
                <Icon size={14} /> {label}
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Modals ─────────────────────────────────────────────────────────── */}
      {pickerOpen && (
        <CounterPicker
          counters={op.operableCounters}
          loading={op.countersLoading}
          selectedId={op.selectedCounterId}
          onClose={() => setPickerOpen(false)}
          onSelect={async (id) => {
            setPickerOpen(false);
            await op.selectCounter(id);
          }}
        />
      )}

      {confirmSkip && (
        <Modal title="Confirm skip" onClose={() => setConfirmSkip(false)}>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.88rem', lineHeight: 1.6, marginBottom: 20 }}>
            Skip token <strong>{op.currentToken?.tokenCode}</strong>? The customer is notified and the next
            waiting token becomes available.
          </p>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
            <button onClick={() => setConfirmSkip(false)} className="btn btn-outline" style={{ padding: '8px 16px' }}>
              Cancel
            </button>
            <button
              onClick={handleSkip}
              className="btn"
              style={{ padding: '8px 16px', background: 'var(--color-danger)', color: '#fff', fontWeight: 600 }}
            >
              Yes, skip token
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function EmptyQueue({ message }) {
  return (
    <div style={{ padding: '22px 0', textAlign: 'center', color: 'var(--text-secondary)' }}>
      <Layers size={26} color="var(--text-disabled)" style={{ marginBottom: 6 }} />
      <p style={{ margin: 0, fontSize: '0.82rem' }}>{message}</p>
    </div>
  );
}

function actionStyle(enabled, color) {
  return {
    padding: '13px 14px',
    fontWeight: 600,
    fontSize: '0.85rem',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    background: enabled ? `color-mix(in srgb, ${color} 18%, transparent)` : 'var(--bg-card-alt)',
    color: enabled ? color : 'var(--text-disabled)',
    border: enabled ? `1px solid color-mix(in srgb, ${color} 38%, transparent)` : '1px solid var(--border-subtle)',
    opacity: enabled ? 1 : 0.6,
  };
}

/** Explain, in the button tooltip, exactly why CALL NEXT is unavailable. */
function callNextTooltip(op) {
  if (!op.hasService) return 'This counter has no service assigned';
  if (op.isClosed) return 'Counter is CLOSED';
  if (op.isBreak) return 'Counter is on BREAK';
  if (op.hasToken) return `Already handling token ${op.currentToken?.tokenCode}`;
  if (op.waitingCount === 0) return 'No customers waiting in this queue';
  return 'Call the next waiting customer to this counter';
}

function Modal({ title, children, onClose }) {
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.72)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
        backdropFilter: 'blur(4px)',
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ ...card, padding: 24, maxWidth: 460, width: '90%' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
          <h3 style={{ margin: 0, fontSize: '1.1rem', color: 'var(--text-primary)' }}>{title}</h3>
          <button onClick={onClose} className="btn btn-outline" style={{ padding: '5px 9px' }} aria-label="Close">
            <X size={15} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/**
 * The "CHOOSE COUNTER" picker.
 *
 * Every row is a real counter document returned by
 * `GET /api/counters/operable?centerId=…` for the currently selected facility.
 * Nothing here is a hardcoded list, and a counter can only be picked when the
 * backend says `canOperate` for the calling user.
 */
function CounterPicker({ counters, loading, selectedId, onSelect, onClose }) {
  return (
    <Modal title="Choose counter" onClose={onClose}>
      {loading ? (
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.88rem', margin: 0 }}>Loading counters…</p>
      ) : !counters || counters.length === 0 ? (
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.88rem', margin: 0 }}>
          This facility has no counters yet.
        </p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: '52vh', overflowY: 'auto' }}>
          {counters.map((c) => {
            const isSelected = String(c._id) === String(selectedId);
            const disabled = c.canOperate === false;
            return (
              <button
                key={c._id}
                onClick={() => !disabled && onSelect(c._id)}
                disabled={disabled}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 12,
                  padding: '11px 14px',
                  textAlign: 'left',
                  borderRadius: '10px',
                  cursor: disabled ? 'not-allowed' : 'pointer',
                  opacity: disabled ? 0.5 : 1,
                  background: isSelected
                    ? 'color-mix(in srgb, var(--color-primary) 12%, transparent)'
                    : 'var(--bg-card-alt)',
                  border: isSelected ? '1px solid var(--color-primary)' : '1px solid var(--border-subtle)',
                  color: 'var(--text-primary)',
                }}
              >
                <div>
                  <div style={{ fontWeight: 700, fontSize: '0.9rem' }}>
                    {c.name}
                    {c.number ? ` · #${c.number}` : ''}
                  </div>
                  <div style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', marginTop: 2 }}>
                    {c.service?.name || 'No service assigned'}
                    {c.operator ? ` · ${c.operator.name}` : ' · Unassigned'}
                    {c.currentToken ? ` · now: ${c.currentToken.tokenCode}` : ''}
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <StatusBadge status={c.status} />
                  {c.isAssignedToCaller && (
                    <span style={{ fontSize: '0.65rem', color: 'var(--color-primary)', fontWeight: 700 }}>
                      YOURS
                    </span>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      )}
    </Modal>
  );
}
