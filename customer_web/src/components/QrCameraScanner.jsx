import { useState, useEffect, useRef, useCallback } from 'react';
import jsQR from 'jsqr';
import { parseJoinUrl } from '../utils/qrUrlParser';

/**
 * QrCameraScanner — Mobile-friendly real camera QR scanner
 *
 * Capabilities:
 * - Direct camera stream via navigator.mediaDevices.getUserMedia
 * - Environment/rear camera preferred on mobile devices
 * - High performance scanning with BarcodeDetector when available, falling back to jsQR
 * - Strict lifecycle cleanup: stops all camera tracks immediately on success, close, or unmount
 * - User-friendly states: Requesting, Scanning, Permission Denied, Camera Unavailable, Unsupported Device
 * - Full-width responsive viewfinder with scanning reticle
 */
export function QrCameraScanner({ onScanSuccess, onClose, onError }) {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);
  const animFrameRef = useRef(null);
  const isScanningActiveRef = useRef(true);
  const barcodeDetectorRef = useRef(null);

  // States: 'requesting' | 'scanning' | 'permission_denied' | 'unavailable' | 'unsupported'
  const [cameraState, setCameraState] = useState('requesting');
  const [scanMessage, setScanMessage] = useState(null);

  // Safely stop stream tracks and animation
  const stopCamera = useCallback(() => {
    isScanningActiveRef.current = false;

    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }

    if (streamRef.current) {
      try {
        const tracks = streamRef.current.getTracks();
        tracks.forEach((track) => {
          track.stop();
        });
      } catch (_) {}
      streamRef.current = null;
    }

    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
  }, []);

  const scanFrame = useCallback(() => {
    if (!isScanningActiveRef.current) return;

    const video = videoRef.current;
    if (video && video.readyState === video.HAVE_ENOUGH_DATA) {
      const processDecodedText = (rawText) => {
        if (!rawText || !isScanningActiveRef.current) return;

        const parsed = parseJoinUrl(rawText);
        if (parsed.isValid) {
          // Valid QueueFlow QR! Stop camera immediately before navigating
          stopCamera();
          if (onScanSuccess) {
            onScanSuccess(rawText, parsed);
          }
          return true;
        } else {
          // Invalid or unrelated QR code
          setScanMessage('QR code not recognized');
          setTimeout(() => {
            if (isScanningActiveRef.current) setScanMessage(null);
          }, 1500);
          return false;
        }
      };

      // 1. Try native BarcodeDetector if available
      if (barcodeDetectorRef.current) {
        barcodeDetectorRef.current
          .detect(video)
          .then((barcodes) => {
            if (barcodes && barcodes.length > 0) {
              const matched = processDecodedText(barcodes[0].rawValue);
              if (matched) return;
            }
            if (isScanningActiveRef.current) {
              animFrameRef.current = requestAnimationFrame(scanFrame);
            }
          })
          .catch(() => {
            // Fall back to canvas/jsQR on detector error
            runCanvasScan();
          });
        return;
      }

      // 2. Universal jsQR decode via offscreen canvas
      function runCanvasScan() {
        try {
          let canvas = canvasRef.current;
          if (!canvas) {
            canvas = document.createElement('canvas');
            canvasRef.current = canvas;
          }

          const width = video.videoWidth;
          const height = video.videoHeight;
          if (width > 0 && height > 0) {
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            if (ctx) {
              ctx.drawImage(video, 0, 0, width, height);
              const imgData = ctx.getImageData(0, 0, width, height);
              const qrResult = jsQR(imgData.data, width, height, {
                inversionAttempts: 'dontInvert',
              });

              if (qrResult && qrResult.data) {
                const matched = processDecodedText(qrResult.data);
                if (matched) return;
              }
            }
          }
        } catch (_) {}

        if (isScanningActiveRef.current) {
          animFrameRef.current = requestAnimationFrame(scanFrame);
        }
      }

      runCanvasScan();
      return;
    }

    if (isScanningActiveRef.current) {
      animFrameRef.current = requestAnimationFrame(scanFrame);
    }
  }, [stopCamera, onScanSuccess]);

  const startCamera = useCallback(async () => {
    stopCamera();
    isScanningActiveRef.current = true;
    setCameraState('requesting');
    setScanMessage(null);

    // Check mediaDevices support
    if (
      typeof navigator === 'undefined' ||
      !navigator.mediaDevices ||
      typeof navigator.mediaDevices.getUserMedia !== 'function'
    ) {
      setCameraState('unsupported');
      if (onError) onError('Camera scanning is not available on this device.');
      return;
    }

    // Initialize BarcodeDetector if natively supported
    if (typeof window !== 'undefined' && 'BarcodeDetector' in window) {
      try {
        barcodeDetectorRef.current = new window.BarcodeDetector({ formats: ['qr_code'] });
      } catch (_) {
        barcodeDetectorRef.current = null;
      }
    }

    try {
      const constraints = {
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: false,
      };

      const stream = await navigator.mediaDevices.getUserMedia(constraints);

      if (!isScanningActiveRef.current) {
        // Component unmounted while waiting for user to grant permission
        stream.getTracks().forEach((t) => t.stop());
        return;
      }

      streamRef.current = stream;

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.setAttribute('playsinline', 'true'); // Required for iOS Safari
        try {
          await videoRef.current.play();
        } catch (_) {}
      }

      setCameraState('scanning');
      animFrameRef.current = requestAnimationFrame(scanFrame);
    } catch (err) {
      if (!isScanningActiveRef.current) return;

      if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
        setCameraState('permission_denied');
        if (onError) onError('Camera permission denied');
      } else if (
        err.name === 'NotFoundError' ||
        err.name === 'DevicesNotFoundError' ||
        err.name === 'NotReadableError' ||
        err.name === 'TrackStartError'
      ) {
        setCameraState('unavailable');
        if (onError) onError('Camera unavailable');
      } else {
        setCameraState('unavailable');
        if (onError) onError(err.message || 'Camera unavailable');
      }
    }
  }, [stopCamera, scanFrame, onError]);

  useEffect(() => {
    startCamera();
    return () => {
      stopCamera();
    };
  }, [startCamera, stopCamera]);

  return (
    <div
      className="qr-scanner-container"
      data-testid="qr-camera-scanner"
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        width: '100%',
        maxWidth: '440px',
        margin: '0 auto',
      }}
    >
      {/* Viewfinder Card */}
      <div
        style={{
          position: 'relative',
          width: '100%',
          aspectRatio: '1 / 1',
          maxHeight: '360px',
          background: '#050b18',
          borderRadius: '16px',
          overflow: 'hidden',
          border: '1px solid var(--border-subtle)',
          boxShadow: '0 8px 30px rgba(0, 0, 0, 0.35)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {/* Video feed */}
        <video
          ref={videoRef}
          data-testid="camera-preview-video"
          playsInline
          autoPlay
          muted
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            display: cameraState === 'scanning' ? 'block' : 'none',
          }}
        />

        {/* Reticle / Scan Frame Overlay */}
        {cameraState === 'scanning' && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              pointerEvents: 'none',
            }}
          >
            {/* Viewfinder Target Box */}
            <div
              data-testid="qr-viewfinder-reticle"
              style={{
                width: '68%',
                height: '68%',
                border: '2px solid var(--color-primary)',
                borderRadius: '16px',
                boxShadow: '0 0 0 9999px rgba(0, 0, 0, 0.45), 0 0 15px rgba(14, 165, 165, 0.4)',
                position: 'relative',
              }}
            >
              {/* Corner Accents */}
              <div
                style={{
                  position: 'absolute',
                  top: '-3px',
                  left: '-3px',
                  width: '18px',
                  height: '18px',
                  borderTop: '4px solid var(--color-primary)',
                  borderLeft: '4px solid var(--color-primary)',
                  borderTopLeftRadius: '14px',
                }}
              />
              <div
                style={{
                  position: 'absolute',
                  top: '-3px',
                  right: '-3px',
                  width: '18px',
                  height: '18px',
                  borderTop: '4px solid var(--color-primary)',
                  borderRight: '4px solid var(--color-primary)',
                  borderTopRightRadius: '14px',
                }}
              />
              <div
                style={{
                  position: 'absolute',
                  bottom: '-3px',
                  left: '-3px',
                  width: '18px',
                  height: '18px',
                  borderBottom: '4px solid var(--color-primary)',
                  borderLeft: '4px solid var(--color-primary)',
                  borderBottomLeftRadius: '14px',
                }}
              />
              <div
                style={{
                  position: 'absolute',
                  bottom: '-3px',
                  right: '-3px',
                  width: '18px',
                  height: '18px',
                  borderBottom: '4px solid var(--color-primary)',
                  borderRight: '4px solid var(--color-primary)',
                  borderBottomRightRadius: '14px',
                }}
              />
            </div>
          </div>
        )}

        {/* State: Requesting Camera Access */}
        {cameraState === 'requesting' && (
          <div
            style={{
              padding: '1.5rem',
              textAlign: 'center',
              color: 'var(--text-secondary)',
            }}
          >
            <div
              style={{
                width: '36px',
                height: '36px',
                borderRadius: '50%',
                border: '3px solid var(--border-subtle)',
                borderTopColor: 'var(--color-primary)',
                animation: 'spin 1s linear infinite',
                margin: '0 auto 1rem auto',
              }}
            />
            <p style={{ fontSize: '0.95rem', fontWeight: 600, color: 'var(--text-main)' }}>
              Requesting camera access...
            </p>
            <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '0.25rem' }}>
              Please allow camera permissions when prompted.
            </p>
          </div>
        )}

        {/* State: Permission Denied */}
        {cameraState === 'permission_denied' && (
          <div
            style={{
              padding: '1.5rem',
              textAlign: 'center',
              color: 'var(--text-secondary)',
            }}
          >
            <span style={{ fontSize: '2rem', display: 'block', marginBottom: '0.5rem' }}>🔒</span>
            <p style={{ fontSize: '1rem', fontWeight: 700, color: 'var(--color-danger, #ef4444)' }}>
              Camera permission denied
            </p>
            <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: '0.35rem', marginBottom: '1rem' }}>
              Allow camera access in your browser settings to scan QueueFlow QR codes.
            </p>
            <button
              type="button"
              onClick={startCamera}
              className="btn-primary"
              style={{ fontSize: '0.85rem', padding: '0.5rem 1rem' }}
            >
              Allow Camera Access
            </button>
          </div>
        )}

        {/* State: Unavailable */}
        {cameraState === 'unavailable' && (
          <div
            style={{
              padding: '1.5rem',
              textAlign: 'center',
              color: 'var(--text-secondary)',
            }}
          >
            <span style={{ fontSize: '2rem', display: 'block', marginBottom: '0.5rem' }}>📷</span>
            <p style={{ fontSize: '1rem', fontWeight: 700, color: 'var(--text-main)' }}>
              Camera unavailable
            </p>
            <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: '0.35rem', marginBottom: '1rem' }}>
              Your device camera could not be accessed. You can enter the code manually below.
            </p>
            <button
              type="button"
              onClick={startCamera}
              className="btn-secondary"
              style={{ fontSize: '0.85rem', padding: '0.5rem 1rem' }}
            >
              Retry Camera
            </button>
          </div>
        )}

        {/* State: Unsupported on Desktop/Device */}
        {cameraState === 'unsupported' && (
          <div
            style={{
              padding: '1.5rem',
              textAlign: 'center',
              color: 'var(--text-secondary)',
            }}
          >
            <span style={{ fontSize: '2rem', display: 'block', marginBottom: '0.5rem' }}>💻</span>
            <p style={{ fontSize: '0.95rem', fontWeight: 700, color: 'var(--text-main)' }}>
              Camera scanning is not available on this device.
            </p>
            <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '0.35rem' }}>
              Please enter the QueueFlow QR link manually below.
            </p>
          </div>
        )}

        {/* Warning / Error Flash Message */}
        {scanMessage && (
          <div
            role="status"
            style={{
              position: 'absolute',
              bottom: '12px',
              left: '12px',
              right: '12px',
              padding: '0.6rem 0.8rem',
              background: 'rgba(239, 68, 68, 0.9)',
              color: '#ffffff',
              fontSize: '0.8rem',
              fontWeight: 600,
              borderRadius: '8px',
              textAlign: 'center',
              backdropFilter: 'blur(4px)',
            }}
          >
            {scanMessage}
          </div>
        )}
      </div>

      {/* Helpful guidance instructions */}
      {cameraState === 'scanning' && (
        <p
          style={{
            fontSize: '0.85rem',
            color: 'var(--text-secondary)',
            textAlign: 'center',
            marginTop: '0.75rem',
          }}
        >
          Point your camera at the QueueFlow QR code
        </p>
      )}

      {/* Close / Cancel Button */}
      {onClose && (
        <button
          type="button"
          onClick={() => {
            stopCamera();
            onClose();
          }}
          className="btn-secondary"
          style={{
            marginTop: '1rem',
            fontSize: '0.85rem',
            padding: '0.45rem 1.25rem',
            borderRadius: '8px',
          }}
        >
          Cancel Scan
        </button>
      )}
    </div>
  );
}
