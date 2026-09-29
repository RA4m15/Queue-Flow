import React from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

export default function ErrorMessage({ message = 'An error occurred loading data.', onRetry = null }) {
  return (
    <div
      style={{
        padding: '20px 24px',
        borderRadius: '16px',
        background: 'color-mix(in srgb, var(--color-danger) 8%, transparent)',
        border: '1px solid color-mix(in srgb, var(--color-danger) 30%, transparent)',
        textAlign: 'center',
        margin: '16px 0',
        backdropFilter: 'blur(8px)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', marginBottom: '8px' }}>
        <AlertTriangle size={18} color="var(--color-danger)" />
        <p style={{ color: 'var(--color-danger)', fontSize: '14px', fontWeight: 600 }}>
          {message}
        </p>
      </div>
      {onRetry && (
        <button
          onClick={onRetry}
          className="btn-secondary"
          style={{ padding: '6px 16px', fontSize: '12px', gap: '6px', marginTop: '4px' }}
        >
          <RefreshCw size={13} />
          <span>Try Again</span>
        </button>
      )}
    </div>
  );
}
