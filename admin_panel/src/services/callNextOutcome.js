/**
 * Phase 2 geofencing — how the Operator Portal narrates the result of one
 * CALL NEXT.
 *
 * One operator press can now do three things at once: skip several customers
 * who left the service area, call the next eligible customer, and explain that
 * it refused to touch anyone whose location it could not confirm. The operator
 * has to be able to see all of that at a glance, in plain language, without the
 * UI ever becoming a location-tracking readout.
 *
 * This module is deliberately pure and framework-free so the wording rules can
 * be tested directly (see test/phase2_call_next_outcome.test.js). The component
 * only renders what this returns.
 */

/**
 * How many skipped customers to name individually before collapsing the rest
 * into a count. A busy counter can skip a lot in one press, and a wall of text
 * would push the actually-important line (who was called) off the banner.
 */
export const MAX_NAMED_SKIPS = 3;

/** Rounded distance is only worth showing above this, to avoid "0 m away". */
const MIN_REPORTED_DISTANCE_M = 5;

/**
 * Summarise one CALL NEXT response into a banner.
 *
 * The headline is always the authoritative outcome — who was called, or the
 * truthful "nobody eligible" statement. Skips and blocked customers become
 * detail lines beneath it so the single most important fact is never buried.
 *
 * @param {object} res the parsed `POST /counters/:id/call-next` response
 * @returns {{tone: 'called'|'skipped'|'blocked'|'empty', message: string, details: string[]}}
 */
export function describeCallNextOutcome(res) {
  const data = res?.data || {};
  const token = data.token || null;
  const skipped = Array.isArray(data.skipped) ? data.skipped : [];
  const blocked = Array.isArray(data.blocked) ? data.blocked : [];

  const details = [];

  if (skipped.length > 0) {
    details.push(
      `${skipped.length} customer${skipped.length === 1 ? '' : 's'} skipped — outside service area`
    );
    details.push(...namedSkips(skipped));
  }

  for (const entry of blocked) {
    const code = entry?.tokenCode ? `Token ${entry.tokenCode}` : 'Next customer in line';
    details.push(`${code} not skipped — ${blockedReason(entry)}`);
  }

  if (token) {
    return { tone: 'called', message: `Token ${token.tokenCode} called`, details };
  }

  if (skipped.length > 0) {
    return {
      tone: 'skipped',
      message: 'No eligible customer currently in the service area',
      details,
    };
  }

  if (blocked.length > 0) {
    return {
      tone: 'blocked',
      message: 'No eligible customer currently in the service area',
      details: [
        ...details,
        'Nobody was skipped — a customer with an unconfirmed location is never treated as present',
      ],
    };
  }

  return { tone: 'empty', message: 'No waiting tokens in the queue', details: [] };
}

/**
 * The individual "Token P2-004 skipped — 312 m from the center" lines.
 *
 * Distance is shown because an operator adjudicating a complaint needs to know
 * how far out the customer was. Coordinates and GPS accuracy never leave the
 * backend, and are not part of this payload.
 */
export function namedSkips(skipped) {
  const shown = skipped.slice(0, MAX_NAMED_SKIPS).map((entry) => {
    const code = entry?.tokenCode || 'Unknown token';
    const distance = Number(entry?.distanceMeters);
    if (Number.isFinite(distance) && distance >= MIN_REPORTED_DISTANCE_M) {
      return `Token ${code} skipped — ${Math.round(distance)} m from the center`;
    }
    return `Token ${code} skipped — outside the service area`;
  });

  const remaining = skipped.length - shown.length;
  if (remaining > 0) {
    shown.push(`+${remaining} more customer${remaining === 1 ? '' : 's'} skipped`);
  }
  return shown;
}

/** Plain wording for a token the scan refused to touch, with no enum leaking. */
export function blockedReason(entry) {
  const reason = typeof entry?.reason === 'string' ? entry.reason.toLowerCase() : '';
  if (reason.includes('unconfirmed')) return 'last known location is unconfirmed';
  if (reason.includes('unavailable')) return 'no location shared';
  return 'presence could not be verified';
}

/**
 * Live `token.skipped` events the operator portal needs to react to.
 *
 * A geofence auto-skip is worth a one-line banner: the operator did not press
 * skip, the system did it on their behalf, and that has to stay visible. A
 * manual skip is deliberately not re-announced here, because the operator just
 * did it deliberately and would see their own toast.
 *
 * @param {object} payload center-room `token.skipped` payload
 * @returns {{message: string}|null}
 */
export function describeSkippedEvent(payload) {
  if (!payload || payload.skipReason !== 'OUT_OF_RANGE') return null;
  const code = payload?.token?.tokenCode;
  if (!code) return null;
  return { message: `Token ${code} auto-skipped — outside service area` };
}
