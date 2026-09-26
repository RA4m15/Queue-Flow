import React from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

export default function ErrorMessage({ message = 'An error occurred loading data.', onRetry = null }) {
  return (
    <div
      style={{
        padding: '20px 24px',
        borderRadius: '16px',
        background: 'rgba(239, 68, 68, 0.08)',
        border: '1px solid rgba(239, 68, 68, 0.3)',
        textAlign: 'center',
        margin: '16px 0',
        backdropFilter: 'blur(8px)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', marginBottom: '8px' }}>
        <AlertTriangle size={18} color="#EF4444" />
        <p style={{ color: '#F87171', fontSize: '14px', fontWeight: 600 }}>
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
