export function NowServingHero({ nowServing = [] }) {
  const currentToken = nowServing.length > 0 ? nowServing[0] : null;

  const counterName = currentToken?.counterId?.displayLabel ||
    currentToken?.counterId?.name ||
    (currentToken?.counterId?.number ? `Counter ${currentToken.counterId.number}` : 'Service Station');

  return (
    <section className="display-card display-card-glow hero-serving-card" aria-label="Now Serving Section">
      <div className="hero-label">
        <span>🎯</span>
        <span>NOW SERVING</span>
      </div>

      {currentToken ? (
        <>
          <div className="hero-token-code" data-testid="now-serving-token">
            {currentToken.tokenCode}
          </div>
          <div className="hero-destination-box">
            <div className="hero-counter-label" data-testid="now-serving-counter">
              {counterName}
            </div>
            {currentToken.serviceId?.name && (
              <span className="hero-service-badge">
                {currentToken.serviceId.name}
              </span>
            )}
          </div>
        </>
      ) : (
        <>
          <div className="hero-token-empty" data-testid="now-serving-empty">
            NO ACTIVE TOKEN
          </div>
          <div className="hero-destination-box">
            <div className="hero-counter-label" style={{ color: 'var(--text-muted)', fontSize: '1.1rem' }}>
              All Counters Available
            </div>
            <span className="hero-service-badge">
              Standby
            </span>
          </div>
        </>
      )}
    </section>
  );
}
