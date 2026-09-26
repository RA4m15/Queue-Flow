export function SkeletonLoader({ type = 'card', count = 3 }) {
  const items = Array.from({ length: count }, (_, i) => i);

  if (type === 'token') {
    return (
      <div className="ticket-container" style={{ minHeight: '320px', padding: '1.5rem' }}>
        <div className="skeleton" style={{ height: '24px', width: '60%', marginBottom: '1rem' }} />
        <div className="skeleton" style={{ height: '60px', width: '80%', marginBottom: '1.5rem' }} />
        <div className="skeleton" style={{ height: '20px', width: '40%', marginBottom: '0.75rem' }} />
        <div className="skeleton" style={{ height: '20px', width: '50%', marginBottom: '1.5rem' }} />
        <div className="skeleton" style={{ height: '48px', width: '100%', borderRadius: '12px' }} />
      </div>
    );
  }

  if (type === 'preview') {
    return (
      <div className="qf-card" style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        <div className="skeleton" style={{ height: '28px', width: '50%' }} />
        <div className="skeleton" style={{ height: '70px', width: '100%' }} />
        <div className="skeleton" style={{ height: '40px', width: '70%' }} />
        <div className="skeleton" style={{ height: '50px', width: '100%', borderRadius: '12px' }} />
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      {items.map((key) => (
        <div key={key} className="qf-card" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          <div className="skeleton" style={{ height: '24px', width: '70%' }} />
          <div className="skeleton" style={{ height: '16px', width: '90%' }} />
          <div className="skeleton" style={{ height: '16px', width: '40%' }} />
        </div>
      ))}
    </div>
  );
}
