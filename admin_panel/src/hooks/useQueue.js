import { useState, useEffect, useCallback } from 'react';
import { queueAPI } from '../services/api';
import { useSocket } from '../context/SocketContext';

export function useQueue(centerId) {
  const [queues, setQueues] = useState([]);
  const [liveLog, setLiveLog] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const { on } = useSocket();

  const fetchQueueData = useCallback(async () => {
    if (!centerId) return;
    try {
      setError(null);
      const [queueRes, eventsRes] = await Promise.all([
        queueAPI.getStatus(centerId),
        queueAPI.getRecentEvents(centerId).catch(() => ({ data: { events: [] } })),
      ]);

      if (queueRes.success && queueRes.data?.queues) {
        setQueues(queueRes.data.queues);
      }

      if (eventsRes.success && eventsRes.data?.events) {
        // Map backend QueueEvent documents to live log entries
        const formattedEvents = eventsRes.data.events.map((ev) => {
          const date = new Date(ev.createdAt);
          const timeStr = `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;
          
          let tag = 'info';
          let message = 'Queue event recorded';

          switch (ev.eventType) {
            case 'TOKEN_CALLED':
              tag = 'called';
              message = `Token ${ev.metadata?.tokenCode || ''} called to ${ev.metadata?.counterName || 'counter'}`;
              break;
            case 'TOKEN_SERVING':
              tag = 'serving';
              message = `Token ${ev.metadata?.tokenCode || ''} started service`;
              break;
            case 'TOKEN_COMPLETED':
              tag = 'done';
              message = `Token ${ev.metadata?.tokenCode || ''} completed (${ev.metadata?.actualServiceSeconds ? `${Math.round(ev.metadata.actualServiceSeconds / 60)}m` : 'done'})`;
              break;
            case 'TOKEN_SKIPPED':
              tag = 'skip';
              message = `Token ${ev.metadata?.tokenCode || ''} skipped`;
              break;
            case 'TOKEN_CANCELLED':
              tag = 'skip';
              message = `Token ${ev.metadata?.tokenCode || ''} cancelled`;
              break;
            case 'TOKEN_EXPIRED':
              tag = 'skip';
              message = `Token ${ev.metadata?.tokenCode || ''} expired (no-show)`;
              break;
            case 'TOKEN_CREATED':
              tag = 'waiting';
              message = `Token ${ev.metadata?.tokenCode || ''} joined queue`;
              break;
            case 'COUNTER_OPENED':
              tag = 'done';
              message = `${ev.metadata?.counterName || 'Counter'} opened`;
              break;
            case 'COUNTER_BREAK':
              tag = 'break';
              message = `${ev.metadata?.counterName || 'Counter'} on break`;
              break;
            case 'COUNTER_CLOSED':
              tag = 'break';
              message = `${ev.metadata?.counterName || 'Counter'} closed`;
              break;
            default:
              message = ev.eventType.replace(/_/g, ' ');
          }

          return {
            id: ev._id,
            t: timeStr,
            tag,
            event: message,
            timestamp: ev.createdAt,
          };
        });
        setLiveLog(formattedEvents.slice(0, 15));
      }
    } catch (err) {
      console.error('Error fetching queue status:', err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [centerId]);

  useEffect(() => {
    fetchQueueData();
  }, [fetchQueueData]);

  // Real-time socket event handlers
  useEffect(() => {
    if (!centerId) return;

    const addLogEntry = (tag, event) => {
      const now = new Date();
      const timeStr = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;
      setLiveLog((prev) => [
        { id: `${Date.now()}-${prev.length + 1}`, t: timeStr, tag, event, timestamp: now.toISOString() },
        ...prev.slice(0, 14),
      ]);
    };

    const unsubQueue = on('queue.updated', (data) => {
      // The socket is already scoped to this center's room, so a payload that
      // omits centerId is still ours. Previously the guard required an exact
      // centerId match, which silently discarded every update whose payload
      // did not carry one.
      if (data.centerId && data.centerId !== centerId) return;

      // Merge only fields that are actually present. The old code assigned
      // `totalIssued` unconditionally, so a payload without that field wrote
      // `undefined` over a real number.
      const serviceId = data.serviceId;
      setQueues((prev) => {
        if (!serviceId) return prev;
        let changed = false;
        const next = prev.map((q) => {
          if (q.service?._id !== serviceId && q._id !== serviceId) return q;
          const updated = { ...q };
          for (const key of ['waitingCount', 'activeCount', 'totalIssued']) {
            if (typeof data[key] === 'number') {
              if (updated[key] !== data[key]) changed = true;
              updated[key] = data[key];
            }
          }
          return changed ? updated : q;
        });
        return changed ? next : prev;
      });
    });

    const unsubTokenCreated = on('token.created', (data) => {
      const token = data.token;
      if (token) {
        addLogEntry('waiting', `Token ${token.tokenCode} joined queue`);
        fetchQueueData();
      }
    });

    const unsubTokenCalled = on('token.called', (data) => {
      const { token, counter } = data;
      if (token && counter) {
        addLogEntry('called', `${token.tokenCode} called to ${counter.name}`);
        fetchQueueData();
      }
    });

    const unsubTokenServing = on('token.serving', (data) => {
      const { token } = data;
      if (token) {
        addLogEntry('serving', `Token ${token.tokenCode} started serving`);
        fetchQueueData();
      }
    });

    const unsubTokenCompleted = on('token.completed', (data) => {
      const { token } = data;
      if (token) {
        const dur = token.actualServiceSeconds ? `${Math.round(token.actualServiceSeconds / 60)}m` : 'done';
        addLogEntry('done', `${token.tokenCode} completed (${dur})`);
        fetchQueueData();
      }
    });

    const unsubTokenSkipped = on('token.skipped', (data) => {
      const { token } = data;
      if (token) {
        addLogEntry('skip', `${token.tokenCode} skipped`);
        fetchQueueData();
      }
    });

    const unsubTokenCancelled = on('token.cancelled', (data) => {
      const { token } = data;
      if (token) {
        addLogEntry('skip', `${token.tokenCode} cancelled`);
        fetchQueueData();
      }
    });

    const unsubTokenExpired = on('token.expired', (data) => {
      const { token } = data;
      if (token) {
        addLogEntry('skip', `${token.tokenCode} expired (no-show)`);
        fetchQueueData();
      }
    });

    return () => {
      unsubQueue();
      unsubTokenCreated();
      unsubTokenCalled();
      unsubTokenServing();
      unsubTokenCompleted();
      unsubTokenSkipped();
      unsubTokenCancelled();
      unsubTokenExpired();
    };
  }, [centerId, on, fetchQueueData]);

  return {
    queues,
    liveLog,
    loading,
    error,
    refreshQueue: fetchQueueData,
  };
}
