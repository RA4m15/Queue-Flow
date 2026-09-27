export function CountersGrid({ counters = [] }) {
  return (
    <section className="display-card counters-panel" aria-label="Active Counters Panel">
      <div className="panel-header">
        <div className="panel-title">
          <span>🏢</span>
          <span>STATION STATUS & LIVE ASSIGNMENTS</span>
        </div>
        <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
          {counters.filter((c) => c.status === 'ACTIVE').length} / {counters.length} Active Stations
        </span>
      </div>

      {counters.length === 0 ? (
        <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-muted)' }}>
          No counters configured for this center
        </div>
      ) : (
        <div className="counters-grid" data-testid="counters-grid">
          {counters.map((c) => {
            const isServing = Boolean(c.servingToken);
            const isActive = c.status === 'ACTIVE';

            let cardStatusClass = 'closed';
            if (isServing) cardStatusClass = 'serving';
            else if (isActive) cardStatusClass = 'active';

            return (
              <div
                key={c._id || c.number}
                className={`counter-station-card ${cardStatusClass}`}
                data-testid={`counter-station-${c.number}`}
              >
                <div className="counter-card-top">
                  <span className="counter-number-label">
                    {c.displayLabel || c.name || `Counter ${c.number}`}
                  </span>
                  <span
                    className={`counter-status-dot ${cardStatusClass}`}
                    title={isServing ? 'Serving' : isActive ? 'Active' : 'Closed'}
                  />
                </div>

                {c.servingToken ? (
                  <div className="counter-token-display">
                    {c.servingToken.tokenCode}
                  </div>
                ) : (
                  <div className="counter-idle-text">
                    {isActive ? 'Idle • Ready' : 'Closed'}
                  </div>
                )}

                <div className="counter-service-label">
                  {c.service?.name || (isActive ? 'General Counter' : 'Offline')}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
