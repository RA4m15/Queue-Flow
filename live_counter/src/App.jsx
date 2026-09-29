import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { fetchDisplayData, fetchCenters } from './services/api';
import { initDisplaySocket, closeDisplaySocket } from './services/socket';
import { pickDiscoveredCenterId } from './services/centerSelection';
import {
  announceTokenCall,
  playChime,
  isMuted as isAnnouncerMuted,
  setMuted as setAnnouncerMuted,
  isSoundUnlocked,
  unlockAudio,
  onSoundUnlockChange,
} from './services/announcer';
import { LiveHeader } from './components/LiveHeader';
import { CalloutBanner } from './components/CalloutBanner';
import { SkipAnnouncement, appendSkipAnnouncement, dismissSkipAnnouncement } from './components/SkipAnnouncement';
import { NowServingHero } from './components/NowServingHero';
import { NextTokenCard } from './components/NextTokenCard';
import { CountersGrid } from './components/CountersGrid';
import { FootfallMetric } from './components/FootfallMetric';
import { QueueStats } from './components/QueueStats';
import { JoinQrPanel } from './components/JoinQrPanel';
import {
  buildCountersState,
  updateCounterOnTokenCalled,
  updateCounterOnTokenServing,
  clearCounterToken,
  updateCounterMetadata,
} from './services/counterState';

// A crowd reading older than this is treated as no reading at all, so a camera
// that stopped reporting shows "Unavailable" instead of a frozen count.
const CROWD_SENSOR_STALE_MS = 90000;

// Optional default facility for kiosk displays that are opened without a
// `centerId` query parameter. This is the REAL persisted MongoDB _id of the
// center (as returned by POST /api/service-centers) - never a name. An
// explicit `?centerId=` in the URL always takes precedence, so an operator can
// always point a specific screen at a different facility without reconfiguring
// the build.
const DEFAULT_CENTER_ID = (import.meta.env.VITE_DEFAULT_CENTER_ID || '').trim();

export function App() {
  const [centers, setCenters] = useState([]);
  // Only an explicit ?centerId= in the URL selects a facility immediately.
  // The configured default is treated as a *candidate* and is adopted during
  // center discovery, so a default that no longer exists falls back to normal
  // discovery instead of wedging the board on a "feed unavailable" error.
  const [selectedCenterId, setSelectedCenterId] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get('centerId') || '';
  });
  const [selectedServiceId] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get('serviceId') || null;
  });

  const [displayData, setDisplayData] = useState(null);
  const [counters, setCounters] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [connectionStatus, setConnectionStatus] = useState('disconnected');
  const [lastUpdated, setLastUpdated] = useState(null);
  const [activeCallout, setActiveCallout] = useState(null);
  // Phase 2 geofence auto-skips. A stack, not a single slot, because one CALL
  // NEXT can legitimately skip several customers before it calls the next
  // eligible token, and the board should show all of them.
  const [skipAnnouncements, setSkipAnnouncements] = useState([]);
  const [isMuted, setIsMuted] = useState(() => isAnnouncerMuted());
  const [isAudioUnlocked, setIsAudioUnlocked] = useState(() => isSoundUnlocked());

  useEffect(() => {
    return onSoundUnlockChange((unlocked) => {
      setIsAudioUnlocked(unlocked);
    });
  }, []);

  // Sync mute state with announcer and ref
  // Mute state must NOT be a dependency of the socket effect: the effect tears
  // the socket down on cleanup, so toggling mute used to disconnect and
  // re-establish the realtime stream on every click. Read it through a ref.
  const isMutedRef = useRef(isMuted);
  useEffect(() => {
    isMutedRef.current = isMuted;
    setAnnouncerMuted(isMuted);
  }, [isMuted]);

  const handleToggleSound = useCallback(async () => {
    const wasUnlocked = isSoundUnlocked();
    await unlockAudio();
    setIsMuted((prev) => {
      const willBeMuted = wasUnlocked ? !prev : false;
      if (!willBeMuted) {
        console.log('[LiveCounter] Sound enabled - testing chime through laptop speakers');
        playChime().catch((err) => console.warn('[LiveCounter] Test chime error:', err));
      }
      return willBeMuted;
    });
  }, []);

  // Live crowd telemetry
  const [liveFootfall, setLiveFootfall] = useState(null);
  const [crowdStatus, setCrowdStatus] = useState(null);
  const [crowdPercent, setCrowdPercent] = useState(null);
  // Freshness of the last real sensor reading. This MUST come from the sensor
  // timestamp, never from "when did the browser last poll" — otherwise a dead
  // camera looks fresh forever because the stored count is re-read every 30s.
  const [lastFootfallUpdate, setLastFootfallUpdate] = useState(null);
  const [crowdSensorOnline, setCrowdSensorOnline] = useState(false);
  const [nowTick, setNowTick] = useState(() => Date.now());

  // Authoritative displayToken for Socket.IO authentication
  const [displayToken, setDisplayToken] = useState(null);
  // True once the REST load has run and told us whether the backend issued a
  // socket credential. The socket cannot be attempted without it, so this
  // drives an explicit, truthful UI state instead of a silently dead board.
  const [displayTokenChecked, setDisplayTokenChecked] = useState(false);

  // 1. Initial Center Discovery (if no centerId in URL)
  useEffect(() => {
    async function loadCentersList() {
      try {
        const list = await fetchCenters();
        setCenters(list);
        if (!selectedCenterId && list.length > 0) {
          // Prefer the configured demo facility, but only when it is a real,
          // still-present center. Otherwise fall back to the first one the
          // backend returns, exactly as before.
          setSelectedCenterId(pickDiscoveredCenterId(list, DEFAULT_CENTER_ID));
        } else if (list.length === 0) {
          setLoading(false);
        }
      } catch (err) {
        console.error('Failed to query available centers:', err);
        setLoading(false);
      }
    }

    if (!selectedCenterId) {
      loadCentersList();
    }
  }, [selectedCenterId]);

  // 2. Authoritative Fetch
  const loadDisplay = useCallback(async (centerId = selectedCenterId) => {
    if (!centerId) {
      setLoading(false);
      return;
    }

    try {
      setError(null);
      const data = await fetchDisplayData(centerId);
      setDisplayData(data);
      setCounters(buildCountersState(data.counters, data.nowServing));
      setLastUpdated(new Date());

      // Update footfall from authoritative initial state.
      // Freshness comes from the sensor timestamp, not from this fetch time.
      if (typeof data.center?.currentCrowd === 'number') {
        setLiveFootfall(data.center.currentCrowd);
        // Adopted verbatim: the backend owns the classification, so this board
        // can never label a reading differently from the Admin dashboard.
        setCrowdStatus(data.center.crowdStatus ?? null);
        setCrowdPercent(data.center.crowdPercent ?? null);
        const stamp = data.center.crowdUpdatedAt ? new Date(data.center.crowdUpdatedAt) : null;
        setLastFootfallUpdate(stamp && !Number.isNaN(stamp.getTime()) ? stamp : null);
        setCrowdSensorOnline(Boolean(data.center.crowdSensorOnline));
      } else {
        setLiveFootfall(null);
        setCrowdStatus(null);
        setCrowdPercent(null);
        setLastFootfallUpdate(null);
        setCrowdSensorOnline(false);
      }

      // Store displayToken for socket connection
      if (data.displayToken) {
        setDisplayToken((prev) => (prev ? prev : data.displayToken));
      }
      setDisplayTokenChecked(true);

      // Dismiss active callout notice if authoritative data shows the token has reached SERVING status
      if (Array.isArray(data.nowServing)) {
        setActiveCallout((current) => {
          if (!current) return null;
          const matchingToken = data.nowServing.find(
            (t) =>
              (t.tokenCode && t.tokenCode === current.tokenCode) ||
              (t._id && current.tokenId && String(t._id) === String(current.tokenId))
          );
          if (matchingToken && matchingToken.status === 'SERVING') {
            return null;
          }
          return current;
        });
      }
    } catch (err) {
      setError(err.message || 'Failed to connect to queue backend');
    } finally {
      setLoading(false);
    }
  }, [selectedCenterId]);

  const loadDisplayRef = useRef(loadDisplay);
  useEffect(() => {
    loadDisplayRef.current = loadDisplay;
  }, [loadDisplay]);

  // Initial load and periodic safety sync (every 30s)
  useEffect(() => {
    if (!selectedCenterId) return;
    loadDisplay(selectedCenterId);

    const safetySyncTimer = setInterval(() => {
      loadDisplayRef.current?.(selectedCenterId);
    }, 30000);

    return () => clearInterval(safetySyncTimer);
  }, [selectedCenterId]);

  // 3. Socket.IO Real-time Synchronization
  useEffect(() => {
    if (!selectedCenterId || !displayToken) return;

    const socket = initDisplaySocket({
      centerId: selectedCenterId,
      displayToken,
      onStatusChange: (status) => {
        setConnectionStatus(status);
      },
      onReconnect: () => {
        loadDisplayRef.current?.(selectedCenterId);
      },
      onEvent: (eventName, data) => {
        setLastUpdated(new Date());

        // Center isolation: Ignore events belonging to other centers
        const eventCenterId =
          data?.centerId ||
          data?.token?.centerId?._id ||
          data?.token?.centerId ||
          data?.counter?.centerId?._id ||
          data?.counter?.centerId;

        if (eventCenterId && selectedCenterId && String(eventCenterId) !== String(selectedCenterId)) {
          return;
        }

        if (eventName === 'crowd.updated') {
          // Absolute current occupancy from the CCTV/IoT sensor. Replace, never accumulate.
          const newCount = typeof data?.currentCrowd === 'number' ? data.currentCrowd : data?.count;
          if (typeof newCount === 'number') {
            setLiveFootfall(newCount);
            // Status and percentage are the backend's own derivation, adopted
            // as-is so the board and the Admin dashboard always agree.
            setCrowdStatus(data.crowdStatus ?? null);
            setCrowdPercent(data.crowdPercent ?? null);
            // Freshness: prefer the server's sensor stamp, fall back to event time.
            const rawStamp = data.crowdUpdatedAt || data?.event?.timestamp;
            const stamp = rawStamp ? new Date(rawStamp) : new Date();
            setLastFootfallUpdate(Number.isNaN(stamp.getTime()) ? new Date() : stamp);
            setCrowdSensorOnline(Boolean(data.crowdSensorOnline !== false));
          }
          return;
        }

        if (eventName === 'token.called') {
          const token = data?.token;
          const counter = data?.counter;
          console.log('[LiveCounter] token.called received in App.jsx:', { token, counter });
          if (token && token.tokenCode) {
            // Authoritative counter name from backend event - never invent or fabricate
            const resolvedCounterName =
              counter?.displayLabel ||
              counter?.name ||
              (counter?.number ? `Counter ${String(counter.number).padStart(2, '0')}` : null) ||
              (token.counterId?.displayLabel ? token.counterId.displayLabel : null) ||
              (token.counterId?.name ? token.counterId.name : null) ||
              (token.counterId?.number ? `Counter ${String(token.counterId.number).padStart(2, '0')}` : null);

            if (resolvedCounterName) {
              setActiveCallout({
                tokenId: token._id || token.id,
                tokenCode: token.tokenCode,
                tokenNumber: token.tokenNumber || null,
                counterName: resolvedCounterName,
                calledAt: token.calledAt || new Date().toISOString(),
              });

              if (!isMutedRef.current) {
                announceTokenCall({
                  tokenCode: token.tokenCode,
                  counterName: resolvedCounterName,
                  tokenId: token._id || token.id,
                  calledAt: token.calledAt,
                });
              }
            } else {
              console.warn('[LiveCounter] token.called received but counter data is missing (skipping speech announcement):', { token, counter });
            }

            // Update ONLY the called counter
            setCounters((prev) => updateCounterOnTokenCalled(prev, token, counter));
          }
        }

        if (eventName === 'token.serving') {
          setCounters((prev) => updateCounterOnTokenServing(prev, data?.token, data?.counter));
        }

        if (eventName === 'token.completed') {
          setCounters((prev) => clearCounterToken(prev, data?.token, data?.counter));
        }

        if (
          eventName === 'token.serving' ||
          eventName === 'token.completed' ||
          eventName === 'token.skipped' ||
          eventName === 'token.cancelled' ||
          eventName === 'token.expired'
        ) {
          const eventToken = data?.token;
          const eventTokenCode = eventToken?.tokenCode || (typeof data?.tokenCode === 'string' ? data.tokenCode : null);
          const eventTokenId = eventToken?._id || eventToken?.id || data?.tokenId;

          // When token is served, completed, skipped, cancelled, or expired, dismiss the calling pop-up notice
          setActiveCallout((current) => {
            if (!current) return null;
            if (!eventTokenCode && !eventTokenId) {
              return null;
            }
            const matchCode = eventTokenCode && current.tokenCode && eventTokenCode === current.tokenCode;
            const matchId = eventTokenId && current.tokenId && String(eventTokenId) === String(current.tokenId);
            if (matchCode || matchId) {
              return null;
            }
            return current;
          });
        }

        if (eventName === 'token.skipped') {
          setCounters((prev) => clearCounterToken(prev, data?.token, data?.counter));
          // Phase 2 geofence auto-skip. Deliberately silent and deliberately
          // separate from the callout above: a skip is a public note, not a
          // call to action, so it must never trigger the lobby chime. Only the
          // resulting `token.called` for the next eligible token does that.
          setSkipAnnouncements((current) => appendSkipAnnouncement(current, data));
        }

        if (eventName === 'token.cancelled' || eventName === 'token.expired') {
          setCounters((prev) => clearCounterToken(prev, data?.token, data?.counter));
        }

        if (eventName === 'counter.updated') {
          setCounters((prev) => updateCounterMetadata(prev, data?.counter));
        }

        // Re-fetch authoritative state whenever queue, counter, or tokens transition
        loadDisplayRef.current?.(selectedCenterId);
      },
    });

    return () => {
      closeDisplaySocket();
    };
  }, [selectedCenterId, displayToken]);

  // 4. Update URL when center is selected
  const handleSelectCenter = (centerId) => {
    setSelectedCenterId(centerId);
    const url = new URL(window.location);
    url.searchParams.set('centerId', centerId);
    window.history.pushState({}, '', url);
  };

  // Re-evaluate sensor freshness once per second so "Unavailable" appears
  // without needing any other event to trigger a re-render.
  useEffect(() => {
    const id = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // A reading is stale when the backend flagged the sensor offline, or when the
  // last real reading is older than 90s. Never refreshed by polling alone.
  const isSensorStale = useMemo(() => {
    if (liveFootfall === null) return true;
    if (crowdSensorOnline === false) return true;
    if (!lastFootfallUpdate) return true;
    return nowTick - lastFootfallUpdate.getTime() > CROWD_SENSOR_STALE_MS;
  }, [liveFootfall, lastFootfallUpdate, crowdSensorOnline, nowTick]);

  // Filter queues/tokens if service-specific display is requested
  const center = displayData?.center;
  const queues = displayData?.queues || [];
  const activeCounters =
    counters && counters.length > 0
      ? counters
      : buildCountersState(displayData?.counters, displayData?.nowServing);
  const nowServing = displayData?.nowServing || [];
  const nextInQueue = displayData?.nextInQueue || [];
  const metrics = displayData?.metrics || null;

  // Truthful degraded-state banner. The board must never look live when it is
  // not: a display that cannot open a realtime subscription has to say so
  // rather than quietly relying on periodic re-fetches.
  const realtimeUnavailable =
    displayTokenChecked && !displayToken && connectionStatus !== 'connected';

  if (!selectedCenterId && centers.length === 0 && !loading) {
    return (
      <div className="fullscreen-notice" data-testid="display-not-configured">
        <h2>DISPLAY NOT CONFIGURED</h2>
        <p>No active service centers were found on the backend system. Please verify backend service configuration.</p>
      </div>
    );
  }

  return (
    <div className="live-display-shell" data-testid="live-counter-panel">
      {/* Top TV Bar */}
      <LiveHeader
        centerName={center?.name}
        centerCode={center?.code}
        centers={centers}
        selectedCenterId={selectedCenterId}
        onSelectCenter={handleSelectCenter}
        connectionStatus={connectionStatus}
        lastUpdated={lastUpdated}
        isMuted={isMuted}
        isAudioUnlocked={isAudioUnlocked}
        onToggleMute={handleToggleSound}
      />

      {/* Prominent High-Visibility Callout Announcement Banner */}
      <CalloutBanner
        callout={activeCallout}
        onDismiss={() => setActiveCallout(null)}
      />

      {/* Phase 2: temporary floating note for customers auto-skipped for
          leaving the service area. Self-dismissing, no voice. */}
      <SkipAnnouncement
        announcements={skipAnnouncements}
        onDismiss={(id) => setSkipAnnouncements((current) => dismissSkipAnnouncement(current, id))}
      />

      {realtimeUnavailable && (
        <div className="fullscreen-notice" data-testid="realtime-unavailable" style={{ color: 'var(--color-warning)' }}>
          <h2>REALTIME FEED UNAVAILABLE</h2>
          <p>
            The backend did not issue a realtime credential for this display, so live
            queue events cannot be received. Values below refresh periodically but are
            NOT realtime. Check that this display and the Admin Panel point at the same
            backend, and that the backend is running a build that returns a
            &quot;displayToken&quot;.
          </p>
        </div>
      )}

      {loading && !displayData ? (
        <div className="fullscreen-notice">
          <h2>CONNECTING TO QUEUEFLOW...</h2>
          <p>Initializing real-time display telemetry feed.</p>
        </div>
      ) : error ? (
        <div className="fullscreen-notice" style={{ color: 'var(--color-danger)' }}>
          <h2>FEED UNAVAILABLE</h2>
          <p>{error}</p>
        </div>
      ) : (
        <div className="display-main-grid">
          {/* Left Column: Primary Counter Telemetry */}
          <div className="center-column">
            {/* Hero Serving & Next in Queue */}
            <div className="hero-serving-grid">
              <NowServingHero counters={activeCounters} nowServing={nowServing} />
              <NextTokenCard nextInQueue={nextInQueue} />
            </div>

            {/* Active Counters Grid */}
            <CountersGrid counters={activeCounters} />

            {/* Bottom Metrics Bar */}
            <div className="metrics-strip">
              <FootfallMetric
                footfall={liveFootfall}
                capacity={center?.capacity}
                crowdStatus={crowdStatus}
                crowdPercent={crowdPercent}
                lastFootfallUpdate={lastFootfallUpdate}
                isSensorStale={isSensorStale}
              />
              <QueueStats queues={queues} counters={activeCounters} metrics={metrics} center={center} />
            </div>
          </div>

          {/* Right Column: Large Dynamic QR Code for Mobile Check-in */}
          <JoinQrPanel
            centerId={selectedCenterId}
            serviceId={selectedServiceId}
            centerName={center?.name}
          />
        </div>
      )}
    </div>
  );
}
