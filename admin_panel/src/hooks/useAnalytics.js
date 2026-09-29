import { useState, useEffect, useCallback, useRef } from 'react';
import { analyticsAPI } from '../services/api';
import { useSocket } from '../context/SocketContext';

// Queue lifecycle events that can change the stat pills. Every one of these now
// carries a `queue.updated` broadcast from the backend with the authoritative
// Token-derived metrics.
const METRIC_EVENTS = [
  'queue.updated',
  'token.created',
  'token.called',
  'token.serving',
  'token.completed',
  'token.skipped',
  'token.cancelled',
  'token.expired',
];

export function useAnalytics(centerId) {
  const [data, setData] = useState({
    summary: null,
    queues: [],
    counters: [],
    hourlyFootfall: [],
    serviceDemand: [],
    recommendations: [],
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const { on } = useSocket();

  const fetchAnalytics = useCallback(async () => {
    if (!centerId) {
      setLoading(false);
      return;
    }
    try {
      setError(null);
      const res = await analyticsAPI.getDashboard(centerId);
      if (res.success && res.data) {
        setData(res.data);
      }
    } catch (err) {
      console.error('Error fetching analytics:', err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [centerId]);

  useEffect(() => {
    fetchAnalytics();
  }, [fetchAnalytics]);

  // Realtime refresh.
  //
  // Previously this hook fetched exactly once per centerId and had NO socket
  // subscription, so "AVG WAIT TIME" and "COMPLETED TODAY" stayed frozen until
  // an operator pressed "Sync Telemetry". Now every queue mutation that reaches
  // the center room re-reads the authoritative dashboard summary.
  //
  // The individual `queue.updated` payloads are not merged client-side: the
  // backend is authoritative, so a refetch keeps the pills consistent with
  // every other surface instead of maintaining a second client-side tally.
  const pendingRef = useRef(null);
  const centerRef = useRef(centerId);
  centerRef.current = centerId;

  useEffect(() => {
    if (!centerId) return undefined;

    // Coalesce bursts (call-next fires several events back to back) into a
    // single refetch so one admin action cannot cause a request stampede.
    const scheduleRefresh = () => {
      if (pendingRef.current) return;
      pendingRef.current = setTimeout(() => {
        pendingRef.current = null;
        if (centerRef.current) fetchAnalytics();
      }, 250);
    };

    const unsubscribers = METRIC_EVENTS.map((eventName) =>
      on(eventName, (payload) => {
        // Ignore anything that is explicitly for a different center.
        const payloadCenterId = payload?.centerId ?? payload?.token?.centerId;
        if (payloadCenterId && String(payloadCenterId) !== String(centerRef.current)) {
          return;
        }
        scheduleRefresh();
      })
    );

    return () => {
      if (pendingRef.current) {
        clearTimeout(pendingRef.current);
        pendingRef.current = null;
      }
      unsubscribers.forEach((off) => off());
    };
  }, [centerId, on, fetchAnalytics]);

  return {
    analytics: data,
    loading,
    error,
    refreshAnalytics: fetchAnalytics,
  };
}
