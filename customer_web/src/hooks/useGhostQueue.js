import { useState, useEffect, useCallback, useRef } from 'react';
import { tokenAPI } from '../services/api';

/**
 * Hook for Ghost Queue geofencing proximity management.
 * Uses browser Geolocation API when available and permitted.
 * Server is authoritative for all geofence calculations.
 * Never fabricates GPS coordinates or distances.
 */
export function useGhostQueue(token) {
  const [geoStatus, setGeoStatus] = useState('IDLE'); // 'IDLE' | 'REQUESTING' | 'ACTIVE' | 'DENIED' | 'UNAVAILABLE' | 'TIMEOUT' | 'ERROR'
  const [proximityState, setProximityState] = useState(token?.proximityState || 'UNKNOWN');
  const [distanceMeters, setDistanceMeters] = useState(token?.proximityDistanceMeters || null);
  const [lastUpdated, setLastUpdated] = useState(token?.proximityUpdatedAt ? new Date(token.proximityUpdatedAt) : null);
  const [errorMessage, setErrorMessage] = useState(null);
  const [isUpdating, setIsUpdating] = useState(false);

  const watchIdRef = useRef(null);
  const lastSyncTimeRef = useRef(0);
  const tokenRef = useRef(token);

  useEffect(() => {
    tokenRef.current = token;
    if (token?.proximityState) {
      setProximityState(token.proximityState);
    }
    if (token?.proximityDistanceMeters !== undefined) {
      setDistanceMeters(token.proximityDistanceMeters);
    }
    if (token?.proximityUpdatedAt) {
      setLastUpdated(new Date(token.proximityUpdatedAt));
    }
  }, [token]);

  const sendLocationToServer = useCallback(async (coords) => {
    const currentToken = tokenRef.current;
    if (!currentToken?._id) return;

    // Do not sync for completed or cancelled tokens
    if (['COMPLETED', 'CANCELLED', 'EXPIRED', 'SKIPPED'].includes(currentToken.status)) {
      return;
    }

    // Rate-limit outgoing client location updates to once per 15s
    const now = Date.now();
    if (now - lastSyncTimeRef.current < 15000) {
      return;
    }
    lastSyncTimeRef.current = now;

    try {
      setIsUpdating(true);
      setErrorMessage(null);

      const res = await tokenAPI.updateLocation(currentToken._id, {
        latitude: coords.latitude,
        longitude: coords.longitude,
        accuracy: coords.accuracy || undefined,
        timestamp: coords.timestamp || now,
      });

      if (res.data) {
        setProximityState(res.data.proximityState);
        setDistanceMeters(res.data.distanceMeters);
        setLastUpdated(new Date(res.data.updatedAt || now));
        setGeoStatus('ACTIVE');
      }
    } catch (err) {
      // Graceful error handling
      setErrorMessage(err.message || 'Failed to update proximity state');
    } finally {
      setIsUpdating(false);
    }
  }, []);

  const requestLocation = useCallback(() => {
    if (!navigator?.geolocation) {
      setGeoStatus('UNAVAILABLE');
      setErrorMessage('Geolocation is not supported by your browser');
      return;
    }

    setGeoStatus('REQUESTING');
    setErrorMessage(null);

    navigator.geolocation.getCurrentPosition(
      (position) => {
        setGeoStatus('ACTIVE');
        sendLocationToServer({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracy: position.coords.accuracy,
          timestamp: position.timestamp,
        });
      },
      (error) => {
        switch (error.code) {
          case error.PERMISSION_DENIED:
            setGeoStatus('DENIED');
            setErrorMessage('Location permission denied. Enable location to use Ghost Queue.');
            break;
          case error.POSITION_UNAVAILABLE:
            setGeoStatus('UNAVAILABLE');
            setErrorMessage('Location information is currently unavailable on this device.');
            break;
          case error.TIMEOUT:
            setGeoStatus('TIMEOUT');
            setErrorMessage('Location request timed out. Please try again.');
            break;
          default:
            setGeoStatus('ERROR');
            setErrorMessage(error.message || 'An error occurred while obtaining location.');
            break;
        }
      },
      {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 30000,
      }
    );
  }, [sendLocationToServer]);

  // Start watching position when token is active
  useEffect(() => {
    if (!token?._id || !['WAITING', 'CALLED'].includes(token.status)) {
      if (watchIdRef.current !== null && navigator?.geolocation) {
        navigator.geolocation.clearWatch(watchIdRef.current);
        watchIdRef.current = null;
      }
      return;
    }

    // Only watch if geolocation is available
    if (navigator?.geolocation && watchIdRef.current === null) {
      watchIdRef.current = navigator.geolocation.watchPosition(
        (position) => {
          sendLocationToServer({
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
            accuracy: position.coords.accuracy,
            timestamp: position.timestamp,
          });
        },
        (error) => {
          if (error.code === error.PERMISSION_DENIED) {
            setGeoStatus('DENIED');
          }
        },
        {
          enableHighAccuracy: true,
          timeout: 15000,
          maximumAge: 30000,
        }
      );
    }

    return () => {
      if (watchIdRef.current !== null && navigator?.geolocation) {
        navigator.geolocation.clearWatch(watchIdRef.current);
        watchIdRef.current = null;
      }
    };
  }, [token?._id, token?.status, sendLocationToServer]);

  return {
    geoStatus,
    proximityState,
    distanceMeters,
    lastUpdated,
    errorMessage,
    isUpdating,
    requestLocation,
  };
}
