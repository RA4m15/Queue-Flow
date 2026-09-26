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
  if (isAudioMuted || typeof window === 'undefined') return;
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    const ctx = new AudioContext();

    const now = ctx.currentTime;
    // High note
    const osc1 = ctx.createOscillator();
    const gain1 = ctx.createGain();
    osc1.type = 'sine';
    osc1.frequency.setValueAtTime(587.33, now); // D5
    gain1.gain.setValueAtTime(0.15, now);
    gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
    osc1.connect(gain1);
    gain1.connect(ctx.destination);
    osc1.start(now);
    osc1.stop(now + 0.35);

    // Chime resolution note
    const osc2 = ctx.createOscillator();
    const gain2 = ctx.createGain();
    osc2.type = 'sine';
    osc2.frequency.setValueAtTime(880, now + 0.15); // A5
    gain2.gain.setValueAtTime(0.15, now + 0.15);
    gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.6);
    osc2.connect(gain2);
    gain2.connect(ctx.destination);
    osc2.start(now + 0.15);
    osc2.stop(now + 0.6);
  } catch {
    // Ignore audio context errors if blocked by browser autoplay policy
  }
}

/**
 * Announce a called token using browser Web Speech API.
 * Deduplicates automatically so the same token call is never spoken twice.
 *
 * @param {object} params
 * @param {string} params.tokenCode - e.g. "A-014"
 * @param {string} params.counterName - e.g. "Counter 2"
 * @param {string} [params.tokenId] - Unique token ID or callout key
 * @param {string|Date} [params.calledAt] - Timestamp
 */
export function announceTokenCall({ tokenCode, counterName, tokenId, calledAt }) {
  if (isAudioMuted || !tokenCode) return false;

  const dedupeKey = `${tokenId || tokenCode}_${calledAt || ''}`;
  if (announcedCalloutKeys.has(dedupeKey)) {
    return false; // Already announced
  }

  announcedCalloutKeys.add(dedupeKey);

  // Play chime
  playChime();

  if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
    try {
      window.speechSynthesis.cancel(); // Cancel any ongoing speech
      const phrase = `Token ${tokenCode.replace('-', ' ')}, please proceed to ${counterName || 'the counter'}.`;
      const utterance = new SpeechSynthesisUtterance(phrase);
      utterance.rate = 0.9;
      utterance.pitch = 1.0;
      utterance.volume = 1.0;
      utterance.lang = 'en-US';
      window.speechSynthesis.speak(utterance);
      return true;
    } catch {
      return false;
    }
  }

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
