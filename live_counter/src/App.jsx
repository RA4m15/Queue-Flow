import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { fetchDisplayData, fetchCenters } from './services/api';
import { initDisplaySocket, closeDisplaySocket } from './services/socket';
import { LiveHeader } from './components/LiveHeader';
import { CalloutBanner } from './components/CalloutBanner';
import { NowServingHero } from './components/NowServingHero';
import { NextTokenCard } from './components/NextTokenCard';
import { CountersGrid } from './components/CountersGrid';
import { FootfallMetric } from './components/FootfallMetric';
import { QueueStats } from './components/QueueStats';
import { JoinQrPanel } from './components/JoinQrPanel';

// A crowd reading older than this is treated as no reading at all, so a camera
// that stopped reporting shows "Unavailable" instead of a frozen count.
const CROWD_SENSOR_STALE_MS = 90000;

/**
 * Play a gentle 2-tone airport/lobby chime using Web Audio API.
 * Does not require external audio assets and works in all modern browsers.
 */
function playLobbyChime() {
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    const ctx = new AudioContext();

    const now = ctx.currentTime;
    const osc1 = ctx.createOscillator();
    const gain1 = ctx.createGain();

    osc1.type = 'sine';
    osc1.frequency.setValueAtTime(587.33, now); // D5
    gain1.gain.setValueAtTime(0.25, now);
    gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.6);

    osc1.connect(gain1);
    gain1.connect(ctx.destination);
    osc1.start(now);
    osc1.stop(now + 0.6);

    const osc2 = ctx.createOscillator();
    const gain2 = ctx.createGain();

    osc2.type = 'sine';
    osc2.frequency.setValueAtTime(880, now + 0.25); // A5
    gain2.gain.setValueAtTime(0.25, now + 0.25);
    gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.95);

    osc2.connect(gain2);
    gain2.connect(ctx.destination);
    osc2.start(now + 0.25);
    osc2.stop(now + 0.95);
  } catch (err) {
    console.warn('Audio chime could not be played:', err);
  }
}

export function App() {
  const [centers, setCenters] = useState([]);
  const [selectedCenterId, setSelectedCenterId] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get('centerId') || '';
  });
  const [selectedServiceId] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get('serviceId') || null;
  });

  const [displayData, setDisplayData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [connectionStatus, setConnectionStatus] = useState('disconnected');
  const [lastUpdated, setLastUpdated] = useState(null);
  const [activeCallout, setActiveCallout] = useState(null);
  const [isMuted, setIsMuted] = useState(false);

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

  // 1. Initial Center Discovery (if no centerId in URL)
  useEffect(() => {
    async function loadCentersList() {
      try {
        const list = await fetchCenters();
        setCenters(list);
        if (!selectedCenterId && list.length > 0) {
          setSelectedCenterId(list[0]._id);
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
      setLastUpdated(new Date());

      // Update footfall from authoritative initial state.
      // Freshness comes from the sensor timestamp, not from this fetch time.
      if (typeof data.center?.currentCrowd === 'number') {
        setLiveFootfall(data.center.currentCrowd);
        setCrowdStatus(data.center.crowdStatus || 'LOW');
        setCrowdPercent(data.center.crowdPercent ?? null);
        const stamp = data.center.crowdUpdatedAt ? new Date(data.center.crowdUpdatedAt) : null;
        setLastFootfallUpdate(stamp && !Number.isNaN(stamp.getTime()) ? stamp : null);
        setCrowdSensorOnline(Boolean(data.center.crowdSensorOnline));
      }

      // Store displayToken for socket connection
      if (data.displayToken) {
        setDisplayToken(data.displayToken);
      }
    } catch (err) {
      setError(err.message || 'Failed to connect to queue backend');
    } finally {
      setLoading(false);
    }
  }, [selectedCenterId]);

  // Initial load and periodic safety sync (every 30s)
  useEffect(() => {
    if (!selectedCenterId) return;
    loadDisplay(selectedCenterId);

    const safetySyncTimer = setInterval(() => {
      loadDisplay(selectedCenterId);
    }, 30000);

    return () => clearInterval(safetySyncTimer);
  }, [selectedCenterId, loadDisplay]);

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
        loadDisplay(selectedCenterId);
      },
      onEvent: (eventName, data) => {
        setLastUpdated(new Date());

        if (eventName === 'crowd.updated') {
          // Absolute current occupancy from the CCTV/IoT sensor. Replace, never accumulate.
          const newCount = typeof data?.currentCrowd === 'number' ? data.currentCrowd : data?.count;
          if (typeof newCount === 'number') {
            setLiveFootfall(newCount);
            setCrowdStatus(data.crowdStatus || (data.crowdPercent >= 80 ? 'HIGH' : data.crowdPercent >= 50 ? 'MODERATE' : 'LOW'));
            setCrowdPercent(data.crowdPercent ?? null);
            // Freshness: prefer the server's sensor stamp, fall back to event time.
            const rawStamp = data.crowdUpdatedAt || data?.event?.timestamp;
            const stamp = rawStamp ? new Date(rawStamp) : new Date();
            setLastFootfallUpdate(Number.isNaN(stamp.getTime()) ? new Date() : stamp);
            setCrowdSensorOnline(true);
          }
          return;
        }

        if (eventName === 'token.called') {
          const token = data?.token;
          const counter = data?.counter;
          if (token) {
            const counterName = counter?.displayLabel || counter?.name ||
              (token.counterId ? `Counter ${token.counterId.number || ''}` : 'Service Station');

            setActiveCallout({
              tokenCode: token.tokenCode,
              counterName,
              calledAt: token.calledAt || new Date().toISOString(),
            });

            if (!isMuted) {
              playLobbyChime();
            }
          }
        }

        // Re-fetch authoritative state whenever queue, counter, or tokens transition
        loadDisplay(selectedCenterId);
      },
    });

    return () => {
      closeDisplaySocket();
    };
  }, [selectedCenterId, displayToken, loadDisplay, isMuted]);

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
    if (liveFootfall === null) return false;
    if (crowdSensorOnline === false) return true;
    if (!lastFootfallUpdate) return true;
    return nowTick - lastFootfallUpdate.getTime() > CROWD_SENSOR_STALE_MS;
  }, [liveFootfall, lastFootfallUpdate, crowdSensorOnline, nowTick]);

  // Filter queues/tokens if service-specific display is requested
  const center = displayData?.center;
  const queues = displayData?.queues || [];
  const counters = displayData?.counters || [];
  const nowServing = displayData?.nowServing || [];
  const nextInQueue = displayData?.nextInQueue || [];

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
        onToggleMute={() => setIsMuted(!isMuted)}
      />

      {/* Prominent High-Visibility Callout Announcement Banner */}
      <CalloutBanner
        callout={activeCallout}
        onDismiss={() => setActiveCallout(null)}
      />

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
              <NowServingHero nowServing={nowServing} />
              <NextTokenCard nextInQueue={nextInQueue} />
            </div>

            {/* Active Counters Grid */}
            <CountersGrid counters={counters} />

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
              <QueueStats queues={queues} counters={counters} />
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
