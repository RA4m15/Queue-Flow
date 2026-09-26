import React from 'react';
import { Activity } from 'lucide-react';

const TAG_STYLES = {
  called: { bg: 'rgba(0, 210, 255, 0.12)', color: '#00D2FF', border: 'rgba(0, 210, 255, 0.3)' },
  done: { bg: 'rgba(0, 229, 168, 0.12)', color: '#00E5A8', border: 'rgba(0, 229, 168, 0.3)' },
  break: { bg: 'rgba(100, 116, 139, 0.18)', color: '#94A3B8', border: 'rgba(100, 116, 139, 0.3)' },
  skip: { bg: 'rgba(239, 68, 68, 0.14)', color: '#EF4444', border: 'rgba(239, 68, 68, 0.3)' },
  waiting: { bg: 'rgba(245, 158, 11, 0.14)', color: '#FBBF24', border: 'rgba(245, 158, 11, 0.3)' },
  serving: { bg: 'rgba(0, 229, 168, 0.16)', color: '#00E5A8', border: 'rgba(0, 229, 168, 0.4)' },
  info: { bg: 'rgba(100, 116, 139, 0.12)', color: '#94A3B8', border: 'rgba(100, 116, 139, 0.2)' },
};

export default function LiveLog({ log = [] }) {
  return (
    <div style={{ marginBottom: '24px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' }}>
        <p className="mono" style={{ fontSize: '10px', letterSpacing: '0.1em', color: '#64748B', textTransform: 'uppercase' }}>
          LIVE ACTIVITY STREAM
        </p>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <span className="pulsing-dot">
            <span className="pulsing-dot-ping" style={{ backgroundColor: '#00E5A8' }} />
            <span className="pulsing-dot-core" style={{ backgroundColor: '#00E5A8' }} />
          </span>
          <span className="mono" style={{ fontSize: '10px', color: '#00E5A8', fontWeight: 700 }}>
            REALTIME
          </span>
        </div>
      </div>

      <div
        className="q-card"
        style={{
          overflow: 'hidden',
          background: 'rgba(13, 20, 34, 0.8)',
          border: '1px solid var(--border-subtle)',
          maxHeight: '340px',
          overflowY: 'auto',
        }}
      >
        {log.length === 0 ? (
          <div style={{ padding: '28px', textAlign: 'center', color: '#64748B', fontSize: '13px' }}>
            No recent queue activity recorded yet.
          </div>
        ) : (
          log.map((item, i) => {
            const style = TAG_STYLES[item.tag] || TAG_STYLES.info;
            return (
              <div
                key={item.id || i}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '12px',
                  padding: '11px 16px',
                  borderBottom: i < log.length - 1 ? '1px solid var(--border-subtle)' : 'none',
                  transition: 'background 0.15s ease',
                }}
              >
                <span className="mono" style={{ fontSize: '11px', color: '#64748B', width: '42px', flexShrink: 0 }}>
                  {item.t}
                </span>

                <span
                  className="mono"
                  style={{
                    fontSize: '9px',
                    padding: '2px 7px',
                    borderRadius: '6px',
                    fontWeight: 700,
                    flexShrink: 0,
                    background: style.bg,
                    color: style.color,
                    border: `1px solid ${style.border}`,
                    letterSpacing: '0.04em',
                  }}
                >
                  {(item.tag || 'INFO').toUpperCase()}
                </span>

                <span style={{ fontSize: '13px', color: '#F1F5F9', lineHeight: 1.4, flex: 1 }}>
                  {item.event}
                </span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
