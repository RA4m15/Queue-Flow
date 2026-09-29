/**
 * Facility discovery for the Live Counter.
 *
 * Kept as a pure function so the rule is directly testable and so the React
 * component stays free of selection logic.
 *
 * The board must never wedge itself on a configured id that does not exist: a
 * kiosk pointed at a removed facility would sit on "FEED UNAVAILABLE" forever
 * instead of falling back to a real one. So a configured default is only ever
 * adopted when the backend actually returns that center.
 */

/**
 * Choose which facility to display when no explicit `?centerId=` was given.
 *
 * @param {Array<{_id: string}>} centers centers returned by the backend
 * @param {string} configuredDefaultId value of VITE_DEFAULT_CENTER_ID (may be '')
 * @returns {string|null} a real center id, or null when there are no centers
 */
export function pickDiscoveredCenterId(centers, configuredDefaultId = '') {
  if (!Array.isArray(centers) || centers.length === 0) return null;

  const wanted = String(configuredDefaultId || '').trim();
  if (wanted) {
    const match = centers.find((c) => c && String(c._id) === wanted);
    if (match) return match._id;
  }

  return centers[0]._id;
}
