import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Canonical Customer Queue QR — Live Counter side (cases 17-20).
 *
 * The display encodes exactly ONE URL:
 *
 *   https://<customer-web-host>/join?centerId=<REAL_ID>[&serviceId=<REAL_ID>]
 *
 * That URL is what a customer scans. It opens the app when QueueFlow is
 * installed (App Link / Universal Link) and falls back to the browser on the
 * same Customer Web /join route when it is not.
 *
 * The QR section is a clean, premium, presentation-ready kiosk display:
 *   - "SCAN TO JOIN QUEUE"
 *   - "Get your digital ticket on your phone"
 *   - Large scannable QR code image
 *   - "Scan with your phone camera to join the queue"
 *   - "Open with your camera"
 *
 * Crucially, debug information, localhost URLs, custom schemes, centerId/serviceId
 * raw text, environment variable names, and configuration warnings NEVER leak into
 * the rendered UI.
 */

const REAL_CENTER_ID = '6ab2ddfb99b28c7c31a3c8cc';
const REAL_SERVICE_ID = '6ab2ddfb99b28c7c31a3c8dd';
const ALT_CENTER_ID = '6ab93df8da6b1eefeb19caa2';
const PRODUCTION_HOST = 'queueflow.app';

/**
 * Load a fresh copy of the QR service and the panel that consumes it, with
 * VITE_CUSTOMER_WEB_URL set to [webUrl]. Passing undefined simulates a build
 * where the variable was never supplied at all.
 */
async function loadQr(webUrl) {
  vi.resetModules();
  if (webUrl === undefined) {
    vi.stubEnv('VITE_CUSTOMER_WEB_URL', '');
  } else {
    vi.stubEnv('VITE_CUSTOMER_WEB_URL', webUrl);
  }
  const qr = await import('../services/qr');
  const { JoinQrPanel } = await import('../components/JoinQrPanel');
  return { qr, JoinQrPanel };
}

beforeEach(() => {
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('17. The encoded payload is the canonical HTTPS /join URL', () => {
  it('17a. production base yields an https://HOST/join?centerId=… link', async () => {
    const { qr } = await loadQr(`https://${PRODUCTION_HOST}`);

    expect(qr.CUSTOMER_WEB_BASE).toBe(`https://${PRODUCTION_HOST}`);
    expect(qr.buildCanonicalJoinUrl(REAL_CENTER_ID)).toBe(
      `https://${PRODUCTION_HOST}/join?centerId=${REAL_CENTER_ID}`
    );
  });

  it('17b. a service-scoped QR appends serviceId', async () => {
    const { qr } = await loadQr(`https://${PRODUCTION_HOST}`);

    expect(qr.buildCanonicalJoinUrl(REAL_CENTER_ID, REAL_SERVICE_ID)).toBe(
      `https://${PRODUCTION_HOST}/join?centerId=${REAL_CENTER_ID}` +
        `&serviceId=${REAL_SERVICE_ID}`
    );
  });

  it('17c. a trailing slash in the configured base never doubles up', async () => {
    const { qr } = await loadQr(`https://${PRODUCTION_HOST}/`);

    expect(qr.CUSTOMER_WEB_BASE).toBe(`https://${PRODUCTION_HOST}`);
    expect(qr.buildCanonicalJoinUrl(REAL_CENTER_ID)).not.toContain('//join');
  });

  it('17d. the panel renders the clean QR image and never leaks raw URLs or debug text', async () => {
    const { qr, JoinQrPanel } = await loadQr(`https://${PRODUCTION_HOST}`);

    render(
      <JoinQrPanel
        centerId={REAL_CENTER_ID}
        serviceId={REAL_SERVICE_ID}
        centerName="City Hall"
      />
    );

    await waitFor(() => {
      expect(screen.getByTestId('qr-code-image')).toBeInTheDocument();
    });

    // Desired presentation-ready UI elements
    expect(screen.getByText('SCAN TO JOIN QUEUE')).toBeInTheDocument();
    expect(screen.getByText('Get your digital ticket on your phone')).toBeInTheDocument();
    expect(screen.getByText('Scan with your phone camera to join the queue')).toBeInTheDocument();
    expect(screen.getByText('Open with your camera')).toBeInTheDocument();

    // The QR image encodes the canonical HTTPS link
    const expected =
      `https://${PRODUCTION_HOST}/join?centerId=${REAL_CENTER_ID}` +
      `&serviceId=${REAL_SERVICE_ID}`;
    expect(qr.resolveQrPayload(REAL_CENTER_ID, REAL_SERVICE_ID)).toBe(expected);

    // Visible UI must NOT display raw debug info
    const panelText = screen.getByLabelText('Join Queue QR Panel').textContent;
    expect(panelText).not.toContain(REAL_CENTER_ID);
    expect(panelText).not.toContain(REAL_SERVICE_ID);
    expect(panelText).not.toContain('localhost');
    expect(panelText).not.toContain('queueflow://');
    expect(panelText).not.toContain('http');
    expect(panelText).not.toContain('VITE_CUSTOMER_WEB_URL');
  });

  it('17e. a localhost base renders clean operator error state without developer warnings', async () => {
    const { qr, JoinQrPanel } = await loadQr(undefined);

    // The dev default is localhost, which no customer can actually scan.
    expect(qr.isPublicCustomerWebBase()).toBe(false);

    render(<JoinQrPanel centerId={REAL_CENTER_ID} centerName="Verify Center" />);
    await waitFor(() => {
      expect(screen.getByTestId('qr-error-state')).toBeInTheDocument();
    });

    expect(screen.getByText('Check-in Unavailable')).toBeInTheDocument();
    expect(screen.getByText('Please visit the service desk')).toBeInTheDocument();
    expect(screen.queryByTestId('qr-config-warning')).not.toBeInTheDocument();

    const panelText = screen.getByLabelText('Join Queue QR Panel').textContent;
    expect(panelText).not.toContain('localhost');
    expect(panelText).not.toContain('VITE_CUSTOMER_WEB_URL');
  });

  it('17f. a real HTTPS deployment is treated as public and renders QR image', async () => {
    const { qr, JoinQrPanel } = await loadQr(`https://${PRODUCTION_HOST}`);

    expect(qr.isPublicCustomerWebBase()).toBe(true);

    render(<JoinQrPanel centerId={REAL_CENTER_ID} centerName="Verify Center" />);
    await waitFor(() => {
      expect(screen.getByTestId('qr-code-image')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('qr-error-state')).not.toBeInTheDocument();
  });

  it('17g. a placeholder or non-routable base is never called public', async () => {
    const { qr } = await loadQr(`https://${PRODUCTION_HOST}`);

    const notPublic = [
      'https://join.invalid',
      'https://join.test',
      'https://join.example',
      'https://join.localhost',
      'https://join.local',
      'http://join.queueflow.app', // cleartext
      'https://127.0.0.1',
      'https://10.0.0.5',
      'not a url',
    ];
    for (const base of notPublic) {
      expect(qr.isPublicCustomerWebBase(base), base).toBe(false);
    }
    // A legitimate deployment passes.
    expect(qr.isPublicCustomerWebBase('https://queueflow.app')).toBe(true);
  });
});

describe('18. IDs come from live backend data', () => {
  it('18a. the rendered QR image is labeled with the center name and changes dynamically', async () => {
    const { JoinQrPanel } = await loadQr(`https://${PRODUCTION_HOST}`);

    const { rerender } = render(
      <JoinQrPanel centerId={REAL_CENTER_ID} centerName="City Hall" />
    );

    await waitFor(() => {
      const img = screen.getByTestId('qr-code-image');
      expect(img.getAttribute('alt')).toContain('City Hall');
    });

    // Dynamic rerender with different center
    rerender(<JoinQrPanel centerId={ALT_CENTER_ID} centerName="College Account" />);

    await waitFor(() => {
      const img = screen.getByTestId('qr-code-image');
      expect(img.getAttribute('alt')).toContain('College Account');
    });

    // Neither center ID is shown as raw text
    const text = screen.getByLabelText('Join Queue QR Panel').textContent;
    expect(text).not.toContain(REAL_CENTER_ID);
    expect(text).not.toContain(ALT_CENTER_ID);
  });

  it('18b. no center id is baked into the QR service source', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/services/qr.js'), 'utf8');
    // A 24-hex literal in the generator would pin every display to one center.
    expect(source).not.toMatch(/['"][0-9a-f]{24}['"]/i);
  });

  it('18c. a missing centerId produces clean empty state rather than broken QR or raw text', async () => {
    const { qr, JoinQrPanel } = await loadQr(`https://${PRODUCTION_HOST}`);

    expect(qr.buildCanonicalJoinUrl(null)).toBe('');
    expect(qr.buildCanonicalJoinUrl(undefined)).toBe('');
    expect(qr.buildCanonicalJoinUrl('')).toBe('');
    expect(qr.buildJoinUrls(null)).toEqual({ deepLink: '', webUrl: '' });
    expect(qr.resolveQrPayload(null)).toBe('');

    render(<JoinQrPanel centerId={null} centerName="Unknown" />);
    await waitFor(() => {
      expect(screen.getByTestId('qr-empty-state')).toBeInTheDocument();
    });
    expect(screen.getByText('Select a service facility')).toBeInTheDocument();
    expect(screen.queryByTestId('qr-code-image')).not.toBeInTheDocument();

    const panelText = screen.getByLabelText('Join Queue QR Panel').textContent;
    expect(panelText).not.toContain('No join URL configured');
  });
});

describe('19. Nothing secret, and no localhost, in the encoded URL or UI', () => {
  const forbidden = [
    'jwt',
    'token',
    'secret',
    'password',
    'iot_secret',
    'mongodb',
    'fcm',
    'apikey',
    'bearer',
    'localhost',
    '127.0.0.1',
  ];

  it('19a. no credential substring ever appears in a generated URL', async () => {
    const { qr } = await loadQr(`https://${PRODUCTION_HOST}`);

    const urls = [
      qr.buildCanonicalJoinUrl(REAL_CENTER_ID),
      qr.buildCanonicalJoinUrl(REAL_CENTER_ID, REAL_SERVICE_ID),
      qr.buildJoinUrls(REAL_CENTER_ID).webUrl,
      qr.buildJoinUrls(REAL_CENTER_ID, REAL_SERVICE_ID).webUrl,
    ];

    for (const url of urls) {
      const lower = url.toLowerCase();
      for (const word of forbidden) {
        expect(lower, `URL leaked "${word}": ${url}`).not.toContain(word);
      }
    }
  });

  it('19b. the URL contains only the two id parameters', async () => {
    const { qr } = await loadQr(`https://${PRODUCTION_HOST}`);

    const url = new URL(
      qr.buildCanonicalJoinUrl(REAL_CENTER_ID, REAL_SERVICE_ID)
    );
    expect([...url.searchParams.keys()].sort()).toEqual(['centerId', 'serviceId']);
    expect(url.pathname).toBe('/join');
    expect(url.hash).toBe('');
  });

  it('19c. localhost never appears anywhere in the rendered QR section', async () => {
    const { qr, JoinQrPanel } = await loadQr('http://localhost:5173');

    expect(qr.isPublicCustomerWebBase()).toBe(false);

    render(<JoinQrPanel centerId={REAL_CENTER_ID} centerName="Verify Center" />);

    await waitFor(() => {
      expect(screen.getByTestId('qr-error-state')).toBeInTheDocument();
    });

    const panelText = screen.getByLabelText('Join Queue QR Panel').textContent;
    expect(panelText).not.toContain('localhost');
    expect(panelText).not.toContain('5173');
    expect(panelText).not.toContain('http:');
    expect(screen.queryByTestId('qr-config-warning')).not.toBeInTheDocument();
  });

  it('19d. no customer PII is required to build a join URL', async () => {
    const { qr } = await loadQr(`https://${PRODUCTION_HOST}`);

    expect(qr.buildCanonicalJoinUrl.length).toBeLessThanOrEqual(2);
    const url = qr.buildCanonicalJoinUrl(REAL_CENTER_ID);
    expect(url).not.toMatch(/@/);
    expect(url).not.toMatch(/\+/);
  });
});

describe('20. The legacy queueflow:// link is supported internally but never rendered', () => {
  it('20a. the custom scheme is returned by service for backwards compatibility', async () => {
    const { qr } = await loadQr(`https://${PRODUCTION_HOST}`);

    const { deepLink, webUrl } = qr.buildJoinUrls(REAL_CENTER_ID, REAL_SERVICE_ID);

    expect(deepLink).toBe(
      `queueflow://join?centerId=${REAL_CENTER_ID}&serviceId=${REAL_SERVICE_ID}`
    );
    expect(webUrl).toBe(
      `https://${PRODUCTION_HOST}/join?centerId=${REAL_CENTER_ID}` +
        `&serviceId=${REAL_SERVICE_ID}`
    );
  });

  it('20b. queueflow:// is never rendered as visible text in the UI', async () => {
    const { JoinQrPanel } = await loadQr(`https://${PRODUCTION_HOST}`);

    render(<JoinQrPanel centerId={REAL_CENTER_ID} centerName="Verify Center" />);

    await waitFor(() => {
      expect(screen.getByTestId('qr-code-image')).toBeInTheDocument();
    });

    const panelText = screen.getByLabelText('Join Queue QR Panel').textContent;
    expect(panelText).not.toContain('queueflow://');
    expect(screen.queryByTestId('qr-deeplink-preview')).not.toBeInTheDocument();
  });

  it('20c. the canonical payload is a plain web URL any browser can open', async () => {
    const { qr } = await loadQr(`https://${PRODUCTION_HOST}`);

    const url = new URL(qr.resolveQrPayload(REAL_CENTER_ID));
    expect(url.protocol).toBe('https:');
    expect(url.pathname).toBe('/join');
  });
});
