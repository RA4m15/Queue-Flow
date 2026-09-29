/**
 * QueueFlow Live Counter Announcement System
 *
 * Provides:
 * - Clean pleasant Web Audio API notification chime
 * - Browser speech synthesis: "Token {TOKEN_CODE}, please proceed to Counter {COUNTER_NAME}."
 * - Strict event deduplication across socket retries/reconnects
 * - Sequential announcement queue to avoid overlapping speech
 * - Safe handling of browser autoplay restrictions and unlock gestures
 */

let isAudioMuted = false;
let isAudioUnlocked = typeof window === 'undefined' ? true : false;
let sharedAudioCtx = null;
const announcedCalloutKeys = new Set();
const announcementQueue = [];
let isProcessingQueue = false;
const unlockListeners = new Set();
let cachedVoice = null;

/**
 * Score a speech synthesis voice based on preferred characteristics:
 * 1. Prefer female Indian English voice (lang: 'en-IN', female name indicators)
 * 2. Prefer indicators: "India", "Indian", "Female", "Google", "Microsoft"
 * 3. Fallback to closest available en-IN voice
 * 4. Fallback to standard English voice without crashing
 * 5. Safe ultimate fallback to default / first available voice
 */
export function scoreVoice(voice) {
  if (!voice) return -1;
  const lang = (voice.lang || '').replace('_', '-').toLowerCase();
  const name = (voice.name || '').toLowerCase();

  const isEnIn = lang === 'en-in';
  const isEnglish = lang.startsWith('en');

  let score = 0;

  if (isEnIn) {
    score += 500;
  } else if (isEnglish) {
    score += 100;
  } else {
    // Non-English voice: lowest fallback
    return voice.default ? 2 : 1;
  }

  const femaleKeywords = [
    'female',
    'woman',
    'girl',
    'heera',
    'neerja',
    'veena',
    'lekha',
    'priya',
    'swara',
    'aditi',
    'kavya',
    'ananya',
    'isha',
    'zira',
    'aria',
    'jenny',
    'samantha',
    'victoria',
    'karen',
  ];
  const maleKeywords = ['male', 'man', 'boy', 'ravi', 'rishi', 'david', 'mark', 'george', 'guy'];

  const hasFemaleHint = femaleKeywords.some((kw) => name.includes(kw));
  const hasMaleHint = maleKeywords.some((kw) => name.includes(kw));

  if (hasFemaleHint && !hasMaleHint) {
    score += 300;
  } else if (hasMaleHint) {
    score -= 100;
  }

  // Quality and regional engine indicators
  if (name.includes('india') || name.includes('indian')) {
    score += 150;
  }
  if (name.includes('natural') || name.includes('online')) {
    score += 80;
  }
  if (name.includes('google')) {
    score += 60;
  }
  if (name.includes('microsoft')) {
    score += 50;
  }

  return score;
}

/**
 * Robustly select the best available voice from SpeechSynthesis.
 * Caches the selected voice and re-evaluates when voice list changes.
 */
export function selectVoice() {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
    return null;
  }

  const synth = window.speechSynthesis;
  const voices = typeof synth.getVoices === 'function' ? synth.getVoices() : [];

  if (!voices || voices.length === 0) {
    return cachedVoice;
  }

  const scored = voices
    .map((v) => ({ voice: v, score: scoreVoice(v) }))
    .sort((a, b) => b.score - a.score);

  const best = scored.length > 0 ? scored[0].voice : voices.find((v) => v.default) || voices[0] || null;

  if (best && (!cachedVoice || cachedVoice.name !== best.name || cachedVoice.lang !== best.lang)) {
    cachedVoice = best;
    console.log(`[Announcer] Selected voice: ${best.name} (${best.lang})`);
  }

  return cachedVoice || best;
}

/**
 * Ensure SpeechSynthesis voices are loaded before choosing the voice.
 */
export async function ensureVoice() {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
    return null;
  }
  let v = selectVoice();
  if (v) return v;

  return new Promise((resolve) => {
    const synth = window.speechSynthesis;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve(selectVoice());
    };
    if (typeof synth.addEventListener === 'function') {
      synth.addEventListener('voiceschanged', finish, { once: true });
    }
    setTimeout(finish, 400);
  });
}

/**
 * Register voiceschanged listener to handle asynchronous voice loading.
 */
export function initVoiceSelection() {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
  const synth = window.speechSynthesis;

  selectVoice();

  if (typeof synth.addEventListener === 'function') {
    synth.addEventListener('voiceschanged', () => {
      cachedVoice = null;
      selectVoice();
    });
  } else if ('onvoiceschanged' in synth) {
    synth.onvoiceschanged = () => {
      cachedVoice = null;
      selectVoice();
    };
  }
}

// Auto-initialize if running in browser
if (typeof window !== 'undefined') {
  initVoiceSelection();
}

/**
 * Returns the shared AudioContext instance.
 */
export function getAudioContext() {
  if (typeof window === 'undefined') return null;
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return null;
  if (!sharedAudioCtx) {
    try {
      sharedAudioCtx = new AudioContextClass();
    } catch {
      return null;
    }
  }
  return sharedAudioCtx;
}

/**
 * Check if sound has been unlocked by user interaction or environment.
 */
export function isSoundUnlocked() {
  if (typeof window === 'undefined') return true;
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return true;
  const ctx = getAudioContext();
  if (ctx && ctx.state === 'running') {
    return true;
  }
  return isAudioUnlocked;
}

/**
 * Register a listener for unlock state changes.
 */
export function onSoundUnlockChange(listener) {
  unlockListeners.add(listener);
  return () => unlockListeners.delete(listener);
}

function notifyUnlockListeners(unlocked) {
  for (const listener of unlockListeners) {
    try {
      listener(unlocked);
    } catch (e) {
      console.warn('[Announcer] Listener error:', e);
    }
  }
}

/**
 * Unlock Web Audio and SpeechSynthesis via user interaction gesture.
 */
export async function unlockAudio() {
  if (typeof window === 'undefined') return true;
  try {
    const ctx = getAudioContext();
    if (ctx && ctx.state === 'suspended') {
      await ctx.resume();
    }
    if (typeof window.speechSynthesis !== 'undefined' && window.speechSynthesis.paused) {
      window.speechSynthesis.resume();
    }
    isAudioUnlocked = true;
    notifyUnlockListeners(true);
    return true;
  } catch (err) {
    console.warn('[Announcer] Could not unlock audio context:', err);
    return false;
  }
}

// Auto-unlock on first user interaction gesture anywhere on the window
if (typeof window !== 'undefined') {
  const handleFirstInteraction = () => {
    unlockAudio();
    if (isSoundUnlocked()) {
      window.removeEventListener('click', handleFirstInteraction);
      window.removeEventListener('keydown', handleFirstInteraction);
      window.removeEventListener('pointerdown', handleFirstInteraction);
    }
  };
  window.addEventListener('click', handleFirstInteraction, { passive: true });
  window.addEventListener('keydown', handleFirstInteraction, { passive: true });
  window.addEventListener('pointerdown', handleFirstInteraction, { passive: true });
}

/**
 * Play a clean pleasant notification chime using Web Audio API.
 * Dual-tone sine wave (D5 -> A5) with gentle exponential decay.
 * Returns a promise that resolves when the chime completes (~680ms).
 */
export function playChime() {
  return new Promise(async (resolve) => {
    if (isAudioMuted || typeof window === 'undefined') {
      return resolve(false);
    }

    try {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) {
        console.warn('[Announcer] Web Audio API not supported in this browser');
        return resolve(false);
      }

      const ctx = getAudioContext();
      if (!ctx) {
        console.warn('[Announcer] Failed to obtain AudioContext');
        return resolve(false);
      }

      if (ctx.state === 'suspended') {
        try {
          await ctx.resume();
        } catch (e) {
          console.warn('[Announcer] Could not resume suspended AudioContext:', e);
        }
      }

      console.log('[Announcer] playing chime (AudioContext state:', ctx.state + ')');

      const now = ctx.currentTime;

      // Tone 1: D5 (587.33 Hz)
      const osc1 = ctx.createOscillator();
      const gain1 = ctx.createGain();
      osc1.type = 'sine';
      osc1.frequency.setValueAtTime(587.33, now);
      gain1.gain.setValueAtTime(0.25, now);
      gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
      osc1.connect(gain1);
      gain1.connect(ctx.destination);
      osc1.start(now);
      osc1.stop(now + 0.35);

      // Tone 2: A5 (880.00 Hz)
      const osc2 = ctx.createOscillator();
      const gain2 = ctx.createGain();
      osc2.type = 'sine';
      osc2.frequency.setValueAtTime(880, now + 0.18);
      gain2.gain.setValueAtTime(0.25, now + 0.18);
      gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.65);
      osc2.connect(gain2);
      gain2.connect(ctx.destination);
      osc2.start(now + 0.18);
      osc2.stop(now + 0.65);

      setTimeout(() => resolve(true), 680);
    } catch (err) {
      console.warn('[Announcer] Could not play chime:', err);
      resolve(false);
    }
  });
}

// Global reference prevents Chrome from garbage-collecting utterance mid-speech
let activeUtterance = null;

/**
 * Speak an announcement utterance using window.speechSynthesis.
 * Returns a promise that resolves when the speech completes.
 */
export function speakUtterance(phrase) {
  return new Promise(async (resolve) => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
      console.warn('[Announcer] SpeechSynthesis not available in this window');
      return resolve(false);
    }

    try {
      const synth = window.speechSynthesis;

      // Reset any pending or stuck utterances
      synth.cancel();
      if (synth.paused) {
        synth.resume();
      }

      // Short pause to avoid Chromium cancel-then-speak drop
      await new Promise((r) => setTimeout(r, 60));

      const utterance = new SpeechSynthesisUtterance(phrase);
      utterance._fromVoicePathA = true;
      const voice = await ensureVoice();
      if (voice) {
        utterance.voice = voice;
        utterance.lang = voice.lang || 'en-IN';
      } else {
        utterance.lang = 'en-IN';
      }
      // Calm, polite, professional public-announcement parameters
      utterance.rate = 0.94;
      utterance.pitch = 1.05;
      utterance.volume = 1.0;

      // Keep reference to prevent GC premature termination
      activeUtterance = utterance;
      if (typeof window !== 'undefined') {
        window._activeUtterance = utterance;
      }

      let finished = false;
      const onDone = (reason) => {
        if (!finished) {
          finished = true;
          console.log(`[Announcer] Speech completed (${reason})`);
          activeUtterance = null;
          resolve(true);
        }
      };

      utterance.onstart = () => {
        console.log('[Announcer] Speech started:', phrase);
      };

      utterance.onend = () => {
        onDone('onend');
      };

      utterance.onerror = (e) => {
        console.warn('[Announcer] SpeechSynthesis error:', e);
        onDone('onerror');
      };

      // Safety timeout in case browser never fires onend
      setTimeout(() => onDone('timeout'), 8000);

      if (synth.paused) {
        synth.resume();
      }

      console.log(`[VOICE PATH A] speaking: "${phrase}" (Voice: ${utterance.voice?.name || 'en-IN'})`);
      synth.speak(utterance);
    } catch (err) {
      console.warn('[Announcer] Speech synthesis error:', err);
      resolve(false);
    }
  });
}

// Step 4: Instrument window.speechSynthesis.speak to detect any rogue/duplicate speech paths
if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
  try {
    const synthObj = window.speechSynthesis;
    if (!window._speechInstrumented && typeof synthObj.speak === 'function') {
      const origSpeak = synthObj.speak.bind(synthObj);
      window._speechInstrumented = true;
      synthObj.speak = function (utt) {
        if (utt && utt._fromVoicePathA) {
          return origSpeak(utt);
        }
        console.warn(`[VOICE PATH B] UNEXPECTED SPEECH CALL DETECTED! text: "${utt?.text}" (voice: ${utt?.voice?.name || 'default'})`);
        console.trace('[VOICE PATH B] Call stack:');
        // Block the duplicate / legacy speech path from interfering with the good voice
        return;
      };
    }
  } catch (e) {
    console.warn('[Announcer] Could not attach speech interceptor:', e);
  }
}

/**
 * Format the counter string safely into "Counter {COUNTER_NAME}".
 */
export function formatCounterTarget(counterName) {
  if (!counterName || typeof counterName !== 'string') return '';
  const trimmed = counterName.trim();
  if (!trimmed) return '';
  if (trimmed.toLowerCase().startsWith('counter')) {
    return trimmed;
  }
  return `Counter ${trimmed}`;
}

const CROSS_TAB_STORAGE_KEY = 'qf_live_counter_last_callout';

function isAnnouncedCrossTab(key) {
  if (typeof window === 'undefined' || !window.localStorage) return false;
  try {
    const raw = window.localStorage.getItem(CROSS_TAB_STORAGE_KEY);
    if (!raw) return false;
    const parsed = JSON.parse(raw);
    if (parsed.key === key && Date.now() - parsed.timestamp < 10000) {
      return true;
    }
  } catch {
    // Ignore localStorage failures
  }
  return false;
}

function markAnnouncedCrossTab(key) {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    window.localStorage.setItem(
      CROSS_TAB_STORAGE_KEY,
      JSON.stringify({ key, timestamp: Date.now() })
    );
  } catch {
    // Ignore localStorage failures
  }
}

/**
 * Announce a called token.
 * Sequence: Deduplicate -> enqueue -> play chime -> speak utterance.
 * Sequential processing ensures multiple calls never talk over each other.
 *
 * @param {object} params
 * @param {string} params.tokenCode - e.g. "C-023"
 * @param {string} params.counterName - e.g. "Counter 01" or "01"
 * @param {string} [params.tokenId] - MongoDB _id or unique token identifier
 * @param {string|Date} [params.calledAt] - Timestamp
 * @returns {boolean} Whether the announcement was enqueued
 */
export function announceTokenCall({ tokenCode, counterName, tokenId, calledAt }) {
  console.log(`[Announcer] announceTokenCall(token: ${tokenCode}, counter: ${counterName})`);
  console.log('[Announcer] audio unlocked =', isSoundUnlocked(), '| muted =', isAudioMuted);

  if (isAudioMuted) {
    console.log('[Announcer] Audio is muted, skipping playback');
    return false;
  }

  // Validate presence of real tokenCode and counterName
  if (!tokenCode || typeof tokenCode !== 'string' || !tokenCode.trim()) {
    console.warn('[Announcer] Cannot announce: missing tokenCode', { tokenCode, counterName });
    return false;
  }

  if (!counterName || typeof counterName !== 'string' || !counterName.trim()) {
    console.warn('[Announcer] Cannot announce: missing counter data (no false announcement generated)', {
      tokenCode,
      counterName,
    });
    return false;
  }

  // Deduplication check (memory and cross-tab/cross-window)
  const normalizedCode = tokenCode.trim().toUpperCase();
  const dedupeKey = `${tokenId || tokenCode}_${calledAt || counterName}`;
  if (
    announcedCalloutKeys.has(dedupeKey) ||
    announcedCalloutKeys.has(normalizedCode) ||
    isAnnouncedCrossTab(dedupeKey) ||
    isAnnouncedCrossTab(normalizedCode)
  ) {
    console.log('[Announcer] Duplicate token call ignored (key:', dedupeKey + ')');
    return false;
  }
  announcedCalloutKeys.add(dedupeKey);
  announcedCalloutKeys.add(normalizedCode);
  markAnnouncedCrossTab(dedupeKey);
  markAnnouncedCrossTab(normalizedCode);

  // Prune history to prevent memory leak
  if (announcedCalloutKeys.size > 500) {
    const oldestKey = announcedCalloutKeys.values().next().value;
    announcedCalloutKeys.delete(oldestKey);
  }

  announcementQueue.push({ tokenCode, counterName, tokenId, calledAt });
  processQueue();
  return true;
}

/**
 * Sequential announcement queue processor.
 */
async function processQueue() {
  if (isProcessingQueue) return;
  isProcessingQueue = true;

  while (announcementQueue.length > 0) {
    const current = announcementQueue[0];
    try {
      if (!isAudioMuted) {
        // 1. Play short chime
        await playChime();

        // 2. Immediately speak announcement
        const counterTarget = formatCounterTarget(current.counterName);
        const phrase = `Token ${current.tokenCode}... please proceed to ${counterTarget}.`;
        console.log('[Announcer] speaking announcement:', phrase);
        await speakUtterance(phrase);
      }
    } catch (err) {
      console.warn('[Announcer] Error processing announcement queue:', err);
    } finally {
      announcementQueue.shift();
    }
  }

  isProcessingQueue = false;
}

export function setMuted(muted) {
  isAudioMuted = Boolean(muted);
}

export function isMuted() {
  return isAudioMuted;
}

export function clearAnnouncedHistory() {
  announcedCalloutKeys.clear();
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.removeItem(CROSS_TAB_STORAGE_KEY);
    }
  } catch { }
}

export function resetAnnouncerState() {
  announcedCalloutKeys.clear();
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.removeItem(CROSS_TAB_STORAGE_KEY);
    }
  } catch { }
  announcementQueue.length = 0;
  isProcessingQueue = false;
  isAudioMuted = false;
  sharedAudioCtx = null;
  isAudioUnlocked = true;
  cachedVoice = null;
}

export function getAnnouncementQueueLength() {
  return announcementQueue.length;
}

export function isQueueProcessing() {
  return isProcessingQueue;
}
