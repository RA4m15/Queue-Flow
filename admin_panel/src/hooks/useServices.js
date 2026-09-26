import { useState, useCallback, useRef } from 'react';
import { serviceAPI, serviceCenterAPI } from '../services/api';

/**
 * useServices — Admin Service Management hook.
 *
 * Fetches ALL services for a center (including inactive) via the
 * admin-only GET /api/services/admin endpoint. Provides create, update,
 * and toggleActive mutations that always re-fetch from the backend so the
 * UI remains authoritative.
 *
 * No fake/static fallback data is ever used.
 */
export function useServices(centerId) {
  const [services, setServices] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [actionLoadingId, setActionLoadingId] = useState(null);

  // Abort previous in-flight fetch when centerId changes
  const abortRef = useRef(null);

  const fetchServices = useCallback(async (id = centerId) => {
    if (!id) {
      setServices([]);
      return;
    }
    if (abortRef.current) abortRef.current.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    setLoading(true);
    setError(null);
    try {
      let res;
      try {
        res = await serviceAPI.listAdmin(id);
      } catch (adminErr) {
        if (adminErr.response?.status === 400 || adminErr.response?.status === 404) {
          res = await serviceAPI.list(id);
        } else {
          throw adminErr;
        }
      }
      if (!ctrl.signal.aborted) {
        setServices(res.data?.services ?? []);
      }
    } catch (err) {
      if (!ctrl.signal.aborted) {
        setError(err.response?.data?.message || err.message || 'Failed to load services');
      }
    } finally {
      if (!ctrl.signal.aborted) {
        setLoading(false);
      }
    }
  }, [centerId]);

  /** Create a new service. Throws on validation/network error. */
  const createService = useCallback(async (payload) => {
    const res = await serviceAPI.create(payload);
    const created = res.data?.service;
    // Re-fetch authoritative list — do not push local object
    await fetchServices(payload.centerId || centerId);
    return created;
  }, [centerId, fetchServices]);

  /** Update an existing service. Throws on error. */
  const updateService = useCallback(async (id, payload) => {
    setActionLoadingId(id);
    try {
      const res = await serviceAPI.update(id, payload);
      const updated = res.data?.service;
      // Re-fetch to ensure consistency
      await fetchServices();
      return updated;
    } finally {
      setActionLoadingId(null);
    }
  }, [fetchServices]);

  /** Toggle the isActive flag on a service. */
  const toggleActive = useCallback(async (id, currentIsActive) => {
    setActionLoadingId(id);
    try {
      await serviceAPI.toggleActive(id, !currentIsActive);
      await fetchServices();
    } finally {
      setActionLoadingId(null);
    }
  }, [fetchServices]);

  return {
    services,
    loading,
    error,
    actionLoadingId,
    fetchServices,
    createService,
    updateService,
    toggleActive,
  };
}

/**
 * useCenters — lightweight hook to load the center list for the center picker.
 */
export function useCenters() {
  const [centers, setCenters] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const fetchCenters = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await serviceCenterAPI.list();
      setCenters(res.data?.centers ?? []);
    } catch (err) {
      setError(err.message ?? 'Failed to load service centers');
    } finally {
      setLoading(false);
    }
  }, []);

  return { centers, loading, error, fetchCenters };
}
