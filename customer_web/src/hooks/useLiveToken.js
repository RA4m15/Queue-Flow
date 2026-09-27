import { useState, useEffect, useCallback, useRef } from 'react';
import { connectSocket, onSocketStatus, onSocketReconnect } from '../services/socket';
import { tokenAPI } from '../services/api';
import { storage } from '../services/storage';
import { useNetworkStatus } from './useNetworkStatus';
import { announceTokenCall } from '../utils/announcer';

export function useLiveToken(initialTokenId) {
  const { isOnline } = useNetworkStatus();
  const user = storage.getUser();
  const userId = user?._id || null;
  const initialCached = storage.getCachedToken(userId);

  const [token, setToken] = useState(() => {
    if (initialCached && (!initialTokenId || initialCached._id === initialTokenId)) {
      return initialCached;
    }
    return null;
  });
  const [isCached, setIsCached] = useState(() => Boolean(initialCached && (!initialTokenId || initialCached._id === initialTokenId)));
  const [cachedAt, setCachedAt] = useState(() => initialCached?._cachedAt || null);
  const [loading, setLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [connectionStatus, setConnectionStatus] = useState('connected');
  const [turnAlert, setTurnAlert] = useState(null);

  const tokenIdRef = useRef(initialTokenId);
  const onlineRef = useRef(isOnline);

  useEffect(() => {
    tokenIdRef.current = initialTokenId;
  }, [initialTokenId]);

  const fetchAuthoritativeToken = useCallback(async (id, silent = false) => {
    const targetId = id || tokenIdRef.current;
    if (!targetId) {
      setLoading(false);
      return;
    }
    try {
      if (!silent) setIsRefreshing(true);
      setError(null);
      const res = await tokenAPI.getById(targetId);
      const tokenData = res.data?.token;
      if (tokenData) {
        setToken(tokenData);
        setIsCached(false);
        const now = new Date().toISOString();
        setCachedAt(now);
        storage.setCachedToken(tokenData, storage.getUser()?._id);
      }
    } catch (err) {
      const isNetworkErr = !err.status || err.code === 'ERR_NETWORK' || (typeof navigator !== 'undefined' && !navigator.onLine);
      const isServerErr = err.status >= 500;
      const cached = storage.getCachedToken(storage.getUser()?._id);

      if ((isNetworkErr || isServerErr) && cached && cached._id === targetId) {
        setToken(cached);
        setIsCached(true);
        setCachedAt(cached._cachedAt || new Date().toISOString());
        if (isServerErr) {
          setError('Temporary server disruption. Showing last known queue status.');
        } else {
          setError(null);
        }
      } else if (err.status === 401 || err.status === 403) {
        setToken(null);
        setIsCached(false);
        setError(err.message || 'Authentication required');
      } else {
        setError(err.message || 'Failed to load token details');
      }
    } finally {
      setLoading(false);
      setIsRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchAuthoritativeToken(initialTokenId);
  }, [initialTokenId, fetchAuthoritativeToken]);

  // When coming back online, revalidate authoritative state immediately.
  //
  // Only a real offline -> online *transition* triggers a refetch. On mount the
  // effect above already fetches, and a second unauthenticated request on mount
  // can come back 401, which would clear a perfectly valid cached snapshot.
  useEffect(() => {
    const wasOnline = onlineRef.current;
    onlineRef.current = isOnline;
    if (wasOnline === isOnline) return;
    if (isOnline && tokenIdRef.current) {
      fetchAuthoritativeToken(tokenIdRef.current, true);
    }
  }, [isOnline, fetchAuthoritativeToken]);

  // Multi-tab cache synchronization
  useEffect(() => {
    const unsubSync = storage.onCacheSync((msg) => {
      if (msg.type === 'TOKEN_CACHED' && msg.tokenId === tokenIdRef.current) {
        const freshCached = storage.getCachedToken(storage.getUser()?._id);
        if (freshCached && freshCached._id === tokenIdRef.current) {
          setToken(freshCached);
          setIsCached(true);
          setCachedAt(freshCached._cachedAt);
        }
      } else if (msg.type === 'CACHE_CLEARED') {
        setToken(null);
        setIsCached(false);
        setCachedAt(null);
      }
    });
    return () => unsubSync();
  }, []);

  // Real-time socket event handling
  useEffect(() => {
    const socket = connectSocket();

    const unsubStatus = onSocketStatus((status) => {
      setConnectionStatus(status);
    });

    const unsubReconnect = onSocketReconnect(() => {
      if (tokenIdRef.current) {
        fetchAuthoritativeToken(tokenIdRef.current, true);
      }
    });

    const handleTokenUpdated = (data) => {
      const updatedToken = data?.token;
      if (!updatedToken) return;

      if (!tokenIdRef.current || updatedToken._id === tokenIdRef.current) {
        setToken((prev) => {
          const next = {
            ...prev,
            ...updatedToken,
            peopleAhead: updatedToken.peopleAhead !== undefined
              ? updatedToken.peopleAhead
              : updatedToken.status === 'WAITING'
                ? Math.max(0, (updatedToken.currentPosition || 1) - 1)
                : 0,
          };
          setIsCached(false);
          setCachedAt(new Date().toISOString());
          storage.setCachedToken(next, storage.getUser()?._id);
          return next;
        });

        if (updatedToken.status === 'CALLED') {
          const counterLabel = updatedToken.counterId?.displayLabel || updatedToken.counterId?.name || 'the counter';
          setTurnAlert(`It's your turn! Please proceed to ${counterLabel}.`);
          announceTokenCall({
            tokenCode: updatedToken.tokenCode,
            counterName: counterLabel,
            tokenId: updatedToken._id,
            calledAt: updatedToken.calledAt,
          });
        }
      }
    };

    const handlePositionUpdated = (data) => {
      if (!data) return;
      const targetId = tokenIdRef.current;
      const incomingId = (data.tokenId || data._id || '').toString();
      if (!targetId || incomingId === targetId.toString()) {
        setToken((prev) => {
          if (!prev) return prev;
          const pos = data.currentPosition !== undefined ? data.currentPosition : data.position !== undefined ? data.position : prev.currentPosition;
          const wait = data.waitEstimateMinutes !== undefined ? data.waitEstimateMinutes : data.estimatedWaitMinutes !== undefined ? data.estimatedWaitMinutes : prev.waitEstimateMinutes;
          const ahead = data.peopleAhead !== undefined ? data.peopleAhead : Math.max(0, (pos || 1) - 1);
          const next = {
            ...prev,
            currentPosition: pos,
            waitEstimateMinutes: wait,
            estimatedWaitMinutes: wait,
            peopleAhead: ahead,
          };
          setIsCached(false);
          setCachedAt(new Date().toISOString());
          storage.setCachedToken(next, storage.getUser()?._id);
          return next;
        });
      }
    };

    const handleProximityUpdated = (data) => {
      if (!data) return;
      const targetId = tokenIdRef.current;
      const incomingId = (data.tokenId || '').toString();
      if (!targetId || incomingId === targetId.toString()) {
        setToken((prev) => {
          if (!prev) return prev;
          const next = {
            ...prev,
            proximityState: data.proximityState || prev.proximityState,
            proximityDistanceMeters: data.distanceMeters !== undefined ? data.distanceMeters : prev.proximityDistanceMeters,
            proximityUpdatedAt: new Date().toISOString(),
          };
          setIsCached(false);
          setCachedAt(new Date().toISOString());
          storage.setCachedToken(next, storage.getUser()?._id);
          return next;
        });
      }
    };

    socket.on('token.called', handleTokenUpdated);
    socket.on('token.serving', handleTokenUpdated);
    socket.on('token.completed', handleTokenUpdated);
    socket.on('token.skipped', handleTokenUpdated);
    socket.on('token.cancelled', handleTokenUpdated);
    socket.on('token.expired', handleTokenUpdated);
    socket.on('token.position_updated', handlePositionUpdated);
    socket.on('token:proximity', handleProximityUpdated);

    return () => {
      unsubStatus();
      unsubReconnect();
      socket.off('token.called', handleTokenUpdated);
      socket.off('token.serving', handleTokenUpdated);
      socket.off('token.completed', handleTokenUpdated);
      socket.off('token.skipped', handleTokenUpdated);
      socket.off('token.cancelled', handleTokenUpdated);
      socket.off('token.expired', handleTokenUpdated);
      socket.off('token.position_updated', handlePositionUpdated);
      socket.off('token:proximity', handleProximityUpdated);
    };
  }, [fetchAuthoritativeToken]);

  const dismissTurnAlert = () => setTurnAlert(null);

  // Compute canonical connection state
  let connectionState = 'ONLINE_FRESH';
  if (!isOnline) {
    connectionState = token ? 'OFFLINE_LAST_KNOWN' : 'OFFLINE_NO_CACHE';
  } else if (connectionStatus === 'reconnecting' || connectionStatus === 'error') {
    connectionState = 'ONLINE_RECONNECTING';
  } else if (isRefreshing && token) {
    connectionState = 'ONLINE_STALE';
  } else if (!token) {
    connectionState = 'NO_DATA_AVAILABLE';
  } else if (isCached) {
    connectionState = 'ONLINE_STALE';
  } else {
    connectionState = 'ONLINE_FRESH';
  }

  return {
    token,
    loading,
    error,
    isOnline,
    connectionStatus,
    connectionState,
    isCached,
    cachedAt,
    isRefreshing,
    turnAlert,
    dismissTurnAlert,
    refetch: () => fetchAuthoritativeToken(tokenIdRef.current),
  };
}

