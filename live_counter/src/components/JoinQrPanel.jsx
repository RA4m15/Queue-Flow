import { useState, useEffect } from 'react';
import { buildJoinUrls, generateQrDataUrl, isPublicCustomerWebBase } from '../services/qr';

export function JoinQrPanel({ centerId, serviceId = null, centerName }) {
  const [qrSrc, setQrSrc] = useState('');
  const { deepLink, webUrl } = buildJoinUrls(centerId, serviceId);

  // The canonical payload is the HTTPS Customer Web /join link.
  const qrPayload = webUrl || deepLink;
  const publicBase = isPublicCustomerWebBase();

  useEffect(() => {
    let isMounted = true;

    async function loadQr() {
      if (!qrPayload || !publicBase) {
        setQrSrc('');
        return;
      }
      const dataUrl = await generateQrDataUrl(qrPayload, 300);
      if (isMounted) {
        setQrSrc(dataUrl);
      }
    }

    loadQr();
    return () => {
      isMounted = false;
    };
  }, [qrPayload, publicBase]);

  useEffect(() => {
    if (!publicBase && typeof console !== 'undefined' && console.warn) {
      console.warn(
        '[QueueFlow] Live Counter QR: Customer Web base URL is not a public HTTPS origin. Ensure VITE_CUSTOMER_WEB_URL is configured with the deployed HTTPS domain.'
      );
    }
  }, [publicBase]);

  return (
    <aside className="display-card qr-join-panel" aria-label="Join Queue QR Panel">
      <div className="qr-heading-group">
        <h3>SCAN TO JOIN QUEUE</h3>
        <p>Get your digital ticket on your phone</p>
      </div>

      <div className="qr-canvas-container" data-testid="qr-container">
        {qrSrc ? (
          <img
            src={qrSrc}
            alt={`Scan QR code to join queue at ${centerName || 'service center'}`}
            className="qr-code-image"
            data-testid="qr-code-image"
          />
        ) : !centerId ? (
          <div className="qr-state-notice" data-testid="qr-empty-state" role="status">
            <p className="qr-state-desc">Select a service facility</p>
          </div>
        ) : !publicBase ? (
          <div className="qr-state-notice" data-testid="qr-error-state" role="status">
            <p className="qr-state-title">Check-in Unavailable</p>
            <p className="qr-state-desc">Please visit the service desk</p>
          </div>
        ) : (
          <div className="qr-loading-placeholder" data-testid="qr-loading" role="status">
            <span>Generating QR code...</span>
          </div>
        )}
      </div>

      <div className="qr-instructions">
        <p className="qr-instruction-primary">Scan with your phone camera to join the queue</p>
        <p className="qr-instruction-secondary">Open with your camera</p>
      </div>
    </aside>
  );
}
