export function NextTokenCard({ nextInQueue = [] }) {
  const nextToken = nextInQueue.length > 0 ? nextInQueue[0] : null;

  return (
    <section className="display-card display-card-cyan hero-next-card" aria-label="Next Token Section">
      <div className="next-label">
        <span>📋 NEXT IN LINE</span>
      </div>

      {nextToken ? (
        <>
          <div className="next-token-code" data-testid="next-token-code">
            {nextToken.tokenCode}
          </div>
          <div className="next-details">
            <span>{nextToken.serviceId?.name || 'General Service'}</span>
            {typeof nextToken.waitEstimateMinutes === 'number' && (
              <span style={{ color: 'var(--color-primary)', fontWeight: 700 }}>
                ~{nextToken.waitEstimateMinutes} min wait
              </span>
            )}
          </div>
        </>
      ) : (
        <>
          <div className="next-token-empty" data-testid="next-token-empty">
            —
          </div>
          <div className="next-details">
            <span style={{ color: 'var(--text-muted)' }}>No customers waiting in line</span>
            <span style={{ color: 'var(--color-primary)', fontWeight: 600 }}>Queue Clear</span>
          </div>
        </>
      )}
    </section>
  );
}
