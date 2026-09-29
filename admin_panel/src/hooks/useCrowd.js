import { useState, useEffect, useCallback } from 'react';
import { crowdAPI, devAPI } from '../services/api';
import { useSocket } from '../context/SocketContext';
import {
  EMPTY_CROWD,
  adoptCrowdEvent,
  adoptCrowdRead,
  isCrowdReadingStale,
} from '../services/crowdState';

export { CROWD_SENSOR_STALE_MS, isCrowdReadingStale } from '../services/crowdState';

/**
 * Authoritative crowd state for a center.
 *
 * Every value here is the backend's: the stored occupancy, the percentage and
 * status the server derived from it, and the server's own freshness verdict.
 * Nothing is calculated locally, so the Admin Dashboard and the Live Counter
 * cannot show different numbers for the same center.
 *
 * The rules themselves live in `services/crowdState.js` so they can be tested
 * directly.
 */
export function useCrowd(centerId) {
  const [crowdData, setCrowdData] = useState(EMPTY_CROWD);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const { on } = useSocket();

  const fetchCrowd = useCallback(async () => {
    if (!centerId) {
      setLoading(false);
      return;
    }
    try {
      setError(null);
      const res = await crowdAPI.getStatus(centerId);
      if (res.success && res.data) {
        setCrowdData(adoptCrowdRead(res.data, centerId));
      }
    } catch (err) {
      console.warn('Using default crowd fallback:', err.message);
    } finally {
      setLoading(false);
    }
  }, [centerId]);

  useEffect(() => {
    fetchCrowd();
  }, [fetchCrowd]);

  // Real-time crowd update via Socket.IO. The server has already validated the
  // reading, derived the percentage and status, and scoped the emission to this
  // center's room; `adoptCrowdEvent` re-checks the center and adopts the payload
  // verbatim.
  useEffect(() => {
    if (!centerId) return;

    const unsubCrowd = on('crowd.updated', (data) => {
      setCrowdData((prev) => adoptCrowdEvent(prev, data, centerId));
    });

    const unsubConnect = on('connect', () => {
      fetchCrowd();
    });

    return () => {
      unsubCrowd();
      unsubConnect();
    };
  }, [centerId, on, fetchCrowd]);

  // Simulator actions for development/testing
  const simulateCrowd = async (type, count = 1) => {
    try {
      const res = await devAPI.simulateCrowd(centerId, type, count);
      await fetchCrowd();
      return res.data;
    } catch (err) {
      alert(err.message || 'Failed to simulate crowd');
      throw err;
    }
  };

  const resetCrowd = async () => {
    try {
      const res = await devAPI.resetCrowd(centerId);
      await fetchCrowd();
      return res.data;
    } catch (err) {
      alert(err.message || 'Failed to reset crowd');
      throw err;
    }
  };

  return {
    crowdData,
    loading,
    error,
    isReadingStale: isCrowdReadingStale,
    simulateCrowd,
    resetCrowd,
    refreshCrowd: fetchCrowd,
  };
}
