import React from 'react';
import { Inbox } from 'lucide-react';

export default function EmptyState({
  title = 'No data available',
  description = 'There are no active records at this time.',
  action = null,
}) {
  return (
    <div
      style={{
        textAlign: 'center',
        padding: '48px 24px',
        background: 'rgba(13, 20, 34, 0.65)',
        borderRadius: '18px',
        border: '1px dashed rgba(255, 255, 255, 0.12)',
        backdropFilter: 'blur(8px)',
      }}
    >
      <div
        style={{
          width: '48px',
          height: '48px',
          margin: '0 auto 14px',
          borderRadius: '14px',
          background: 'rgba(255, 255, 255, 0.04)',
          border: '1px solid var(--border-subtle)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#64748B',
        }}
      >
        <Inbox size={22} color="#00E5A8" style={{ opacity: 0.8 }} />
      </div>
      <h3 style={{ fontSize: '15px', fontWeight: 700, color: '#F8FAFC', marginBottom: '6px' }}>
        {title}
      </h3>
      <p style={{ fontSize: '13px', color: '#94A3B8', maxWidth: '360px', margin: '0 auto', lineHeight: 1.5 }}>
        {description}
      </p>
      {action && <div style={{ marginTop: '18px' }}>{action}</div>}
    </div>
  );
}
