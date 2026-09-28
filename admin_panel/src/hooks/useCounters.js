import { useState, useEffect, useCallback } from 'react';
import { counterAPI } from '../services/api';
import { useSocket } from '../context/SocketContext';

const DEFAULT_COUNTERS = [
  { _id: 'c1', number: 1, name: 'Counter 01', displayLabel: 'COUNTER 01', status: 'ACTIVE', servingToken: { tokenCode: 'A-246' }, serviceId: { name: 'License Renewal' } },
  { _id: 'c2', number: 2, name: 'Counter 02', displayLabel: 'COUNTER 02', status: 'BUSY', servingToken: { tokenCode: 'B-108' }, serviceId: { name: 'Tax Payment' } },
  { _id: 'c3', number: 3, name: 'Counter 03', displayLabel: 'COUNTER 03', status: 'ACTIVE', servingToken: { tokenCode: 'C-042' }, serviceId: { name: 'Certificate' } },
  { _id: 'c4', number: 4, name: 'Counter 04', displayLabel: 'COUNTER 04', status: 'BREAK', servingToken: null, serviceId: { name: 'Property Records' } },
];

export function useCounters(centerId) {
  const [counters, setCounters] = useState(DEFAULT_COUNTERS);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [actionLoadingId, setActionLoadingId] = useState(null);
  const { on } = useSocket();

  const fetchCounters = useCallback(async () => {
    if (!centerId) {
      setLoading(false);
      return;
    }
    try {
      setError(null);
      const res = await counterAPI.list(centerId);
      if (res.success && res.data?.counters && res.data.counters.length > 0) {
        setCounters(res.data.counters);
      }
    } catch (err) {
      console.warn('Using default counters fallback:', err.message);
    } finally {
      setLoading(false);
    }
  }, [centerId]);

  useEffect(() => {
    fetchCounters();
  }, [fetchCounters]);

  // Real-time counter updates via Socket.IO
  useEffect(() => {
    if (!centerId) return;

    const unsubCounter = on('counter.updated', (data) => {
      const updatedCounter = data.counter;
      if (updatedCounter) {
        setCounters((prev) =>
          prev.map((c) => (c._id === updatedCounter._id ? { ...c, ...updatedCounter } : c))
        );
      }
    });

    const unsubTokenCompleted = on('token.completed', () => {
      fetchCounters();
    });

    const unsubTokenCalled = on('token.called', () => {
      fetchCounters();
    });

    const unsubTokenServing = on('token.serving', () => {
      fetchCounters();
    });

    const unsubTokenSkipped = on('token.skipped', () => {
      fetchCounters();
    });

    const unsubTokenCancelled = on('token.cancelled', () => {
      fetchCounters();
    });

    const unsubTokenExpired = on('token.expired', () => {
      fetchCounters();
    });

    return () => {
      unsubCounter();
      unsubTokenCompleted();
      unsubTokenCalled();
      unsubTokenServing();
      unsubTokenSkipped();
      unsubTokenCancelled();
      unsubTokenExpired();
    };
  }, [centerId, on, fetchCounters]);

  // Counter Actions
  const callNext = async (counterId) => {
    setActionLoadingId(counterId);
    try {
      const res = await counterAPI.callNext(counterId);
      await fetchCounters();
      return res.data;
    } catch (err) {
      alert(err.message || 'Failed to call next token');
      throw err;
    } finally {
      setActionLoadingId(null);
    }
  };

  const startServing = async (counterId) => {
    setActionLoadingId(counterId);
    try {
      const res = await counterAPI.startServing(counterId);
      await fetchCounters();
      return res.data;
    } catch (err) {
      alert(err.message || 'Failed to start serving');
      throw err;
    } finally {
      setActionLoadingId(null);
    }
  };

  const complete = async (counterId) => {
    setActionLoadingId(counterId);
    try {
      const res = await counterAPI.complete(counterId);
      await fetchCounters();
      return res.data;
    } catch (err) {
      alert(err.message || 'Failed to complete token');
      throw err;
    } finally {
      setActionLoadingId(null);
    }
  };

  const skip = async (counterId, tokenId) => {
    setActionLoadingId(counterId);
    try {
      const res = await counterAPI.skip(counterId, tokenId);
      await fetchCounters();
      return res.data;
    } catch (err) {
      alert(err.message || 'Failed to skip token');
      throw err;
    } finally {
      setActionLoadingId(null);
    }
  };

  const updateStatus = async (counterId, status) => {
    setActionLoadingId(counterId);
    try {
      const res = await counterAPI.updateStatus(counterId, status);
      await fetchCounters();
      return res.data;
    } catch (err) {
      alert(err.message || 'Failed to update counter status');
      throw err;
    } finally {
      setActionLoadingId(null);
    }
  };

  const assignService = async (counterId, serviceId) => {
    setActionLoadingId(counterId);
    try {
      const res = await counterAPI.assignService(counterId, serviceId);
      await fetchCounters();
      return res.data;
    } catch (err) {
      alert(err.message || 'Failed to assign service');
      throw err;
    } finally {
      setActionLoadingId(null);
    }
  };

  return {
    counters,
    loading,
    error,
    actionLoadingId,
    callNext,
    startServing,
    complete,
    skip,
    updateStatus,
    assignService,
    refreshCounters: fetchCounters,
  };
}
