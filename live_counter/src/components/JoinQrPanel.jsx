import { useState, useEffect } from 'react';
import { buildJoinUrls, generateQrDataUrl, isPublicCustomerWebBase } from '../services/qr';

export function JoinQrPanel({ centerId, serviceId = null, centerName }) {
  const [qrSrc, setQrSrc] = useState('');
  const { deepLink, webUrl } = buildJoinUrls(centerId, serviceId);

  // The canonical payload is the HTTPS Customer Web /join link. It is the only
  // format that works for customers who do not have QueueFlow installed: the
  // phone falls back to the browser and lands on the same /join route. The
  // custom scheme is only used when no Customer Web base is configured at all.
  const qrPayload = webUrl || deepLink;
  const publicBase = isPublicCustomerWebBase();

  useEffect(() => {
    let isMounted = true;

    async function loadQr() {
      if (!qrPayload) {
        setQrSrc('');
        return;
      }
      const dataUrl = await generateQrDataUrl(qrPayload, 260);
      if (isMounted) {
        setQrSrc(dataUrl);
      }
    }

    loadQr();
    return () => {
      isMounted = false;
    };
  }, [qrPayload]);

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
            alt={`Scan QR code to join queue at ${centerName || 'center'}`}
            style={{ width: '220px', height: '220px', display: 'block' }}
            data-testid="qr-code-image"
          />
        ) : (
          <div style={{ width: '220px', height: '220px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#0B132B' }}>
            Generating QR...
          </div>
        )}
      </div>

      {!publicBase && (
        // A localhost / http Customer Web base produces a QR that no customer
        // standing at the display can open. Surface it instead of printing a
        // dead code on a public screen.
        <div className="qr-config-warning" data-testid="qr-config-warning" role="alert">
          Customer Web URL is not publicly reachable
          (<code>{qrPayload}</code>). Set <code>VITE_CUSTOMER_WEB_URL</code> to the
          deployed HTTPS domain before using this display.
        </div>
      )}

      <div className="qr-fallback-info">
        <strong>No app?</strong>
        <span>Scan with your camera to open QueueFlow Web</span>
        {/* Show the URL that is actually encoded in the QR above, so an
            operator can transcribe it when the code will not scan. */}
        <div className="qr-deep-link-preview" data-testid="qr-join-url-preview">
          {qrPayload || 'No join URL configured'}
        </div>
        {/* Legacy custom scheme, kept for backwards compatibility. Not the
            primary QR payload — it only opens the app if it is installed. */}
        <div className="qr-deep-link-preview qr-deep-link-preview--legacy" data-testid="qr-deeplink-preview">
          {deepLink}
        </div>
      </div>
    </aside>
  );
}
