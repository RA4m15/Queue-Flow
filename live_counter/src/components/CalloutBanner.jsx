import { useEffect } from 'react';

export function CalloutBanner({ callout, onDismiss }) {
  useEffect(() => {
    if (!callout) return;
    const timer = setTimeout(() => {
      onDismiss?.();
    }, 12000);
    return () => clearTimeout(timer);
  }, [callout, onDismiss]);

  if (!callout) return null;

  return (
    <div
      role="alert"
      aria-live="assertive"
      className="callout-banner"
      data-testid="callout-banner"
    >
      <div className="callout-tag">
        🔔 TICKET CALLED
      </div>
      <div className="callout-ticket" data-testid="callout-ticket">
        {callout.tokenCode}
      </div>
      <div className="callout-target">
        PLEASE PROCEED TO <strong style={{ color: '#FFFFFF', textDecoration: 'underline' }}>{callout.counterName}</strong>
      </div>
    </div>
  );
}
