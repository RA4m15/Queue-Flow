import { useState, useEffect, useCallback } from 'react';
import { analyticsAPI } from '../services/api';

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

  return {
    analytics: data,
    loading,
    error,
    refreshAnalytics: fetchAnalytics,
  };
}
