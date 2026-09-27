import { useState, useEffect } from 'react';

export function LiveHeader({
  centerName,
  centerCode,
  centers = [],
  selectedCenterId,
  onSelectCenter,
  connectionStatus,
  lastUpdated,
  isMuted,
  onToggleMute,
}) {
  const [clockTime, setClockTime] = useState(() => new Date().toLocaleTimeString());
  const [isFullscreen, setIsFullscreen] = useState(Boolean(document.fullscreenElement));

  useEffect(() => {
    const timer = setInterval(() => {
      setClockTime(new Date().toLocaleTimeString());
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const handleFsChange = () => {
      setIsFullscreen(Boolean(document.fullscreenElement));
    };
    document.addEventListener('fullscreenchange', handleFsChange);
    return () => document.removeEventListener('fullscreenchange', handleFsChange);
  }, []);

  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen().catch(() => {});
    }
  };

  const getStatusClass = () => {
    if (connectionStatus === 'connected') return 'live';
    if (connectionStatus === 'reconnecting') return 'reconnecting';
    return 'disconnected';
  };

  const getStatusLabel = () => {
    if (connectionStatus === 'connected') return 'LIVE';
    if (connectionStatus === 'reconnecting') return 'RECONNECTING...';
    return 'DISCONNECTED';
  };

  return (
    <header className="display-card display-header" role="banner">
      <div className="brand-section">
        <span className="brand-logo">QUEUEFLOW</span>
        <div className="center-title-group">
          <h1>{centerName || 'Live Counter'}</h1>
          <div className="center-meta">
            <span>PUBLIC DISPLAY</span>
            {centerCode && <span>• CODE: {centerCode}</span>}
          </div>
        </div>

        {centers.length > 1 && (
          <select
            className="center-select-input"
            value={selectedCenterId}
            onChange={(e) => onSelectCenter(e.target.value)}
            aria-label="Select Center"
          >
            {centers.map((c) => (
              <option key={c._id} value={c._id}>
                {c.name} ({c.code})
              </option>
            ))}
          </select>
        )}
      </div>

      <div className="header-status-group">
        <div className={`live-badge ${getStatusClass()}`} aria-live="polite">
          <span className="pulse-dot" />
          <span>{getStatusLabel()}</span>
        </div>

        <div style={{ textAlign: 'right' }}>
          <div className="clock-display" aria-label="Current time">
            {clockTime}
          </div>
          <div className="time-freshness">
            {lastUpdated ? `Updated ${lastUpdated.toLocaleTimeString()}` : 'Initializing...'}
          </div>
        </div>

        <div className="header-controls">
          <button
            type="button"
            className="ctrl-btn"
            onClick={onToggleMute}
            title={isMuted ? 'Turn on audio chime' : 'Mute audio chime'}
            aria-label={isMuted ? 'Audio Muted' : 'Audio On'}
          >
            {isMuted ? '🔇 Muted' : '🔊 Chime On'}
          </button>
          <button
            type="button"
            className="ctrl-btn"
            onClick={toggleFullscreen}
            title="Toggle Fullscreen for TV Display"
            aria-label="Toggle Fullscreen"
          >
            {isFullscreen ? 'Exit Fullscreen' : '⛶ Fullscreen'}
          </button>
        </div>
      </div>
    </header>
  );
}
