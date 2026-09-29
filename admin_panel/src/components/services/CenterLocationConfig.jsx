import React, { useState, useEffect } from 'react';
import { MapPin, Navigation, CheckCircle2, AlertCircle, Loader2 } from 'lucide-react';
import { serviceCenterAPI } from '../../services/api';

export default function CenterLocationConfig({ center, onCenterUpdated, showToast }) {
  const [radiusInput, setRadiusInput] = useState(100);
  const [isLocating, setIsLocating] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [errorMsg, setErrorMsg] = useState(null);
  const [pendingLocation, setPendingLocation] = useState(null);

  const [successMsg, setSuccessMsg] = useState(null);

  // Extract current location coordinates and radius from center prop
  const currentLat = center?.latitude ?? center?.location?.latitude ?? null;
  const currentLng = center?.longitude ?? center?.location?.longitude ?? null;
  const currentRadius = center?.joiningRadiusMeters ?? center?.geofence?.radiusMeters ?? 100;
  const isConfigured = currentLat !== null && currentLng !== null && typeof currentLat === 'number' && typeof currentLng === 'number';

  useEffect(() => {
    setRadiusInput(currentRadius || 100);
    setPendingLocation(null);
    setErrorMsg(null);
    setSuccessMsg(null);
  }, [center?._id, currentRadius]);

  const handleUseCurrentLocation = () => {
    setErrorMsg(null);
    setSuccessMsg(null);
    setPendingLocation(null);

    if (!navigator.geolocation) {
      setErrorMsg('Geolocation is not supported by your browser.');
      return;
    }

    setIsLocating(true);

    navigator.geolocation.getCurrentPosition(
      (position) => {
        setIsLocating(false);
        const { latitude, longitude, accuracy } = position.coords;
        setPendingLocation({
          latitude: Number(latitude.toFixed(6)),
          longitude: Number(longitude.toFixed(6)),
          accuracy: Math.round(accuracy || 0),
        });
      },
      (err) => {
        setIsLocating(false);
        if (err.code === err.PERMISSION_DENIED) {
          setErrorMsg('Unable to access your current location.');
        } else if (err.code === err.POSITION_UNAVAILABLE) {
          setErrorMsg('Location information is currently unavailable.');
        } else if (err.code === err.TIMEOUT) {
          setErrorMsg('Location request timed out. Please try again.');
        } else {
          setErrorMsg('Unable to access your current location.');
        }
      },
      {
        enableHighAccuracy: true,
        timeout: 15000,
        maximumAge: 0,
      }
    );
  };

  const handleConfirmSave = async () => {
    if (!center?._id) return;
    setIsSaving(true);
    setErrorMsg(null);
    setSuccessMsg(null);

    try {
      const radius = Number(radiusInput) || 100;
      const payload = {
        joiningRadiusMeters: radius,
        geofence: {
          enabled: true,
          radiusMeters: radius,
          nearRadiusMeters: 500,
          approachingRadiusMeters: 1000,
        },
      };

      if (pendingLocation) {
        payload.latitude = pendingLocation.latitude;
        payload.longitude = pendingLocation.longitude;
        payload.location = {
          latitude: pendingLocation.latitude,
          longitude: pendingLocation.longitude,
        };
      }

      const res = await serviceCenterAPI.update(center._id, payload);
      const updated = res.data?.center || res.center || {
        ...center,
        ...payload,
        location: { latitude: payload.latitude ?? currentLat, longitude: payload.longitude ?? currentLng },
        geofence: { enabled: true, radiusMeters: radius },
      };

      setPendingLocation(null);
      setSuccessMsg({
        text: 'Location saved successfully',
        radius: radius,
      });
      if (onCenterUpdated) onCenterUpdated(updated);
      if (showToast) showToast(`✅ Location saved successfully. Radius: ${radius} m`);
    } catch (err) {
      const msg = err.response?.data?.message || err.message || 'Failed to save center location.';
      setErrorMsg(msg);
    } finally {
      setIsSaving(false);
    }
  };

  const handleUpdateRadiusOnly = async () => {
    if (!center?._id) return;
    setIsSaving(true);
    setErrorMsg(null);
    setSuccessMsg(null);

    try {
      const radius = Number(radiusInput) || 100;
      const payload = {
        joiningRadiusMeters: radius,
        geofence: { ...(center.geofence || {}), enabled: true, radiusMeters: radius },
      };
      const res = await serviceCenterAPI.update(center._id, payload);
      const updated = res.data?.center || res.center || {
        ...center,
        joiningRadiusMeters: radius,
        geofence: { ...(center.geofence || {}), radiusMeters: radius },
      };

      setSuccessMsg({
        text: 'Location saved successfully',
        radius: radius,
      });
      if (onCenterUpdated) onCenterUpdated(updated);
      if (showToast) showToast(`✅ Location saved successfully. Radius: ${radius} m`);
    } catch (err) {
      const msg = err.response?.data?.message || err.message || 'Failed to update joining radius.';
      setErrorMsg(msg);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div
      className="q-card"
      style={{
        padding: '18px 20px',
        marginBottom: '20px',
        background: 'var(--bg-card)',
        border: '1px solid var(--border-subtle)',
        borderRadius: '14px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '14px', flexWrap: 'wrap', gap: '10px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <MapPin size={16} color="var(--color-primary)" />
          <span style={{ fontSize: '13px', fontWeight: 800, letterSpacing: '0.04em', color: 'var(--text-main)', textTransform: 'uppercase' }}>
            SERVICE CENTER LOCATION
          </span>
          <span
            style={{
              fontSize: '11px',
              padding: '2px 8px',
              borderRadius: '6px',
              background: isConfigured ? 'rgba(0,229,168,0.1)' : 'rgba(239,68,68,0.1)',
              color: isConfigured ? 'var(--color-primary)' : 'var(--color-danger)',
              fontWeight: 700,
              fontFamily: 'var(--font-mono)',
            }}
          >
            {isConfigured ? 'Location configured' : 'Not configured'}
          </span>
        </div>

        <button
          type="button"
          onClick={handleUseCurrentLocation}
          disabled={isLocating || isSaving}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '7px',
            padding: '7px 14px',
            borderRadius: '8px',
            fontSize: '12px',
            fontWeight: 700,
            background: 'var(--color-primary)',
            color: '#0a0f1d',
            border: 'none',
            cursor: isLocating || isSaving ? 'not-allowed' : 'pointer',
            opacity: isLocating || isSaving ? 0.7 : 1,
            transition: 'all 0.15s ease',
          }}
        >
          {isLocating ? (
            <>
              <Loader2 size={14} className="spin" />
              <span>Detecting GPS…</span>
            </>
          ) : (
            <>
              <Navigation size={14} />
              <span>Use Current Location</span>
            </>
          )}
        </button>
      </div>

      {/* Details Grid */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
          gap: '14px',
          background: 'var(--bg-app)',
          padding: '14px 16px',
          borderRadius: '10px',
          border: '1px solid var(--border-subtle)',
        }}
      >
        <div>
          <div style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '4px' }}>
            Latitude
          </div>
          <div style={{ fontSize: '14px', fontWeight: 700, fontFamily: 'var(--font-mono)', color: isConfigured ? 'var(--text-main)' : 'var(--text-muted)' }}>
            {isConfigured ? currentLat.toFixed(5) : '—'}
          </div>
        </div>

        <div>
          <div style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '4px' }}>
            Longitude
          </div>
          <div style={{ fontSize: '14px', fontWeight: 700, fontFamily: 'var(--font-mono)', color: isConfigured ? 'var(--text-main)' : 'var(--text-muted)' }}>
            {isConfigured ? currentLng.toFixed(5) : '—'}
          </div>
        </div>

        <div>
          <div style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '4px' }}>
            Joining Radius
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <input
              type="number"
              min="10"
              max="50000"
              value={radiusInput}
              onChange={(e) => setRadiusInput(e.target.value)}
              style={{
                width: '90px',
                padding: '4px 8px',
                borderRadius: '6px',
                border: '1px solid var(--border-subtle)',
                background: 'var(--bg-card)',
                color: 'var(--text-main)',
                fontFamily: 'var(--font-mono)',
                fontSize: '13px',
                fontWeight: 700,
              }}
            />
            <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>meters</span>
            {Number(radiusInput) !== currentRadius && !pendingLocation && (
              <button
                type="button"
                onClick={handleUpdateRadiusOnly}
                disabled={isSaving}
                style={{
                  padding: '4px 10px',
                  borderRadius: '6px',
                  fontSize: '11px',
                  fontWeight: 700,
                  background: 'rgba(0,229,168,0.15)',
                  color: 'var(--color-primary)',
                  border: '1px solid rgba(0,229,168,0.3)',
                  cursor: 'pointer',
                }}
              >
                Save Radius
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Location Detected Preview Banner */}
      {pendingLocation && (
        <div
          style={{
            marginTop: '14px',
            padding: '14px 16px',
            borderRadius: '10px',
            background: 'rgba(0, 229, 168, 0.08)',
            border: '1px solid rgba(0, 229, 168, 0.3)',
            display: 'flex',
            flexDirection: 'column',
            gap: '10px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--color-primary)', fontWeight: 700, fontSize: '13px' }}>
            <CheckCircle2 size={16} />
            <span>Browser GPS detected current coordinates:</span>
          </div>

          <div style={{ display: 'flex', gap: '18px', flexWrap: 'wrap', fontSize: '13px', fontFamily: 'var(--font-mono)' }}>
            <div>
              <span style={{ color: 'var(--text-muted)', marginRight: '6px' }}>Lat:</span>
              <strong>{pendingLocation.latitude}</strong>
            </div>
            <div>
              <span style={{ color: 'var(--text-muted)', marginRight: '6px' }}>Lng:</span>
              <strong>{pendingLocation.longitude}</strong>
            </div>
            <div>
              <span style={{ color: 'var(--text-muted)', marginRight: '6px' }}>Accuracy:</span>
              <span>±{pendingLocation.accuracy} m</span>
            </div>
            <div>
              <span style={{ color: 'var(--text-muted)', marginRight: '6px' }}>Radius:</span>
              <span>{radiusInput} m</span>
            </div>
          </div>

          <div style={{ display: 'flex', gap: '10px', marginTop: '4px' }}>
            <button
              type="button"
              onClick={handleConfirmSave}
              disabled={isSaving}
              style={{
                padding: '6px 14px',
                borderRadius: '8px',
                fontSize: '12px',
                fontWeight: 700,
                background: 'var(--color-primary)',
                color: '#0a0f1d',
                border: 'none',
                cursor: isSaving ? 'not-allowed' : 'pointer',
              }}
            >
              {isSaving ? 'Saving…' : 'Save Location'}
            </button>
            <button
              type="button"
              onClick={() => setPendingLocation(null)}
              disabled={isSaving}
              style={{
                padding: '6px 14px',
                borderRadius: '8px',
                fontSize: '12px',
                fontWeight: 600,
                background: 'transparent',
                color: 'var(--text-muted)',
                border: '1px solid var(--border-subtle)',
                cursor: 'pointer',
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Success banner */}
      {successMsg && (
        <div
          style={{
            marginTop: '12px',
            padding: '10px 14px',
            borderRadius: '8px',
            background: 'rgba(0, 229, 168, 0.1)',
            border: '1px solid rgba(0, 229, 168, 0.3)',
            color: 'var(--color-primary)',
            fontSize: '13px',
            fontWeight: 600,
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
          }}
        >
          <CheckCircle2 size={16} style={{ flexShrink: 0 }} />
          <div>
            <div>{successMsg.text}</div>
            <div style={{ fontSize: '11.5px', color: 'var(--text-muted)', fontWeight: 500, marginTop: '1px' }}>
              Radius: {successMsg.radius} m
            </div>
          </div>
        </div>
      )}

      {/* Error alert */}
      {errorMsg && (
        <div
          style={{
            marginTop: '12px',
            padding: '10px 14px',
            borderRadius: '8px',
            background: 'rgba(239, 68, 68, 0.1)',
            border: '1px solid rgba(239, 68, 68, 0.25)',
            color: 'var(--color-danger)',
            fontSize: '12.5px',
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
          }}
        >
          <AlertCircle size={15} style={{ flexShrink: 0 }} />
          <span>{errorMsg}</span>
        </div>
      )}
    </div>
  );
}
