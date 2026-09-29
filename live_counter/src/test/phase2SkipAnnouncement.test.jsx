import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import {
  SkipAnnouncement,
  buildSkipAnnouncement,
  appendSkipAnnouncement,
  dismissSkipAnnouncement,
  SKIP_ANNOUNCEMENT_TTL_MS,
  MAX_SKIP_ANNOUNCEMENTS,
} from '../components/SkipAnnouncement';

/**
 * Phase 2 geofencing on the public Live Counter board.
 *
 * A customer auto-skipped for leaving the service area must surface as a
 * temporary, self-dismissing public note, with hard limits on what it may say.
 * A public TV screen is the worst possible place to leak a customer's position,
 * so these tests pin the privacy contract as strictly as the timing one.
 */

/** Exactly the center-room payload the backend emits for a geofence auto-skip. */
const SKIP_EVENT = {
  centerId: 'center-1',
  skipReason: 'OUT_OF_RANGE',
  token: {
    _id: 'tok-024',
    tokenCode: 'C-024',
    tokenNumber: 24,
    status: 'SKIPPED_OUT_OF_RANGE',
    skipReason: 'OUT_OF_RANGE',
    skipReasonText: 'outside service area',
    skippedAt: '2026-09-28T10:00:00.000Z',
    // Hypothetical extra fields. The board must never echo these either.
    latitude: 12.9716,
    longitude: 77.5946,
    accuracy: 8.5,
  },
};

/** The same auto-skip for a different customer. */
const skipEventFor = (id, tokenCode) => ({
  ...SKIP_EVENT,
  token: { ...SKIP_EVENT.token, _id: id, tokenCode },
});

/** Push a list of raw events through the stack reducer. */
const stackFor = (...events) => events.reduce(appendSkipAnnouncement, []);

describe('live counter skip announcement — building the note', () => {
  it('builds a note for a Phase 2 out-of-range auto-skip', () => {
    expect(buildSkipAnnouncement(SKIP_EVENT)).toEqual({
      tokenCode: 'C-024',
      reasonText: 'outside service area',
    });
  });

  it('never carries coordinates, GPS accuracy, or internal identifiers', () => {
    const rendered = JSON.stringify(buildSkipAnnouncement(SKIP_EVENT));
    expect(rendered).not.toMatch(/12\.97/);
    expect(rendered).not.toMatch(/77\.59/);
    expect(rendered).not.toMatch(/accuracy/i);
    expect(rendered).not.toMatch(/tok-024/); // the internal _id
  });

  it('never carries a technical backend state name to the public', () => {
    const rendered = JSON.stringify(buildSkipAnnouncement(SKIP_EVENT));
    expect(rendered).not.toMatch(/OUT_OF_RANGE/);
    expect(rendered).not.toMatch(/SKIPPED_OUT_OF_RANGE/);
    expect(rendered).not.toMatch(/LOCATION_STALE|LOCATION_UNAVAILABLE|IN_RANGE/);
  });

  it('ignores a manual operator skip, which is not a public announcement', () => {
    expect(buildSkipAnnouncement({ token: { tokenCode: 'C-030' }, skipReason: 'MANUAL' })).toBeNull();
    expect(buildSkipAnnouncement({ token: { tokenCode: 'C-030' } })).toBeNull();
  });

  it('never announces a skip it cannot label', () => {
    expect(buildSkipAnnouncement({ skipReason: 'OUT_OF_RANGE' })).toBeNull();
    expect(buildSkipAnnouncement({ skipReason: 'OUT_OF_RANGE', token: {} })).toBeNull();
  });

  it('tolerates a malformed payload without throwing', () => {
    expect(buildSkipAnnouncement(null)).toBeNull();
    expect(buildSkipAnnouncement(undefined)).toBeNull();
    expect(buildSkipAnnouncement({})).toBeNull();
  });

  it('falls back to fixed copy rather than an enum when reason text is missing', () => {
    const note = buildSkipAnnouncement({ skipReason: 'OUT_OF_RANGE', token: { tokenCode: 'C-1' } });
    expect(note.reasonText).toBe('customer is outside the service area');
    expect(note.reasonText).not.toMatch(/OUT_OF_RANGE/);
  });
});

describe('live counter skip announcement — several skips from one CALL NEXT', () => {
  it('stacks one note per skipped customer so a multi-skip call is fully shown', () => {
    const stack = stackFor(SKIP_EVENT, skipEventFor('tok-025', 'C-025'));
    expect(stack.map((n) => n.tokenCode)).toEqual(['C-024', 'C-025']);
  });

  it('keeps FIFO order, exactly as the backend skipped them', () => {
    const stack = stackFor(
      skipEventFor('tok-024', 'C-024'),
      skipEventFor('tok-025', 'C-025'),
      skipEventFor('tok-026', 'C-026')
    );
    expect(stack.map((n) => n.tokenCode)).toEqual(['C-024', 'C-025', 'C-026']);
  });

  it('collapses a duplicated socket delivery of the same token', () => {
    expect(stackFor(SKIP_EVENT, SKIP_EVENT)).toHaveLength(1);
  });

  it('is a no-op for a payload that is not a geofence auto-skip', () => {
    expect(stackFor({ token: { tokenCode: 'C-030' }, skipReason: 'MANUAL' })).toEqual([]);
    expect(stackFor(null)).toEqual([]);
  });

  it('is bounded so notes can never cover the whole board', () => {
    const events = Array.from({ length: MAX_SKIP_ANNOUNCEMENTS + 4 }, (_, i) =>
      skipEventFor(`tok-${i}`, `C-${100 + i}`)
    );
    const stack = stackFor(...events);

    expect(stack).toHaveLength(MAX_SKIP_ANNOUNCEMENTS);
    // Oldest notes fall off the top; the three most recent survive.
    expect(stack.map((n) => n.tokenCode)).toEqual(['C-104', 'C-105', 'C-106']);
  });

  it('dismisses exactly one note by id', () => {
    const stack = stackFor(SKIP_EVENT, skipEventFor('tok-025', 'C-025'));
    expect(dismissSkipAnnouncement(stack, 'tok-024').map((n) => n.id)).toEqual(['tok-025']);
    expect(dismissSkipAnnouncement(stack, 'unknown')).toHaveLength(2);
  });
});

describe('live counter skip announcement — rendering', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders the token code and plain-language reason, and nothing sensitive', () => {
    render(<SkipAnnouncement announcements={stackFor(SKIP_EVENT)} onDismiss={() => {}} />);

    expect(screen.getByTestId('skip-announcement-token')).toHaveTextContent('C-024');
    expect(screen.getByTestId('skip-announcement-reason')).toHaveTextContent('outside service area');

    const text = document.body.textContent;
    expect(text).not.toMatch(/12\.97|77\.59/);
    expect(text).not.toMatch(/accuracy/i);
    expect(text).not.toMatch(/OUT_OF_RANGE|SKIPPED_OUT_OF_RANGE|tok-024/);
  });

  it('renders nothing at all when there is no skip', () => {
    render(<SkipAnnouncement announcements={[]} onDismiss={() => {}} />);
    expect(screen.queryByTestId('skip-announcement-stack')).toBeNull();
  });

  it('auto-dismisses after its lifetime', () => {
    const onDismiss = vi.fn();
    render(<SkipAnnouncement announcements={stackFor(SKIP_EVENT)} onDismiss={onDismiss} />);

    act(() => { vi.advanceTimersByTime(SKIP_ANNOUNCEMENT_TTL_MS - 1); });
    expect(onDismiss).not.toHaveBeenCalled();

    act(() => { vi.advanceTimersByTime(1); });
    expect(onDismiss).toHaveBeenCalledWith('tok-024');
  });

  it('gives each note its own lifetime so a later skip does not cancel an earlier one', () => {
    const onDismiss = vi.fn();
    const { rerender } = render(
      <SkipAnnouncement announcements={stackFor(SKIP_EVENT)} onDismiss={onDismiss} />
    );

    // Halfway through the first note's life, a second skip arrives.
    act(() => { vi.advanceTimersByTime(SKIP_ANNOUNCEMENT_TTL_MS / 2); });
    rerender(
      <SkipAnnouncement
        announcements={stackFor(SKIP_EVENT, skipEventFor('tok-025', 'C-025'))}
        onDismiss={onDismiss}
      />
    );

    act(() => { vi.advanceTimersByTime(SKIP_ANNOUNCEMENT_TTL_MS / 2); });
    // The first note reached its own deadline; the second has not.
    expect(onDismiss).toHaveBeenCalledWith('tok-024');
    expect(onDismiss).not.toHaveBeenCalledWith('tok-025');

    act(() => { vi.advanceTimersByTime(SKIP_ANNOUNCEMENT_TTL_MS / 2); });
    expect(onDismiss).toHaveBeenCalledWith('tok-025');
  });

  it('renders every stacked skip as its own note', () => {
    render(
      <SkipAnnouncement
        announcements={stackFor(SKIP_EVENT, skipEventFor('tok-025', 'C-025'))}
        onDismiss={() => {}}
      />
    );
    expect(screen.getAllByTestId('skip-announcement')).toHaveLength(2);
    expect(screen.getByText('C-024')).toBeInTheDocument();
    expect(screen.getByText('C-025')).toBeInTheDocument();
  });

  it('is silent: a skip is a polite live region, never an assertive alert', () => {
    render(<SkipAnnouncement announcements={stackFor(SKIP_EVENT)} onDismiss={() => {}} />);

    // The ticket callout is the only assertive announcement on this board; a
    // routine skip must not interrupt a screen reader the way a call does.
    const stack = screen.getByTestId('skip-announcement-stack');
    expect(stack).toHaveAttribute('role', 'status');
    expect(stack).toHaveAttribute('aria-live', 'polite');
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
