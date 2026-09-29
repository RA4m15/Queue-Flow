import React, { useState } from 'react';
import { UserPlus, UserMinus, RotateCcw, Cpu } from 'lucide-react';

export default function CrowdWidget({ crowdData, onSimulate, onReset }) {
  const [simLoading, setSimLoading] = useState(false);
  const currentCrowd = crowdData?.currentCrowd;
  const isCrowdLoaded = typeof currentCrowd === 'number';
  const capacity = typeof crowdData?.capacity === 'number' && crowdData.capacity > 0 ? crowdData.capacity : null;
  const crowdPercent = capacity !== null && isCrowdLoaded
    ? (crowdData?.crowdPercent ?? Math.min(100, Math.round((currentCrowd / capacity) * 100)))
    : null;

  const statusColor = (crowdPercent ?? 0) >= 80 ? '#EF4444' : (crowdPercent ?? 0) >= 50 ? '#F59E0B' : '#00E5A8';

  const handleSimulate = async (type) => {
    if (!onSimulate) return;
    setSimLoading(true);
    try {
      await onSimulate(type, 1);
    } finally {
      setSimLoading(false);
    }
  };

  const handleReset = async () => {
    if (!onReset || !window.confirm('Reset current crowd count to 0?')) return;
    setSimLoading(true);
    try {
      await onReset();
    } finally {
      setSimLoading(false);
    }
  };

  return (
    <div
      className="q-card"
      style={{
        background: 'linear-gradient(135deg, rgba(13, 20, 34, 0.85) 0%, rgba(8, 14, 25, 0.8) 100%)',
        border: '1px solid rgba(0, 210, 255, 0.22)',
        borderRadius: '18px',
        padding: '18px 22px',
        marginBottom: '24px',
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '20px',
        boxShadow: '0 4px 20px rgba(0, 0, 0, 0.4), inset 0 0 15px rgba(0, 210, 255, 0.03)',
      }}
    >
      {/* Sensor Info */}
      <div style={{ flex: '1', minWidth: '240px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
          <span className="pulsing-dot">
            <span className="pulsing-dot-ping" style={{ backgroundColor: '#00D2FF' }} />
            <span className="pulsing-dot-core" style={{ backgroundColor: '#00D2FF' }} />
          </span>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <Cpu size={14} color="#00D2FF" />
            <p className="mono" style={{ fontSize: '11px', fontWeight: 700, color: '#00D2FF', letterSpacing: '0.05em' }}>
              IOT LIVE FOOTFALL SENSOR
            </p>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px' }}>
          {isCrowdLoaded ? (
            <>
              <span
                className="mono"
                style={{
                  fontSize: '28px',
                  fontWeight: 800,
                  color: '#F8FAFC',
                  letterSpacing: '-0.02em',
                }}
              >
                {currentCrowd}
              </span>
              <span style={{ fontSize: '13px', color: '#94A3B8' }}>
                people on premises right now
              </span>
            </>
          ) : (
            <span style={{ fontSize: '14px', fontWeight: 600, color: '#64748B' }}>
              Connecting to IoT sensors...
            </span>
          )}
        </div>
      </div>

      {/* Capacity Progress Bar */}
      <div style={{ minWidth: '180px', textAlign: 'right' }}>
        {!isCrowdLoaded ? (
          <p className="mono" style={{ fontSize: '11px', color: '#64748B' }}>
            Loading telemetry...
          </p>
        ) : capacity !== null && crowdPercent !== null ? (
          <>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
              <span className="mono" style={{ fontSize: '10px', color: '#94A3B8', letterSpacing: '0.04em' }}>
                OCCUPANCY GAUGE
              </span>
              <span className="mono" style={{ fontSize: '11px', fontWeight: 700, color: statusColor }}>
                {crowdPercent}% ({crowdData?.crowdStatus || 'NORMAL'})
              </span>
            </div>

            <div
              style={{
                width: '180px',
                height: '8px',
                borderRadius: '9999px',
                background: 'rgba(255, 255, 255, 0.08)',
                overflow: 'hidden',
                margin: '0 0 4px auto',
              }}
            >
              <div
                style={{
                  height: '100%',
                  borderRadius: '9999px',
                  width: `${Math.min(100, crowdPercent ?? 0)}%`,
                  background: `linear-gradient(90deg, #00E5A8 0%, ${statusColor} 100%)`,
                  boxShadow: `0 0 10px ${statusColor}60`,
                  transition: 'width 0.5s ease',
                }}
              />
            </div>
            <p className="mono" style={{ fontSize: '10px', color: '#64748B' }}>
              Capacity limit: {capacity} max
            </p>
          </>
        ) : (
          <p className="mono" style={{ fontSize: '11px', color: '#64748B' }}>
            Facility capacity unconfigured
          </p>
        )}
      </div>

      {/* Dev Simulator Controls */}
      {import.meta.env.DEV && onSimulate && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', borderLeft: '1px solid var(--border-subtle)', paddingLeft: '16px' }}>
          <button
            onClick={() => handleSimulate('ENTRY')}
            disabled={simLoading}
            className="btn-secondary"
            style={{ padding: '6px 12px', fontSize: '11px', gap: '5px' }}
            title="Simulate 1 IoT Entry"
          >
            <UserPlus size={13} color="#00E5A8" />
            <span>+ Entry</span>
          </button>
          <button
            onClick={() => handleSimulate('EXIT')}
            disabled={simLoading || currentCrowd === 0}
            className="btn-secondary"
            style={{ padding: '6px 12px', fontSize: '11px', gap: '5px' }}
            title="Simulate 1 IoT Exit"
          >
            <UserMinus size={13} color="#EF4444" />
            <span>- Exit</span>
          </button>
          <button
            onClick={handleReset}
            disabled={simLoading || currentCrowd === 0}
            className="btn-secondary"
            style={{ padding: '6px 10px', fontSize: '11px' }}
            title="Reset crowd count"
          >
            <RotateCcw size={13} />
          </button>
        </div>
      )}
    </div>
  );
}
