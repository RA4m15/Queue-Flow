export function StatusBadge({ status }) {
  if (!status) return null;

  const normalized = status.toUpperCase();

  const config = {
    WAITING: {
      className: 'badge badge-waiting',
      label: 'Waiting in Queue',
      dotColor: '#60A5FA',
    },
    CALLED: {
      className: 'badge badge-called pulse-mint',
      label: 'Now Called',
      dotColor: '#00E5A8',
    },
    SERVING: {
      className: 'badge badge-serving',
      label: 'Being Served',
      dotColor: '#00D2FF',
    },
    COMPLETED: {
      className: 'badge badge-completed',
      label: 'Completed',
      dotColor: '#00E5A8',
    },
    SKIPPED: {
      className: 'badge badge-skipped',
      label: 'Skipped',
      dotColor: '#F59E0B',
    },
    CANCELLED: {
      className: 'badge badge-cancelled',
      label: 'Cancelled',
      dotColor: '#EF4444',
    },
    EXPIRED: {
      className: 'badge badge-expired',
      label: 'Expired',
      dotColor: '#94A3B8',
    },
  };

  const current = config[normalized] || {
    className: 'badge',
    label: normalized,
    dotColor: '#94A3B8',
  };

  return (
    <span
      className={current.className}
      role="status"
      aria-label={`Token status: ${current.label}`}
    >
      <span
        style={{
          width: '6px',
          height: '6px',
          borderRadius: '50%',
          backgroundColor: current.dotColor,
          display: 'inline-block',
        }}
        aria-hidden="true"
      />
      {current.label}
    </span>
  );
}
