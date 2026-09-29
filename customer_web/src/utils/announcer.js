/**
 * QueueFlow Speech & Audio Announcement Utility
 * Uses the Web Speech API and Web Audio API with strict deduplication
 * to announce called tokens on TV displays and customer web pages.
 */

// Track announced event IDs locally to prevent duplicate announcements
// across socket reconnects, page re-renders, and network retries
const announcedCalloutKeys = new Set();
let isAudioMuted = false;

/**
 * Play a pleasant dual-tone chime before speech announcement.
 */
export function playChime() {
  // Audio announcements are exclusively handled by the Live Counter display kiosk.
}

export function announceTokenCall() {
  // Public speech announcement is handled exclusively by the Live Counter display kiosk.
  // The customer web app remains silent to prevent dual-voice collision.
  return false;
}

export function setMuted(muted) {
  isAudioMuted = Boolean(muted);
}

export function isMuted() {
  return isAudioMuted;
}

export function clearAnnouncedHistory() {
  announcedCalloutKeys.clear();
}
