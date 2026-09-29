export function NowServingHero({ counters = [], nowServing = [] }) {
  // If counters are passed, use them; if only nowServing is passed (legacy / test), synthesize counters
  const displayCounters =
    counters && counters.length > 0
      ? counters
      : (nowServing || []).map((t, idx) => ({
          _id: t.counterId?._id || `counter-${idx + 1}`,
          number: t.counterId?.number || idx + 1,
          name:
            t.counterId?.name ||
            (t.counterId?.number ? `Counter ${t.counterId.number}` : `Counter ${idx + 1}`),
          displayLabel:
            t.counterId?.displayLabel ||
            t.counterId?.name ||
            (t.counterId?.number
              ? `COUNTER ${String(t.counterId.number).padStart(2, '0')}`
              : `COUNTER ${String(idx + 1).padStart(2, '0')}`),
          status: 'ACTIVE',
          service: t.serviceId || { name: 'Active Service' },
          servingToken: {
            _id: t._id,
            tokenCode: t.tokenCode,
            status: t.status,
            calledAt: t.calledAt,
          },
        }));

  const servingCounters = displayCounters.filter((c) => Boolean(c.servingToken));
  const allIdle = servingCounters.length === 0;
  const firstServingIndex = displayCounters.findIndex((c) => Boolean(c.servingToken));

  return (
    <section className="display-card display-card-glow hero-serving-card" aria-label="Now Serving Section">
      <div className="hero-serving-header">
        <div className="hero-label">
          <span>🎯</span>
          <span>NOW SERVING</span>
        </div>
        {allIdle && (
          <div className="hero-all-idle-tag" data-testid="now-serving-empty">
            <span className="hero-all-idle-badge">ALL COUNTERS IDLE</span>
            <span className="hero-all-idle-note" style={{ display: 'none' }}>NO ACTIVE TOKEN</span>
          </div>
        )}
      </div>

      <div
        className={`hero-counters-container count-${displayCounters.length || 1}`}
        data-testid="hero-counters-container"
      >
        {displayCounters.length === 0 ? (
          <div className="hero-counter-subcard is-idle" data-testid="now-serving-card-1">
            <div className="hero-counter-subcard-header">
              <span className="hero-counter-title">SERVICE COUNTER</span>
              <span className="hero-counter-status-pill idle">
                <span className="hero-status-dot" />
                Idle
              </span>
            </div>
            <div className="hero-token-idle">
              <span className="hero-token-idle-title">IDLE</span>
              <span className="hero-token-idle-sub">No active token</span>
            </div>
            <div className="hero-counter-subcard-footer">
              <span className="hero-service-badge">Standby</span>
            </div>
          </div>
        ) : (
          displayCounters.map((c, index) => {
            const isServing = Boolean(c.servingToken);
            const isFirstServing = isServing && index === firstServingIndex;
            const counterNumber = c.number || index + 1;
            const counterTitle =
              c.displayLabel ||
              c.name ||
              (c.number ? `COUNTER ${String(c.number).padStart(2, '0')}` : `COUNTER ${String(index + 1).padStart(2, '0')}`);
            const serviceName =
              c.service?.name ||
              c.servingToken?.serviceId?.name ||
              (isServing ? 'Active Service' : 'Available');

            return (
              <div
                key={c._id || counterNumber}
                className={`hero-counter-subcard ${isServing ? 'is-serving' : 'is-idle'}`}
                data-testid={`now-serving-card-${counterNumber}`}
              >
                <div className="hero-counter-subcard-header">
                  <span
                    className="hero-counter-title"
                    data-testid={isFirstServing ? 'now-serving-counter' : `now-serving-counter-${counterNumber}`}
                  >
                    {counterTitle}
                  </span>
                  <span className={`hero-counter-status-pill ${isServing ? 'serving' : 'idle'}`}>
                    <span className="hero-status-dot" />
                    {isServing ? 'Serving' : 'Idle'}
                  </span>
                </div>

                {isServing ? (
                  <div className="hero-token-serving-box">
                    <div
                      className="hero-token-code"
                      data-testid={isFirstServing ? 'now-serving-token' : `now-serving-token-${counterNumber}`}
                    >
                      {c.servingToken.tokenCode}
                    </div>
                  </div>
                ) : (
                  <div className="hero-token-idle">
                    <span className="hero-token-idle-title">IDLE</span>
                    <span className="hero-token-idle-sub">No active token</span>
                  </div>
                )}

                <div className="hero-counter-subcard-footer">
                  <span className="hero-service-badge">
                    {serviceName}
                  </span>
                </div>
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}
