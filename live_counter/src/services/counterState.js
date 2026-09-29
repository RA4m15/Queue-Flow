/**
 * Counter-specific serving state manager for Live Counter
 * Tracks each counter independently, ensuring operations on one counter
 * (such as calling or completing a token) do not overwrite or clear other counters.
 */

export function isCounterMatch(c, counterEvent, tokenEvent) {
  if (!c) return false;

  // 1. Direct ID match
  const counterId = counterEvent?._id || counterEvent?.id;
  if (counterId && c._id && String(c._id) === String(counterId)) return true;

  const tokenCounterId =
    tokenEvent?.counterId?._id ||
    tokenEvent?.counterId?.id ||
    (typeof tokenEvent?.counterId === 'string' ? tokenEvent.counterId : null);
  if (tokenCounterId && c._id && String(c._id) === String(tokenCounterId)) return true;

  // 2. Number match
  const cNum = typeof c.number === 'number' ? c.number : parseInt(c.number, 10);
  if (counterEvent?.number !== undefined && counterEvent?.number !== null) {
    const evNum =
      typeof counterEvent.number === 'number'
        ? counterEvent.number
        : parseInt(counterEvent.number, 10);
    if (!Number.isNaN(cNum) && !Number.isNaN(evNum) && cNum === evNum) return true;
  }
  if (tokenEvent?.counterId?.number !== undefined && tokenEvent?.counterId?.number !== null) {
    const tokNum =
      typeof tokenEvent.counterId.number === 'number'
        ? tokenEvent.counterId.number
        : parseInt(tokenEvent.counterId.number, 10);
    if (!Number.isNaN(cNum) && !Number.isNaN(tokNum) && cNum === tokNum) return true;
  }

  // 3. Name or display label match
  const norm = (s) => (s ? String(s).trim().toLowerCase() : '');
  const cName = norm(c.name);
  const cDisplay = norm(c.displayLabel);

  const evName = norm(counterEvent?.name);
  const evDisplay = norm(counterEvent?.displayLabel);
  if (
    (evName && (evName === cName || evName === cDisplay)) ||
    (evDisplay && (evDisplay === cName || evDisplay === cDisplay))
  ) {
    return true;
  }

  const tokCounterName = norm(tokenEvent?.counterId?.name);
  const tokCounterDisplay = norm(tokenEvent?.counterId?.displayLabel);
  if (
    (tokCounterName && (tokCounterName === cName || tokCounterName === cDisplay)) ||
    (tokCounterDisplay && (tokCounterDisplay === cName || tokCounterDisplay === cDisplay))
  ) {
    return true;
  }

  return false;
}

export function buildCountersState(backendCounters = [], nowServing = []) {
  if (!Array.isArray(backendCounters) || backendCounters.length === 0) {
    if (Array.isArray(nowServing) && nowServing.length > 0) {
      return nowServing.map((t, idx) => ({
        _id: t.counterId?._id || `counter-${idx + 1}`,
        number: t.counterId?.number || idx + 1,
        name:
          t.counterId?.name ||
          (t.counterId?.number ? `Counter ${t.counterId.number}` : `Counter ${idx + 1}`),
        displayLabel:
          t.counterId?.displayLabel ||
          t.counterId?.name ||
          (t.counterId?.number
            ? `COUNTER ${String(t.counterId.number).padStart(2, '0')}`
            : `COUNTER ${String(idx + 1).padStart(2, '0')}`),
        status: 'ACTIVE',
        service: t.serviceId
          ? { name: t.serviceId.name, tokenPrefix: t.serviceId.tokenPrefix }
          : { name: 'Active Service' },
        servingToken: {
          _id: t._id,
          tokenCode: t.tokenCode,
          status: t.status,
          calledAt: t.calledAt,
        },
      }));
    }
    return [];
  }

  const isNowServingExplicitEmpty = Array.isArray(nowServing) && nowServing.length === 0;

  return backendCounters.map((c, idx) => {
    // Match serving token from nowServing or fallback to c.servingToken
    const matchedToken = Array.isArray(nowServing)
      ? nowServing.find((t) => isCounterMatch(c, null, t))
      : null;

    const counterLabel =
      matchedToken?.counterId?.displayLabel ||
      c.displayLabel ||
      c.name ||
      (c.number
        ? `COUNTER ${String(c.number).padStart(2, '0')}`
        : `COUNTER ${String(idx + 1).padStart(2, '0')}`);

    // If nowServing is explicitly empty, this center currently has no active serving tokens
    if (isNowServingExplicitEmpty) {
      return {
        ...c,
        displayLabel: counterLabel,
        servingToken: null,
      };
    }

    let servingToken = null;
    if (matchedToken) {
      servingToken = {
        _id: matchedToken._id,
        tokenCode: matchedToken.tokenCode,
        status: matchedToken.status,
        calledAt: matchedToken.calledAt,
        serviceId: matchedToken.serviceId,
      };
    } else if (c.servingToken && ['CALLED', 'SERVING'].includes(c.servingToken.status)) {
      servingToken = { ...c.servingToken };
    }

    return {
      ...c,
      displayLabel: counterLabel,
      service:
        c.service ||
        (matchedToken?.serviceId
          ? { name: matchedToken.serviceId.name, tokenPrefix: matchedToken.serviceId.tokenPrefix }
          : null),
      servingToken,
    };
  });
}

export function updateCounterOnTokenCalled(counters, token, counter) {
  if (!token) return counters || [];

  if (!counters || counters.length === 0) {
    const defaultLabel = counter?.displayLabel || token?.counterId?.displayLabel || counter?.name || 'COUNTER 01';
    return [
      {
        _id: counter?._id || token?.counterId?._id || 'counter-1',
        number: counter?.number || token?.counterId?.number || 1,
        name: counter?.name || 'Counter 01',
        displayLabel: defaultLabel,
        status: 'ACTIVE',
        service: token?.serviceId
          ? { name: token.serviceId.name, tokenPrefix: token.serviceId.tokenPrefix }
          : null,
        servingToken: {
          _id: token?._id || token?.id,
          tokenCode: token?.tokenCode,
          tokenNumber: token?.tokenNumber,
          status: token?.status || 'CALLED',
          calledAt: token?.calledAt || new Date().toISOString(),
        },
      },
    ];
  }

  return counters.map((c) => {
    if (isCounterMatch(c, counter, token)) {
      const updatedDisplayLabel =
        counter?.displayLabel ||
        token?.counterId?.displayLabel ||
        counter?.name ||
        c.displayLabel;

      return {
        ...c,
        displayLabel: updatedDisplayLabel,
        status: 'ACTIVE',
        service: token?.serviceId?.name
          ? { name: token.serviceId.name, tokenPrefix: token.serviceId.tokenPrefix }
          : c.service,
        servingToken: {
          _id: token?._id || token?.id,
          tokenCode: token?.tokenCode,
          tokenNumber: token?.tokenNumber,
          status: token?.status || 'CALLED',
          calledAt: token?.calledAt || new Date().toISOString(),
        },
      };
    }
    // Crucial: ALL OTHER COUNTERS ARE PRESERVED
    return c;
  });
}

export function updateCounterOnTokenServing(counters, token, counter) {
  if (!counters) return [];
  return counters.map((c) => {
    const isThisCounter =
      isCounterMatch(c, counter, token) ||
      (c.servingToken &&
        (c.servingToken.tokenCode === token?.tokenCode ||
          (token?._id && String(c.servingToken._id) === String(token._id))));

    if (isThisCounter) {
      return {
        ...c,
        servingToken: c.servingToken
          ? {
              ...c.servingToken,
              status: 'SERVING',
              servingAt: token?.servingAt || new Date().toISOString(),
            }
          : {
              _id: token?._id || token?.id,
              tokenCode: token?.tokenCode,
              status: 'SERVING',
              servingAt: token?.servingAt || new Date().toISOString(),
            },
      };
    }
    return c;
  });
}

export function clearCounterToken(counters, token, counter) {
  if (!counters) return [];
  const eventTokenCode = token?.tokenCode || (typeof token === 'string' ? token : null);
  const eventTokenId = token?._id || token?.id;

  return counters.map((c) => {
    const isThisCounter =
      isCounterMatch(c, counter, token) ||
      (c.servingToken &&
        ((eventTokenCode && c.servingToken.tokenCode === eventTokenCode) ||
          (eventTokenId && String(c.servingToken._id) === String(eventTokenId))));

    if (isThisCounter) {
      return {
        ...c,
        servingToken: null,
      };
    }
    // Crucial: ALL OTHER COUNTERS ARE PRESERVED
    return c;
  });
}

export function updateCounterMetadata(counters, counterData) {
  if (!counters || !counterData) return counters || [];
  return counters.map((c) => {
    if (isCounterMatch(c, counterData, null)) {
      return {
        ...c,
        ...counterData,
        displayLabel: counterData.displayLabel || counterData.name || c.displayLabel,
        service: counterData.serviceId
          ? { name: counterData.serviceId.name, tokenPrefix: counterData.serviceId.tokenPrefix }
          : c.service,
        servingToken:
          counterData.currentTokenId &&
          ['CALLED', 'SERVING'].includes(counterData.currentTokenId.status)
            ? {
                _id: counterData.currentTokenId._id,
                tokenCode: counterData.currentTokenId.tokenCode,
                status: counterData.currentTokenId.status,
                calledAt: counterData.currentTokenId.calledAt,
              }
            : counterData.currentTokenId === null
            ? null
            : c.servingToken,
      };
    }
    return c;
  });
}
