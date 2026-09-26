import { useState, useEffect, useCallback, useRef } from 'react';
import { connectSocket, onSocketStatus, onSocketReconnect } from '../services/socket';
import { tokenAPI } from '../services/api';
import { storage } from '../services/storage';

import { announceTokenCall } from '../utils/announcer';

export function useLiveToken(initialTokenId) {
  const [token, setToken] = useState(() => storage.getLastKnownToken());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [connectionStatus, setConnectionStatus] = useState('connected');
  const [turnAlert, setTurnAlert] = useState(null);

  const tokenIdRef = useRef(initialTokenId);

  useEffect(() => {
    tokenIdRef.current = initialTokenId;
  }, [initialTokenId]);

  const fetchAuthoritativeToken = useCallback(async (id) => {
    const targetId = id || tokenIdRef.current;
    if (!targetId) {
      setLoading(false);
      return;
    }
    try {
      setError(null);
      const res = await tokenAPI.getById(targetId);
      const tokenData = res.data?.token;
      if (tokenData) {
        setToken(tokenData);
        storage.setLastKnownToken(tokenData);
      }
    } catch (err) {
      // If network error, preserve cached token
      const cached = storage.getLastKnownToken();
      if (cached && cached._id === targetId) {
        setToken(cached);
      } else {
        setError(err.message || 'Failed to load token details');
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAuthoritativeToken(initialTokenId);
  }, [initialTokenId, fetchAuthoritativeToken]);

  // Real-time socket event handling
  useEffect(() => {
    const socket = connectSocket();

    const unsubStatus = onSocketStatus((status) => {
      setConnectionStatus(status);
    });

    const unsubReconnect = onSocketReconnect(() => {
      if (tokenIdRef.current) {
        fetchAuthoritativeToken(tokenIdRef.current);
      }
    });

    const handleTokenUpdated = (data) => {
      const updatedToken = data?.token;
      if (!updatedToken) return;

      if (!tokenIdRef.current || updatedToken._id === tokenIdRef.current) {
        setToken((prev) => ({
          ...prev,
          ...updatedToken,
          peopleAhead: updatedToken.peopleAhead !== undefined
            ? updatedToken.peopleAhead
            : updatedToken.status === 'WAITING'
              ? Math.max(0, (updatedToken.currentPosition || 1) - 1)
              : 0,
        }));
        storage.setLastKnownToken(updatedToken);

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
          storage.setLastKnownToken(next);
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
    };
  }, [fetchAuthoritativeToken]);

  const dismissTurnAlert = () => setTurnAlert(null);

  return {
    token,
    loading,
    error,
    connectionStatus,
    turnAlert,
    dismissTurnAlert,
    refetch: () => fetchAuthoritativeToken(tokenIdRef.current),
  };
}
