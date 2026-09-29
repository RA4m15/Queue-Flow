import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { counterAPI } from '../services/api';
import { joinCounterRoom, leaveCounterRoom } from '../services/socket';
import { describeCallNextOutcome, describeSkippedEvent } from '../services/callNextOutcome';

/**
 * Every socket event the operator panel reacts to.
 *
 * These are the events the backend already emits (see backend/src/services/queueService.js
 * and backend/src/controllers/counterController.js). Nothing here is invented
 * client-side, and the panel never mutates a token locally: an action is an API
 * call and the resulting state arrives from the server.
 */
const OPERATOR_EVENTS = [
  'token.called',
  'token.serving',
  'token.completed',
  'token.skipped',
  'token.cancelled',
  'token.expired',
  'queue.updated',
  'counter.updated',
  'workload.updated',
];

/**
 * Read a Mongo id off a field that may be a raw id or a populated document.
 * Mirrors the backend's `idOf` so client-side scoping compares the same way the
 * server does.
 */
export function idOf(value) {
  if (!value) return null;
  if (typeof value === 'object' && value._id) return String(value._id);
  return String(value);
}

/**
 * Center a socket payload belongs to, normalised to a string id.
 *
 * The backend emits several shapes for the same logical event (a token payload
 * with `centerId`, a counter payload with `counter.centerId`, a `queue.updated`
 * with a top-level `centerId`), so all of them are probed. Returns null when the
 * payload carries no center at all, in which case the caller decides.
 */
function payloadCenterId(payload) {
  const raw = payload?.centerId ?? payload?.token?.centerId ?? payload?.counter?.centerId;
  return raw ? idOf(raw) : null;
}

/**
 * Counter a socket payload refers to, normalised to a string id.
 */
function payloadCounterId(payload) {
  const raw = payload?.counter?._id ?? payload?.counterId ?? payload?.token?.counterId;
  return raw ? idOf(raw) : null;
}

/**
 * Should this realtime event be allowed to trigger a refetch of the counter
 * currently on screen?
 *
 * A counter's own events always apply. Center-wide events (a customer joining
 * the queue, another counter calling someone) only apply when they concern the
 * same facility. This is what keeps Counter 01 and Counter 02 independent, and
 * what stops a payload carrying no identifiable center from blindly resetting
 * the visible state.
 */
export function shouldApplyEvent(eventName, payload, scope) {
  if (!scope || !scope.counterId) return false;

  const eventCenter = payloadCenterId(payload);
  if (eventCenter && scope.centerId && eventCenter !== scope.centerId) return false;

  const eventCounter = payloadCounterId(payload);
  if (eventCounter && eventCounter !== scope.counterId) return false;

  // `counter.updated` is the one event that is meaningful only for a specific
  // counter, so require an explicit counter match for it rather than letting a
  // centre-wide payload overwrite the counter header.
  if (eventName === 'counter.updated' && !eventCounter) return false;

  // `queue.updated` is meaningful per service, so when it names one, only apply
  // it if it is the service this counter actually runs.
  if (eventName === 'queue.updated' && payload?.serviceId) {
    const eventService = idOf(payload.serviceId);
    if (scope.serviceId && eventService !== scope.serviceId) return false;
  }

  return true;
}

/**
 * Operator panel state for a single counter.
 *
 * ── The rule this hook exists to enforce ────────────────────────────────────
 * The selected FACILITY is authoritative. Every piece of data rendered by the
 * panel is fetched with that facility id, and the selected COUNTER is always
 * re-validated against it before it is shown. Switching facility clears the
 * counter, its tokens, its queue numbers and its current customer before any
 * new data is drawn, so a previous counter's state can never linger on screen.
 *
 * @param {object}   options
 * @param {string|null} options.centerId    active facility (authoritative)
 * @param {Function} options.on             socket subscribe helper
 * @param {Function} options.setActiveCenterId
 */
export default function useOperatorCounter({ centerId, on, setActiveCenterId }) {
  const [counter, setCounter] = useState(null);
  const [center, setCenter] = useState(null);
  const [service, setService] = useState(null);
  const [queue, setQueue] = useState(null);
  const [waitingTokens, setWaitingTokens] = useState([]);
  const [waitingCount, setWaitingCount] = useState(0);
  const [estimatedWaitMinutes, setEstimatedWaitMinutes] = useState(null);
  const [workload, setWorkload] = useState(null);
  const [selectedCounterId, setSelectedCounterId] = useState(null);
  const [operableCounters, setOperableCounters] = useState([]);
  const [canSelectAnyCounter, setCanSelectAnyCounter] = useState(false);

  const [loading, setLoading] = useState(true);
  const [countersLoading, setCountersLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [successMessage, setSuccessMessage] = useState('');
  const [actionDetails, setActionDetails] = useState([]);

  // Guards against a slow response for counter A landing after the operator has
  // already switched to counter B, which would put A's data back on screen.
  const requestSeq = useRef(0);
  const scopeRef = useRef({ centerId: null, counterId: null, serviceId: null });
  // The facility the panel is currently scoped to. Kept in a ref because the
  // counter-room effect below must always read the value the loaded counter was
  // actually resolved against, not a possibly newer facility selection.
  const activeCenterRef = useRef(null);

  const clearMessages = useCallback(() => {
    setErrorMessage('');
    setSuccessMessage('');
    setActionDetails([]);
  }, []);

  /** Wipe every counter-scoped value. Used on facility change and before a
   *  counter switch so no previous counter's data is ever shown alongside the
   *  new one. */
  const clearCounterState = useCallback(() => {
    setCounter(null);
    setCenter(null);
    setService(null);
    setQueue(null);
    setWaitingTokens([]);
    setWaitingCount(0);
    setEstimatedWaitMinutes(null);
    setWorkload(null);
    clearMessages();
  }, [clearMessages]);

  /**
   * Load the real counters for the selected facility.
   * Always a backend read; the list is never constructed in the client.
   */
  const loadOperableCounters = useCallback(async () => {
    if (!centerId) {
      setOperableCounters([]);
      return [];
    }
    setCountersLoading(true);
    try {
      const res = await counterAPI.getOperableCounters(centerId);
      const list = res?.data?.counters || [];
      setOperableCounters(list);
      setCanSelectAnyCounter(Boolean(res?.data?.canSelectAnyCounter));
      return list;
    } catch (err) {
      setOperableCounters([]);
      setErrorMessage(err.message || 'Failed to load counters for this facility');
      return [];
    } finally {
      setCountersLoading(false);
    }
  }, [centerId]);

  /**
   * Load the authoritative state of one counter.
   *
   * `counterId` omitted → the backend resolves the caller's own assigned
   * counter (the normal operator path). `counterId` given → it is validated
   * against `centerId` server-side before it is returned.
   */
  const loadCounterState = useCallback(
    async (counterId = null) => {
      const seq = ++requestSeq.current;
      try {
        setErrorMessage('');
        const res = await counterAPI.getOperatorCounter(centerId || undefined, counterId || undefined);

        // A newer request already won — drop this response.
        if (seq !== requestSeq.current) return;

        const data = res?.data || {};
        if (!data.counter) {
          clearCounterState();
          setLoading(false);
          return;
        }

        const loadedCounter = data.counter;
        const loadedCenterId = idOf(loadedCounter.centerId?._id || loadedCounter.centerId);
        const loadedServiceId = loadedCounter.serviceId
          ? idOf(loadedCounter.serviceId._id || loadedCounter.serviceId)
          : null;

        setCounter(loadedCounter);
        setCenter(data.center || loadedCounter.centerId || null);
        setService(data.service || loadedCounter.serviceId || null);
        setQueue(data.queue || null);
        setWaitingTokens(Array.isArray(data.waitingTokens) ? data.waitingTokens : []);
        setWaitingCount(
          typeof data.waitingCount === 'number' ? data.waitingCount : (data.waitingTokens || []).length
        );
        setEstimatedWaitMinutes(
          typeof data.estimatedWaitMinutes === 'number' ? data.estimatedWaitMinutes : null
        );
        setWorkload(data.workload || null);
        setCanSelectAnyCounter(Boolean(data.canSelectAnyCounter));
        setSelectedCounterId(idOf(loadedCounter._id));

        scopeRef.current = {
          centerId: loadedCenterId || centerId || null,
          counterId: idOf(loadedCounter._id),
          serviceId: loadedServiceId,
        };
        activeCenterRef.current = scopeRef.current.centerId;

        // Keep the global facility in step with the counter actually on screen,
        // but only ever FORWARD to the same value — never overwrite a facility
        // the operator deliberately selected with one from an older response.
        if (loadedCenterId && centerId && loadedCenterId !== centerId) {
          setErrorMessage(
            `This counter belongs to a different facility. Showing ${loadedCenter?.name || 'another facility'}.`
          );
        } else if (loadedCenterId && setActiveCenterId) {
          setActiveCenterId(loadedCenterId);
        }
      } catch (err) {
        if (seq !== requestSeq.current) return;
        clearCounterState();
        setErrorMessage(err.message || 'Failed to load counter state');
      } finally {
        if (seq === requestSeq.current) setLoading(false);
      }
    },
    [centerId, clearCounterState, setActiveCenterId]
  );

  // ── Facility change: reset everything, then load the new facility ──────────
  useEffect(() => {
    // Invalidate any in-flight response for the previous facility.
    requestSeq.current += 1;
    scopeRef.current = { centerId: centerId || null, counterId: null, serviceId: null };
    setSelectedCounterId(null);
    clearCounterState();

    if (!centerId) {
      setOperableCounters([]);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    loadOperableCounters().then(() => {
      if (cancelled) return;
      // No counterId: the backend resolves the caller's own assigned counter.
      // For an ADMIN that returns `requiresCounterSelection` and a null counter,
      // which the page renders as the "CHOOSE COUNTER" prompt.
      loadCounterState(null);
    });

    return () => {
      cancelled = true;
    };
  }, [centerId, clearCounterState, loadOperableCounters, loadCounterState]);

  /**
   * Switch to a different counter. Everything from the previous counter is
   * cleared first, then the new counter's real state is loaded.
   */
  const selectCounter = useCallback(
    async (counterId) => {
      if (!counterId) return;
      if (!centerId) {
        setErrorMessage('Select a facility before choosing a counter');
        return;
      }
      const target = operableCounters.find((c) => idOf(c._id) === String(counterId));
      if (target && target.canOperate === false) {
        setErrorMessage(
          target.isAssignedToCaller
            ? 'This counter has no service assigned, so no queue can be served from it'
            : 'You are not authorized to operate this counter'
        );
        return;
      }

      // Clear the previous counter before the new one is drawn.
      requestSeq.current += 1;
      scopeRef.current = { centerId, counterId: String(counterId), serviceId: null };
      setSelectedCounterId(String(counterId));
      clearCounterState();
      setLoading(true);
      await loadCounterState(counterId);
    },
    [centerId, operableCounters, clearCounterState, loadCounterState]
  );

  const reload = useCallback(async () => {
    await Promise.all([loadOperableCounters(), loadCounterState(selectedCounterId)]);
  }, [loadOperableCounters, loadCounterState, selectedCounterId]);

  // ── Counter room subscription ─────────────────────────────────────────────
  //
  // The backend broadcasts `counter.updated` for a specific counter to the
  // counter room `counter:<centerId>:<counterId>`, NOT to the center room. The
  // operator panel therefore has to join that room to see it. Subscribing only
  // for the counter actually on screen keeps the panel focused: switching
  // counters leaves the old room, so Counter 01's updates can never overwrite
  // Counter 02's screen.
  useEffect(() => {
    const centerForRoom = activeCenterRef.current;
    if (!selectedCounterId || !centerForRoom) return undefined;

    joinCounterRoom(centerForRoom, selectedCounterId);
    return () => {
      leaveCounterRoom(centerForRoom, selectedCounterId);
    };
  }, [selectedCounterId]);

  // ── Realtime ───────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!on) return undefined;

    const unsubscribes = OPERATOR_EVENTS.map((eventName) =>
      on(eventName, (payload) => {
        if (!shouldApplyEvent(eventName, payload, scopeRef.current)) return;

        if (eventName === 'token.skipped') {
          // A geofence auto-skip happened on the operator's behalf, so it is
          // surfaced explicitly rather than only showing up as a vanished row.
          // A manual skip is not re-announced.
          const announced = describeSkippedEvent(payload);
          if (announced) {
            setErrorMessage('');
            setSuccessMessage(announced.message);
            setActionDetails([]);
          }
        }

        // Refetch from the backend rather than patching local state, so the
        // panel can never drift from the server's view of the queue.
        loadCounterState(scopeRef.current.counterId);
      })
    );

    return () => {
      unsubscribes.forEach((unsub) => unsub?.());
    };
  }, [on, loadCounterState]);

  // ── Actions (all server-side; no local token simulation) ───────────────────
  const runAction = useCallback(
    async (fn, { success } = {}) => {
      const counterId = scopeRef.current.counterId;
      if (!counterId) {
        setErrorMessage('No counter selected');
        return null;
      }
      setActionLoading(true);
      setErrorMessage('');
      setSuccessMessage('');
      setActionDetails([]);
      try {
        const res = await fn(counterId, scopeRef.current.centerId);
        if (success) setSuccessMessage(success(res));
        await loadCounterState(counterId);
        return res;
      } catch (err) {
        setErrorMessage(err.message || 'Action failed');
        await loadCounterState(counterId);
        return null;
      } finally {
        setActionLoading(false);
      }
    },
    [loadCounterState]
  );

  const callNext = useCallback(
    () =>
      runAction((counterId, cId) => counterAPI.callNext(counterId, cId), {
        // Report the authoritative backend outcome, including who was
        // auto-skipped and who was deliberately left alone. Never a fabricated
        // token code.
        success: (res) => describeCallNextOutcome(res).message,
      }).then((res) => {
        if (res) setActionDetails(describeCallNextOutcome(res).details);
        return res;
      }),
    [runAction]
  );

  const startServing = useCallback(
    () =>
      runAction((counterId, cId) => counterAPI.startServing(counterId, cId), {
        success: (res) => `Token ${res?.data?.token?.tokenCode} is now SERVING`,
      }),
    [runAction]
  );

  const complete = useCallback(
    () =>
      runAction((counterId, cId) => counterAPI.complete(counterId, cId), {
        success: (res) => `Token ${res?.data?.token?.tokenCode} COMPLETED`,
      }),
    [runAction]
  );

  const skip = useCallback(
    () =>
      runAction((counterId, cId) => counterAPI.skip(counterId, undefined, cId), {
        success: (res) => `Token ${res?.data?.token?.tokenCode} skipped`,
      }),
    [runAction]
  );

  const recall = useCallback(
    () =>
      runAction((counterId, cId) => counterAPI.recall(counterId, cId), {
        success: (res) => `Token ${res?.data?.token?.tokenCode} re-called`,
      }),
    [runAction]
  );

  const setCounterStatus = useCallback(
    (status) =>
      runAction((counterId, cId) => counterAPI.updateStatus(counterId, status, cId), {
        success: () => `Counter status changed to ${status}`,
      }),
    [runAction]
  );

  // ── Derived action availability, driven by backend state ──────────────────
  const currentToken = counter?.currentTokenId || null;
  const tokenStatus = currentToken?.status || null;
  const counterStatus = counter?.status || null;

  const isActive = counterStatus === 'ACTIVE';
  const isBreak = counterStatus === 'BREAK';
  const isClosed = counterStatus === 'CLOSED';
  const isCalled = tokenStatus === 'CALLED';
  const isServing = tokenStatus === 'SERVING';
  const hasToken = Boolean(currentToken);
  const hasService = Boolean(service?._id);

  const availability = useMemo(
    () => ({
      // Token actions require an open counter, a real service on that counter,
      // and no token already in progress.
      canCallNext: isActive && hasService && !hasToken && waitingCount > 0,
      canStartServing: isActive && isCalled,
      canComplete: isActive && (isServing || isCalled),
      canSkip: isActive && (isServing || isCalled),
      canRecall: isActive && isCalled,
    }),
    [isActive, hasService, hasToken, waitingCount, isServing, isCalled]
  );

  return {
    // data
    counter,
    center,
    service,
    queue,
    waitingTokens,
    waitingCount,
    estimatedWaitMinutes,
    workload,
    operableCounters,
    selectedCounterId,
    currentToken,
    counterStatus,
    tokenStatus,
    // state
    loading,
    countersLoading,
    actionLoading,
    errorMessage,
    successMessage,
    actionDetails,
    canSelectAnyCounter,
    // flags
    isActive,
    isBreak,
    isClosed,
    isCalled,
    isServing,
    hasService,
    ...availability,
    // actions
    selectCounter,
    reload,
    loadOperableCounters,
    callNext,
    startServing,
    complete,
    skip,
    recall,
    setCounterStatus,
    clearMessages,
  };
}
