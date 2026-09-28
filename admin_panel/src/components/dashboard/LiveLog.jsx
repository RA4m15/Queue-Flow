import React from 'react';
import { Activity } from 'lucide-react';

const TAG_STYLES = {
  called: { bg: 'rgba(255, 241, 118, 0.14)', color: '#FFF176', border: 'rgba(255, 241, 118, 0.35)' },
  done: { bg: 'rgba(255, 230, 0, 0.14)', color: '#FFE600', border: 'rgba(255, 230, 0, 0.35)' },
  break: { bg: 'rgba(100, 116, 139, 0.18)', color: '#94A3B8', border: 'rgba(100, 116, 139, 0.3)' },
  skip: { bg: 'rgba(255, 61, 61, 0.14)', color: '#FF3D3D', border: 'rgba(255, 61, 61, 0.3)' },
  waiting: { bg: 'rgba(255, 179, 0, 0.14)', color: '#FFB300', border: 'rgba(255, 179, 0, 0.3)' },
  serving: { bg: 'rgba(255, 230, 0, 0.18)', color: '#FFE600', border: 'rgba(255, 230, 0, 0.45)' },
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
            <span className="pulsing-dot-ping" style={{ backgroundColor: '#FFE600' }} />
            <span className="pulsing-dot-core" style={{ backgroundColor: '#FFE600' }} />
          </span>
          <span className="mono" style={{ fontSize: '10px', color: '#FFE600', fontWeight: 700 }}>
            REALTIME
          </span>
        </div>
      </div>

      <div
        className="q-card"
        style={{
          overflow: 'hidden',
          background: 'rgba(22, 25, 12, 0.8)',
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
