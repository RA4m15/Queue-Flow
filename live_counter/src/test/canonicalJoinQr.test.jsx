import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Canonical Customer Queue QR — Live Counter side (cases 17-20).
 *
 * The display must encode exactly ONE URL:
 *
 *   https://<customer-web-host>/join?centerId=<REAL_ID>[&serviceId=<REAL_ID>]
 *
 * That URL is what a customer scans. It opens the app when QueueFlow is
 * installed (App Link / Universal Link) and falls back to the browser on the
 * same Customer Web /join route when it is not, so it is the only format that
 * can work for every customer standing at the screen.
 *
 * These tests pin the four properties that matter for a QR printed on a public
 * display:
 *   17. the encoded payload is the canonical HTTPS /join URL
 *   18. the IDs come from live backend data, never a hardcoded constant
 *   19. nothing secret, and no localhost, is ever encoded
 *   20. the legacy queueflow:// link is still produced for backwards compat
 *
 * Each test re-imports the module tree with a specific VITE_CUSTOMER_WEB_URL,
 * because the base URL is resolved once at module load — which is exactly the
 * behaviour a production build relies on.
 */

const REAL_CENTER_ID = '6ab2ddfb99b28c7c31a3c8cc';
const REAL_SERVICE_ID = '6ab2ddfb99b28c7c31a3c8dd';
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

  it('17d. the panel encodes the HTTPS URL, and shows that same URL', async () => {
    const { qr, JoinQrPanel } = await loadQr(`https://${PRODUCTION_HOST}`);

    render(
      <JoinQrPanel
        centerId={REAL_CENTER_ID}
        serviceId={REAL_SERVICE_ID}
        centerName="Verify Center"
      />
    );

    await waitFor(() => {
      expect(screen.getByTestId('qr-join-url-preview')).toBeInTheDocument();
    });

    // The primary preview is exactly what resolveQrPayload puts in the QR, so
    // an operator can transcribe it when the code will not scan.
    const expected =
      `https://${PRODUCTION_HOST}/join?centerId=${REAL_CENTER_ID}` +
      `&serviceId=${REAL_SERVICE_ID}`;
    expect(screen.getByTestId('qr-join-url-preview').textContent).toBe(expected);
    expect(qr.resolveQrPayload(REAL_CENTER_ID, REAL_SERVICE_ID)).toBe(expected);
  });

  it('17e. a localhost base is reported instead of silently printed', async () => {
    const { qr, JoinQrPanel } = await loadQr(undefined);

    // The dev default is localhost, which no customer can actually scan.
    expect(qr.isPublicCustomerWebBase()).toBe(false);

    render(<JoinQrPanel centerId={REAL_CENTER_ID} centerName="Verify Center" />);
    await waitFor(() => {
      expect(screen.getByTestId('qr-config-warning')).toBeInTheDocument();
    });
  });

  it('17f. a real HTTPS deployment is treated as public', async () => {
    const { qr, JoinQrPanel } = await loadQr(`https://${PRODUCTION_HOST}`);

    expect(qr.isPublicCustomerWebBase()).toBe(true);

    render(<JoinQrPanel centerId={REAL_CENTER_ID} centerName="Verify Center" />);
    await waitFor(() => {
      expect(screen.queryByTestId('qr-config-warning')).not.toBeInTheDocument();
    });
  });

  it('17g. a placeholder or non-routable base is never called public', async () => {
    const { qr } = await loadQr(`https://${PRODUCTION_HOST}`);

    // The Android/iOS deep-link config deliberately defaults to `.invalid`
    // (RFC 2606, can never resolve). A QR built from the same placeholder must
    // be reported as a misconfiguration, not printed on a lobby screen.
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
  it('18a. the rendered QR uses the center the backend returned', async () => {
    const { JoinQrPanel } = await loadQr(`https://${PRODUCTION_HOST}`);

    render(<JoinQrPanel centerId={REAL_CENTER_ID} centerName="Verify Center" />);

    await waitFor(() => {
      expect(
        screen.getByTestId('qr-join-url-preview').textContent
      ).toContain(`centerId=${REAL_CENTER_ID}`);
    });
  });

  it('18b. no center id is baked into the QR service source', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/services/qr.js'), 'utf8');
    // A 24-hex literal in the generator would pin every display to one center.
    expect(source).not.toMatch(/['"][0-9a-f]{24}['"]/i);
  });

  it('18c. a missing centerId produces no QR at all rather than a broken one', async () => {
    const { qr, JoinQrPanel } = await loadQr(`https://${PRODUCTION_HOST}`);

    expect(qr.buildCanonicalJoinUrl(null)).toBe('');
    expect(qr.buildCanonicalJoinUrl(undefined)).toBe('');
    expect(qr.buildCanonicalJoinUrl('')).toBe('');
    expect(qr.buildJoinUrls(null)).toEqual({ deepLink: '', webUrl: '' });
    expect(qr.resolveQrPayload(null)).toBe('');

    render(<JoinQrPanel centerId={null} centerName="Unknown" />);
    await waitFor(() => {
      expect(screen.getByTestId('qr-join-url-preview').textContent).toBe(
        'No join URL configured'
      );
    });
  });
});

describe('19. Nothing secret, and no localhost, in the encoded URL', () => {
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

  it('19c. a localhost QR is surfaced as a configuration error', async () => {
    const { qr, JoinQrPanel } = await loadQr('http://localhost:5173');

    expect(qr.isPublicCustomerWebBase()).toBe(false);

    render(<JoinQrPanel centerId={REAL_CENTER_ID} centerName="Verify Center" />);

    await waitFor(() => {
      expect(screen.getByTestId('qr-config-warning')).toBeInTheDocument();
    });
    // The link is still shown, so an operator can see what is configured.
    expect(screen.getByTestId('qr-join-url-preview').textContent).toContain(
      'localhost'
    );
  });

  it('19d. no customer PII is required to build a join URL', async () => {
    const { qr } = await loadQr(`https://${PRODUCTION_HOST}`);

    // The builder takes IDs only — there is nowhere for a name, phone number
    // or email to enter the QR.
    expect(qr.buildCanonicalJoinUrl.length).toBeLessThanOrEqual(2);
    const url = qr.buildCanonicalJoinUrl(REAL_CENTER_ID);
    expect(url).not.toMatch(/@/);
    expect(url).not.toMatch(/\+/);
  });
});

describe('20. The legacy queueflow:// link is still produced', () => {
  it('20a. the custom scheme is returned for backwards compatibility', async () => {
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

  it('20b. the custom scheme is shown, but clearly secondary', async () => {
    const { JoinQrPanel } = await loadQr(`https://${PRODUCTION_HOST}`);

    render(<JoinQrPanel centerId={REAL_CENTER_ID} centerName="Verify Center" />);

    await waitFor(() => {
      expect(screen.getByTestId('qr-deeplink-preview').textContent).toBe(
        `queueflow://join?centerId=${REAL_CENTER_ID}`
      );
    });
    // And it is never what the QR encodes.
    expect(screen.getByTestId('qr-join-url-preview').textContent).not.toContain(
      'queueflow://'
    );
  });

  it('20c. the canonical payload is a plain web URL any browser can open', async () => {
    const { qr } = await loadQr(`https://${PRODUCTION_HOST}`);

    // A customer without QueueFlow installed lands on Customer Web /join. The
    // legacy custom scheme cannot do that, which is why it is not primary.
    const url = new URL(qr.resolveQrPayload(REAL_CENTER_ID));
    expect(url.protocol).toBe('https:');
    expect(url.pathname).toBe('/join');
  });
});
