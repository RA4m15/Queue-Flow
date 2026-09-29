import { describe, it, expect } from 'vitest';
import { pickDiscoveredCenterId } from '../services/centerSelection';

/**
 * A kiosk must never wedge itself on a configured facility that no longer
 * exists: doing so leaves the board stuck on "FEED UNAVAILABLE" instead of
 * falling back to a real center. These tests pin that rule.
 */
describe('live counter facility discovery', () => {
  const COLLEGE = '6ab93df8da6b1eefeb19caa2';
  const OTHER = '6ab77948e712763a816b1d7c';
  const CENTERS = [
    { _id: '6ab77948e712763a816b1d7c', name: 'Alert Center' },
    { _id: COLLEGE, name: 'College Account' },
  ];

  it('adopts the configured default when the backend really returns it', () => {
    expect(pickDiscoveredCenterId(CENTERS, COLLEGE)).toBe(COLLEGE);
  });

  it('ignores a configured default that does not exist and falls back', () => {
    expect(pickDiscoveredCenterId(CENTERS, '6ab93df8ffffffffffffff')).toBe(OTHER);
  });

  it('ignores a center NAME and only ever matches a real id', () => {
    expect(pickDiscoveredCenterId(CENTERS, 'College Account')).toBe(OTHER);
  });

  it('falls back to the first center when nothing is configured', () => {
    expect(pickDiscoveredCenterId(CENTERS, '')).toBe(OTHER);
    expect(pickDiscoveredCenterId(CENTERS)).toBe(OTHER);
    expect(pickDiscoveredCenterId(CENTERS, '   ')).toBe(OTHER);
  });

  it('returns null for an empty or invalid list so the UI can show its empty state', () => {
    expect(pickDiscoveredCenterId([], COLLEGE)).toBeNull();
    expect(pickDiscoveredCenterId(null, COLLEGE)).toBeNull();
    expect(pickDiscoveredCenterId(undefined)).toBeNull();
  });

  it('never hides other centers: every returned center stays reachable', () => {
    for (const c of CENTERS) {
      expect(pickDiscoveredCenterId(CENTERS, c._id)).toBe(c._id);
    }
    expect(CENTERS).toHaveLength(2);
  });
});
