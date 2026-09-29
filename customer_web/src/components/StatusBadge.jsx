export function StatusBadge({ status }) {
  if (!status) return null;

  const normalized = status.toUpperCase();

  const config = {
    WAITING: {
      className: 'badge badge-waiting',
      label: 'Waiting in Queue',
      dotColor: 'var(--color-cyan)',
    },
    CALLED: {
      className: 'badge badge-called pulse-mint',
      label: 'Now Called',
      dotColor: 'var(--color-primary)',
    },
    SERVING: {
      className: 'badge badge-serving',
      label: 'Being Served',
      dotColor: 'var(--color-cyan)',
    },
    COMPLETED: {
      className: 'badge badge-completed',
      label: 'Completed',
      dotColor: 'var(--color-primary)',
    },
    SKIPPED: {
      className: 'badge badge-skipped',
      label: 'Skipped',
      dotColor: 'var(--color-warning)',
    },
    CANCELLED: {
      className: 'badge badge-cancelled',
      label: 'Cancelled',
      dotColor: 'var(--color-danger)',
    },
    EXPIRED: {
      className: 'badge badge-expired',
      label: 'Expired',
      dotColor: 'var(--text-secondary)',
    },
  };

  const current = config[normalized] || {
    className: 'badge',
    label: normalized,
    dotColor: 'var(--text-secondary)',
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
