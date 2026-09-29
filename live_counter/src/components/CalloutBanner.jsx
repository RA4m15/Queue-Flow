import { useEffect, useState } from 'react';

export function CalloutBanner({ callout, onDismiss }) {
  const [isDismissing, setIsDismissing] = useState(false);

  useEffect(() => {
    setIsDismissing(false);
  }, [callout]);

  useEffect(() => {
    if (!callout) return;
    // Auto-dismiss safety timeout: 45s if no socket lifecycle event arrives earlier
    const timer = setTimeout(() => {
      handleDismiss();
    }, 45000);
    return () => clearTimeout(timer);
  }, [callout]);

  const handleDismiss = () => {
    setIsDismissing(true);
    setTimeout(() => {
      onDismiss?.();
    }, 200);
  };

  if (!callout) return null;

  return (
    <div className="callout-banner-wrapper">
      <div
        role="region"
        aria-label="Now Calling Display"
        className={`callout-banner ${isDismissing ? 'callout-dismissing' : ''}`}
        data-testid="callout-banner"
      >
        <button
          type="button"
          className="callout-close-btn"
          onClick={handleDismiss}
          aria-label="Dismiss call notice"
          title="Dismiss notice"
        >
          ✕
        </button>

        <div className="callout-tag">
          <span className="callout-pulse-dot" />
          <span>🔔 NOW CALLING</span>
        </div>

        <div className="callout-token-label">
          TOKEN NUMBER
        </div>

        <div className="callout-ticket" data-testid="callout-ticket">
          {callout.tokenCode}
        </div>

        <div className="callout-target">
          <span className="callout-target-label">PLEASE PROCEED TO</span>
          <strong className="callout-counter-name" data-testid="callout-counter">
            {callout.counterName}
          </strong>
        </div>
      </div>
    </div>
  );
}
