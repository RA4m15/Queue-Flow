import { useEffect } from 'react';

/** How long a skip note stays on the board before it clears itself. */
export const SKIP_ANNOUNCEMENT_TTL_MS = 8000;

/** Upper bound on simultaneously visible skip notes. */
export const MAX_SKIP_ANNOUNCEMENTS = 3;

/**
 * One skip note, owning its own lifetime.
 *
 * Each note is its own component precisely so that a note added later cannot
 * disturb an older one. If the stack shared a single effect, appending a second
 * note would tear down and restart the first note's timer, and a busy queue
 * could keep stale notes on the board indefinitely.
 */
function SkipAnnouncementNote({ item, onDismiss }) {
  useEffect(() => {
    const timer = setTimeout(() => {
      onDismiss?.(item.id);
    }, SKIP_ANNOUNCEMENT_TTL_MS);
    return () => clearTimeout(timer);
    // Keyed on the id only: the note's text never changes after it is created.
  }, [item.id, onDismiss]);

  return (
    <div className="skip-announcement" data-testid="skip-announcement">
      <div className="skip-announcement-tag">AUTO-SKIPPED</div>
      <div className="skip-announcement-body">
        <span className="skip-announcement-token" data-testid="skip-announcement-token">
          {item.tokenCode}
        </span>
        <span className="skip-announcement-reason" data-testid="skip-announcement-reason">
          {item.reasonText}
        </span>
      </div>
    </div>
  );
}

/**
 * Temporary floating announcements shown on a Live Counter board when queued
 * customers are automatically skipped for leaving the service area.
 *
 * Presentation rules, enforced by exactly what is rendered here:
 *  - No coordinates, no GPS accuracy, no internal IDs, and no backend state
 *    names (OUT_OF_RANGE / LOCATION_STALE / SKIPPED_OUT_OF_RANGE never appear).
 *  - Only the token code this board already displays publicly, plus plain
 *    language the server authored for customers.
 *  - Silent and self-dismissing. Voice is reserved for `token.called`.
 *  - Bounded, so a multi-skip CALL NEXT can never cover the board.
 */
export function SkipAnnouncement({ announcements, onDismiss }) {
  const items = Array.isArray(announcements) ? announcements : [];
  if (items.length === 0) return null;

  return (
    <div
      className="skip-announcement-stack"
      role="status"
      aria-live="polite"
      data-testid="skip-announcement-stack"
    >
      {items.map((item) => (
        <SkipAnnouncementNote key={item.id} item={item} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

/**
 * Turn a backend `token.skipped` payload into the minimal, safe, plain-language
 * text the board renders.
 *
 * Only the Phase 2 geofence auto-skip is announced. A manual operator skip
 * arrives on the same event and is deliberately not surfaced, because the board
 * already reflects the resulting queue state on the next `queue.updated`, and a
 * public display should not narrate routine operator housekeeping.
 *
 * The result is a display model only: it deliberately carries no internal id,
 * no coordinates and no accuracy, so there is nothing here for the board to
 * leak even by accident.
 *
 * @param {object} data raw `token.skipped` payload from the center room
 * @returns {{tokenCode: string, reasonText: string}|null}
 */
export function buildSkipAnnouncement(data) {
  if (!data || data.skipReason !== 'OUT_OF_RANGE') return null;

  const tokenCode = data?.token?.tokenCode;
  if (!tokenCode) return null;

  // The reason text is authored server-side as plain language and used
  // verbatim. If it were ever missing we fall back to fixed copy rather than
  // ever rendering a backend enum.
  const reasonText =
    typeof data?.token?.skipReasonText === 'string' && data.token.skipReasonText.trim()
      ? data.token.skipReasonText.trim()
      : 'customer is outside the service area';

  return { tokenCode: String(tokenCode), reasonText };
}

/**
 * Stable de-duplication identity for a skip event. Internal by design: this is
 * a React key and a list identity, never rendered, and it is the one place the
 * backend token id is used.
 */
function skipAnnouncementId(data) {
  return String(data?.token?._id || data?.token?.tokenCode || 'unknown');
}

/**
 * Append a freshly received `token.skipped` payload to the current stack.
 *
 * De-duplicates by token, ignores events that are not geofence auto-skips, and
 * keeps the list bounded so it can never cover the whole board. Pure, so it
 * can be used directly as a React state updater and unit-tested without a
 * renderer.
 *
 * @param {Array<{id: string, tokenCode: string, reasonText: string}>} current
 * @param {object} data raw `token.skipped` payload
 */
export function appendSkipAnnouncement(current, data) {
  const announcement = buildSkipAnnouncement(data);
  if (!announcement) return current;

  const id = skipAnnouncementId(data);
  if (current.some((item) => item.id === id)) return current;

  const next = [...current, { id, ...announcement }];
  return next.length > MAX_SKIP_ANNOUNCEMENTS
    ? next.slice(next.length - MAX_SKIP_ANNOUNCEMENTS)
    : next;
}

/**
 * Remove one skip note by its id.
 */
export function dismissSkipAnnouncement(current, id) {
  return current.filter((item) => item.id !== id);
}
