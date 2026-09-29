import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useSocket } from '../context/SocketContext';
import { useAuth } from '../context/AuthContext';
import { serviceCenterAPI, counterAPI, analyticsAPI, serviceAPI, workloadAPI } from '../services/api';
import LoadingSpinner from '../components/common/LoadingSpinner';
import ErrorMessage from '../components/common/ErrorMessage';
import {
  Building2,
  Cpu,
  Layers,
  Users,
  Clock,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  RefreshCw,
  Download,
  Shuffle,
  Coffee,
  Play,
  Filter,
  BarChart2,
  Calendar,
  ChevronRight,
  ShieldCheck,
  Zap,
  TrendingUp,
  Activity,
  UserCheck,
  UserX,
  UserPlus,
} from 'lucide-react';

/**
 * Human-readable provenance of a backend EWT number.
 * These labels are pure display helpers — they read the backend's own
 * `serviceAverageSource` / `fallbackReason` strings and add no new arithmetic.
 */
const EWT_SOURCE_LABELS = {
  RECENT_HOUR: 'real completions in this clock hour',
  RECENT_WINDOW: 'real completions in the recent window',
  DAILY_WINDOW: 'real completions in the daily window',
  QUEUE_RUNNING_AVERAGE: "this queue's running average",
  SERVICE_CONFIG: 'configured service time (no history yet)',
  SERVICE_CONFIG_FALLBACK: 'default service time (no configuration)',
};

const EWT_FALLBACK_LABELS = {
  NO_ACTIVE_COUNTERS: 'no active counter',
  NO_AVAILABLE_CAPACITY: 'no available capacity',
  NON_FINITE_GUARD: 'capacity guard',
  INVALID_IDENTIFIERS: 'invalid identifiers',
};

function ewtBadge(entry) {
  const ctx = entry?.context || {};
  if (ctx.fallbackUsed) return 'DEGRADED CAPACITY';
  return ctx.estimationMethod === 'TIER1_FALLBACK'
    ? 'BASELINE FORMULA'
    : 'CONTEXT-AWARE';
}

function describeEwtSource(entry) {
  const ctx = entry?.context || {};
  const parts = [
    `Queue depth: ${ctx.queueDepth ?? '—'}`,
    `Active counters: ${ctx.activeCounters ?? '—'} (busy ${ctx.busyCounters ?? 0}, idle ${ctx.idleCounters ?? 0})`,
    `Free capacity: ${ctx.freeCapacity ?? '—'} service slots`,
    `Effective service time: ${ctx.effectiveServiceSeconds ?? '—'}s`,
  ];
  const source = ctx.serviceAverageSource;
  if (source) {
    parts.push(`Service time source: ${EWT_SOURCE_LABELS[source] || source}`);
  }
  if (ctx.fallbackUsed && ctx.fallbackReason) {
    parts.push(`Degraded: ${EWT_FALLBACK_LABELS[ctx.fallbackReason] || ctx.fallbackReason}`);
  }
  if (ctx.contextWindow) {
    parts.push(
      `Windows: recent ${ctx.contextWindow.recentWindowMinutes}m, daily ${ctx.contextWindow.dailyWindowDays}d, min samples ${ctx.contextWindow.minSamples}`
    );
  }
  return parts.join('\n');
}

export default function ResourceHub() {
  const { socket, isConnected, activeCenterId, setActiveCenterId } = useSocket();
  const { user } = useAuth();
  const isAdmin = user?.role === 'ADMIN';

  // Centers list
  const [centers, setCenters] = useState([]);
  const [selectedCenterId, setSelectedCenterId] = useState(activeCenterId || '');

  // Active view tab: 'overview' | 'historical'
  const [activeTab, setActiveTab] = useState('overview');

  // Live operational overview state
  const [overview, setOverview] = useState(null);
  const [overviewLoading, setOverviewLoading] = useState(false);
  const [overviewError, setOverviewError] = useState(null);

  // Centralized Resource Allocation — authoritative snapshot served by the
  // backend allocator. Nothing here is derived client-side; a value the
  // backend did not supply is rendered as "Unavailable", never invented.
  const [allocation, setAllocation] = useState(null);
  const [allocationLoading, setAllocationLoading] = useState(false);
  const [allocationError, setAllocationError] = useState(null);
  const [allocationRunState, setAllocationRunState] = useState(null);

  // Tier 3 / Feature 1: context-aware EWT explainability (backend-computed only)
  const [ewtData, setEwtData] = useState(null);
  const [ewtError, setEwtError] = useState(null);

  // Tier 3 / Feature 2: ML Footfall & Staffing Predictor
  const [forecastData, setForecastData] = useState(null);
  const [forecastLoading, setForecastLoading] = useState(false);
  const [forecastError, setForecastError] = useState(null);
  const [forecastHorizon, setForecastHorizon] = useState(6);

  // Tier 4 / Feature 5: Operational Workload Balancer
  const [workloadOverview, setWorkloadOverview] = useState(null);
  const [workloadRecommendations, setWorkloadRecommendations] = useState(null);
  const [workloadLoading, setWorkloadLoading] = useState(false);
  const [workloadError, setWorkloadError] = useState(null);

  // Counter morphing modal state
  const [morphModalOpen, setMorphModalOpen] = useState(false);
  const [selectedCounterForMorph, setSelectedCounterForMorph] = useState(null);
  const [targetServiceId, setTargetServiceId] = useState('');
  const [morphReason, setMorphReason] = useState('');
  const [morphLoading, setMorphLoading] = useState(false);
  const [morphError, setMorphError] = useState(null);
  const [morphSuccess, setMorphSuccess] = useState(null);

  // Historical & SLA state
  const [timeRange, setTimeRange] = useState('today');
  const [targetWaitMinutes, setTargetWaitMinutes] = useState('15');
  const [historicalData, setHistoricalData] = useState(null);
  const [historicalLoading, setHistoricalLoading] = useState(false);
  const [historicalError, setHistoricalError] = useState(null);
  const [historicalPage, setHistoricalPage] = useState(1);
  const [filterServiceId, setFilterServiceId] = useState('');

  // Real Center Operators
  const [operators, setOperators] = useState([]);
  const [operatorsLoading, setOperatorsLoading] = useState(false);
  const [operatorsError, setOperatorsError] = useState(null);

  // Operator assignment modal state
  const [assignModalOpen, setAssignModalOpen] = useState(false);
  const [selectedCounterForAssign, setSelectedCounterForAssign] = useState(null);
  const [selectedStaffId, setSelectedStaffId] = useState('');
  const [assignLoading, setAssignLoading] = useState(false);
  const [assignError, setAssignError] = useState(null);
  const [assignSuccess, setAssignSuccess] = useState(null);
  const [quickActionLoading, setQuickActionLoading] = useState({});

  // 1. Fetch available centers on mount (only active/open operational centers)
  useEffect(() => {
    let mounted = true;
    serviceCenterAPI
      .list({ isOpen: true })
      .then((res) => {
        if (!mounted) return;
        const list = res.data?.data?.centers || [];
        setCenters(list);
        if (list.length > 0 && !selectedCenterId) {
          const defaultId = activeCenterId || list[0]._id;
          setSelectedCenterId(defaultId);
          setActiveCenterId(defaultId);
        }
      })
      .catch((err) => {
        console.error('Failed to load centers for Resource Hub:', err);
      });
    return () => {
      mounted = false;
    };
  }, [activeCenterId, setActiveCenterId, selectedCenterId]);

  // 1b. Fetch Center Operators
  const fetchOperators = useCallback(async () => {
    if (!selectedCenterId) return;
    setOperatorsLoading(true);
    setOperatorsError(null);
    try {
      const res = await counterAPI.getOperators(selectedCenterId);
      setOperators(res.data?.data?.operators || []);
    } catch (err) {
      setOperators([]);
      setOperatorsError(err.response?.data?.message || 'Failed to load operators');
    } finally {
      setOperatorsLoading(false);
    }
  }, [selectedCenterId]);

  // 2. Fetch Operational Overview
  const fetchOverview = useCallback(async () => {
    if (!selectedCenterId) return;
    setOverviewLoading(true);
    setOverviewError(null);
    try {
      const res = await analyticsAPI.getOperationalOverview(selectedCenterId);
      setOverview(res.data?.data || null);
    } catch (err) {
      setOverviewError(err.response?.data?.message || 'Failed to load operational overview');
    } finally {
      setOverviewLoading(false);
    }
  }, [selectedCenterId]);

  // 2a. Fetch the centralized resource-allocation snapshot.
  // This is a pure read of backend state: which counters exist, what each one
  // is doing, which token it currently holds, and whether the allocator is on.
  const fetchAllocation = useCallback(async () => {
    if (!selectedCenterId) return;
    setAllocationError(null);
    try {
      const res = await counterAPI.getAllocationOverview(selectedCenterId);
      setAllocation(res.data?.data || null);
    } catch (err) {
      setAllocation(null);
      setAllocationError(err.response?.data?.message || 'Failed to load resource allocation state');
    }
  }, [selectedCenterId]);

  // 2b. Fetch Context-Aware EWT explainability.
  // The backend is the SOLE authority for the wait estimate: this panel only
  // renders the numbers and their provenance. It never derives a wait time here.
  const fetchEwt = useCallback(async () => {
    if (!selectedCenterId) return;
    setEwtError(null);
    try {
      const res = await analyticsAPI.getEwtIntelligence(selectedCenterId);
      setEwtData(res.data?.data || null);
    } catch (err) {
      setEwtData(null);
      setEwtError(err.response?.data?.message || 'Failed to load wait-time intelligence');
    }
  }, [selectedCenterId]);

  // 3. Fetch Historical Report
  const fetchHistorical = useCallback(async () => {
    if (!selectedCenterId) return;
    setHistoricalLoading(true);
    setHistoricalError(null);
    try {
      const params = {
        timeRange,
        page: historicalPage,
        limit: 15,
      };
      if (targetWaitMinutes) params.targetWaitMinutes = targetWaitMinutes;
      if (filterServiceId) params.serviceId = filterServiceId;

      const res = await analyticsAPI.getHistoricalReport(selectedCenterId, params);
      setHistoricalData(res.data?.data || null);
    } catch (err) {
      setHistoricalError(err.response?.data?.message || 'Failed to load historical report');
    } finally {
      setHistoricalLoading(false);
    }
  }, [selectedCenterId, timeRange, targetWaitMinutes, historicalPage, filterServiceId]);

  // 3b. Fetch Demand & Staffing Forecast (Tier 3 / Feature 2 ML Predictor)
  const fetchForecast = useCallback(async (refresh = false) => {
    if (!selectedCenterId) return;
    setForecastLoading(true);
    setForecastError(null);
    try {
      const res = await analyticsAPI.getForecast(selectedCenterId, {
        horizonHours: forecastHorizon,
        refresh,
      });
      setForecastData(res.data?.data || null);
    } catch (err) {
      setForecastData(null);
      setForecastError(err.response?.data?.message || 'Failed to load demand and staffing forecast');
    } finally {
      setForecastLoading(false);
    }
  }, [selectedCenterId, forecastHorizon]);

  // 3c. Fetch Operational Workload & Balancing Recommendations (Tier 4 / Feature 5)
  const fetchWorkload = useCallback(async () => {
    if (!selectedCenterId) return;
    setWorkloadLoading(true);
    setWorkloadError(null);
    try {
      const [ovRes, recRes] = await Promise.all([
        workloadAPI.getCenterWorkload(selectedCenterId),
        workloadAPI.getRecommendations(selectedCenterId),
      ]);
      setWorkloadOverview(ovRes.data?.data || ovRes.data || null);
      setWorkloadRecommendations(recRes.data?.data || recRes.data || null);
    } catch (err) {
      setWorkloadError(err.message || 'Failed to load operational workload');
    } finally {
      setWorkloadLoading(false);
    }
  }, [selectedCenterId]);

  useEffect(() => {
    if (selectedCenterId) {
      if (activeTab === 'overview') {
        fetchOverview();
        fetchAllocation();
        fetchOperators();
      } else if (activeTab === 'historical') {
        fetchHistorical();
      } else if (activeTab === 'forecast') {
        fetchForecast();
      } else if (activeTab === 'workload') {
        fetchWorkload();
      }
    }
  }, [
    selectedCenterId,
    activeTab,
    fetchOverview,
    fetchAllocation,
    fetchOperators,
    fetchHistorical,
    fetchForecast,
    fetchWorkload,
  ]);

  // Operator assignment handlers
  const openAssignModal = (counter, preselectedStaffId = '') => {
    setSelectedCounterForAssign(counter);
    setSelectedStaffId(
      preselectedStaffId ||
      counter.staff?._id ||
      counter.staffId?._id ||
      counter.staffId ||
      ''
    );
    setAssignError(null);
    setAssignSuccess(null);
    setAssignModalOpen(true);
  };

  const handleAssignSubmit = async (e) => {
    e.preventDefault();
    if (!selectedCounterForAssign) return;
    setAssignLoading(true);
    setAssignError(null);
    setAssignSuccess(null);
    try {
      const res = await counterAPI.assignStaff(
        selectedCounterForAssign._id,
        selectedStaffId || null
      );
      setAssignSuccess(res.data?.message || 'Staff assignment updated successfully');
      fetchOverview();
      fetchAllocation();
      fetchOperators();
      setTimeout(() => {
        setAssignModalOpen(false);
      }, 1000);
    } catch (err) {
      setAssignError(err.response?.data?.message || 'Failed to assign operator');
    } finally {
      setAssignLoading(false);
    }
  };

  const handleQuickUnassign = async (counterId) => {
    if (!counterId) return;
    setQuickActionLoading((prev) => ({ ...prev, [counterId]: 'unassign' }));
    try {
      await counterAPI.assignStaff(counterId, null);
      await Promise.all([fetchOverview(), fetchAllocation(), fetchOperators()]);
    } catch (err) {
      alert(err.response?.data?.message || 'Failed to unassign operator');
    } finally {
      setQuickActionLoading((prev) => ({ ...prev, [counterId]: null }));
    }
  };

  const handleQuickStatusChange = async (counterId, newStatus) => {
    if (!counterId || !newStatus) return;
    setQuickActionLoading((prev) => ({ ...prev, [counterId]: newStatus }));
    try {
      await counterAPI.updateStatus(counterId, newStatus);
      await Promise.all([fetchOverview(), fetchAllocation(), fetchOperators()]);
    } catch (err) {
      alert(err.response?.data?.message || 'Failed to update desk status');
    } finally {
      setQuickActionLoading((prev) => ({ ...prev, [counterId]: null }));
    }
  };

  // 3a. Manual allocation run. The operator only asks the backend to run its
  // allocator now; every decision (who, which counter) stays server-side.
  const handleRunAllocation = async () => {
    if (!selectedCenterId) return;
    setAllocationRunState({ loading: true, message: null, error: null });
    try {
      const res = await counterAPI.runAllocation(selectedCenterId);
      const data = res.data?.data;
      setAllocationRunState({
        loading: false,
        message:
          data?.message ||
          `Allocation pass complete — ${data?.allocatedCount ?? 0} token(s) assigned.`,
        error: null,
      });
      await Promise.all([fetchAllocation(), fetchOperators()]);
    } catch (err) {
      setAllocationRunState({
        loading: false,
        message: null,
        error: err.response?.data?.message || 'Failed to run resource allocation',
      });
    }
  };

  // EWT explainability is admin-only; a 403/401 simply hides the panel.
  useEffect(() => {
    if (selectedCenterId && isAdmin) {
      fetchEwt();
    } else {
      setEwtData(null);
    }
  }, [selectedCenterId, isAdmin, fetchEwt]);

  // Tab focus / visibility auto-refresh
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible' && selectedCenterId) {
        fetchOverview();
        fetchAllocation();
        fetchOperators();
        if (isAdmin) fetchEwt();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('focus', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('focus', handleVisibilityChange);
    };
  }, [selectedCenterId, fetchOverview, fetchAllocation, fetchOperators, fetchEwt, isAdmin]);

  // 4. Real-time Socket.IO Listeners
  useEffect(() => {
    if (!socket || !selectedCenterId) return;

    const handleCounterEvent = () => {
      fetchOverview();
      fetchAllocation();
      fetchOperators();
      if (isAdmin) fetchEwt();
    };

    const handleQueueEvent = () => {
      fetchOverview();
      fetchAllocation();
      if (isAdmin) fetchEwt();
    };

    const handleWorkloadEvent = () => {
      fetchWorkload();
      fetchOperators();
    };

    // The allocator pushes its own authoritative snapshot on every decision it
    // makes. Consume that payload directly so the board is never a re-derived
    // guess; fall back to a fetch only if the event carries no body.
    const handleAllocationEvent = (payload) => {
      if (payload && Array.isArray(payload.counters) && payload.metrics) {
        setAllocation(payload);
        setAllocationError(null);
      } else {
        fetchAllocation();
      }
      fetchOperators();
    };

    const handleConnect = () => {
      fetchOverview();
      fetchAllocation();
      fetchOperators();
      if (isAdmin) fetchEwt();
    };

    socket.on('connect', handleConnect);
    socket.on('counter.updated', handleCounterEvent);
    socket.on('counter.morphed', handleCounterEvent);
    socket.on('queue.updated', handleQueueEvent);
    socket.on('token.called', handleQueueEvent);
    socket.on('token.serving', handleQueueEvent);
    socket.on('token.completed', handleQueueEvent);
    socket.on('token.skipped', handleQueueEvent);
    socket.on('workload.updated', handleWorkloadEvent);
    socket.on('resource.allocation.updated', handleAllocationEvent);

    return () => {
      socket.off('connect', handleConnect);
      socket.off('counter.updated', handleCounterEvent);
      socket.off('counter.morphed', handleCounterEvent);
      socket.off('queue.updated', handleQueueEvent);
      socket.off('token.called', handleQueueEvent);
      socket.off('token.serving', handleQueueEvent);
      socket.off('token.completed', handleQueueEvent);
      socket.off('token.skipped', handleQueueEvent);
      socket.off('workload.updated', handleWorkloadEvent);
      socket.off('resource.allocation.updated', handleAllocationEvent);
    };
  }, [
    socket,
    selectedCenterId,
    fetchOverview,
    fetchEwt,
    fetchWorkload,
    fetchAllocation,
    fetchOperators,
    isAdmin,
  ]);

  // Handle Center Selection
  const handleCenterChange = (e) => {
    const newId = e.target.value;
    setSelectedCenterId(newId);
    setActiveCenterId(newId);
  };

  // Open Morph Modal
  const openMorphModal = (counter) => {
    setSelectedCounterForMorph(counter);
    setTargetServiceId(counter.service?._id || '');
    setMorphReason('');
    setMorphError(null);
    setMorphSuccess(null);
    setMorphModalOpen(true);
  };

  // Submit Morphing Action
  const handleMorphSubmit = async (e) => {
    e.preventDefault();
    if (!selectedCounterForMorph) return;

    setMorphLoading(true);
    setMorphError(null);
    setMorphSuccess(null);

    try {
      const res = await counterAPI.morph(
        selectedCounterForMorph._id,
        targetServiceId || null,
        morphReason || 'Supervisor reassignment via Resource Hub'
      );
      setMorphSuccess(res.data?.message || 'Counter morphed successfully');
      fetchOverview();
      setTimeout(() => {
        setMorphModalOpen(false);
      }, 1200);
    } catch (err) {
      setMorphError(err.response?.data?.message || 'Failed to morph counter');
    } finally {
      setMorphLoading(false);
    }
  };

  // Trigger CSV Export
  const handleExportCsv = () => {
    if (!selectedCenterId) return;
    const url = analyticsAPI.getExportUrl(selectedCenterId, {
      timeRange,
      serviceId: filterServiceId || undefined,
    });
    window.open(url, '_blank');
  };

  const centerInfo = overview?.center;
  const metrics = overview?.metrics || {};
  const counters = overview?.counters || [];
  const services = overview?.services || [];
  const recentEvents = overview?.recentEvents || [];

  // ── Centralized Resource Allocation (backend-authoritative) ──────────
  const allocMetrics = allocation?.metrics || null;
  const allocCounters = allocation?.counters || [];
  const allocQueues = allocation?.queues || [];
  const allocWaiting = allocation?.waitingQueue || [];
  const allocEnabled = allocation?.autoResourceAllocation === true;

  // Truthful rendering rule: a number the backend did not provide shows as
  // "Unavailable" rather than being defaulted to 0 or an estimate.
  const showValue = (v, suffix = '') => {
    if (v === null || v === undefined || v === '' || v === 'Unavailable') return 'Unavailable';
    return `${v}${suffix}`;
  };

  const allocationStateTone = (state) => {
    switch (state) {
      case 'READY':
        return { bg: 'color-mix(in srgb, var(--color-cyan) 14%, transparent)', fg: 'var(--color-cyan)', bd: 'color-mix(in srgb, var(--color-cyan) 34%, transparent)' };
      case 'BUSY':
        return { bg: 'color-mix(in srgb, var(--color-primary) 14%, transparent)', fg: 'var(--color-primary)', bd: 'color-mix(in srgb, var(--color-primary) 34%, transparent)' };
      case 'BREAK':
        return { bg: 'color-mix(in srgb, var(--color-warning) 14%, transparent)', fg: 'var(--color-warning)', bd: 'color-mix(in srgb, var(--color-warning) 34%, transparent)' };
      case 'CLOSED':
        return { bg: 'color-mix(in srgb, var(--color-danger) 14%, transparent)', fg: 'var(--color-danger)', bd: 'color-mix(in srgb, var(--color-danger) 34%, transparent)' };
      default:
        return { bg: 'var(--bg-card-alt)', fg: 'var(--text-muted)', bd: 'var(--border-subtle)' };
    }
  };

  // Tier 3 / Feature 1 — backend-computed EWT, keyed by serviceId.
  const ewtServicesById = (ewtData?.services || []).reduce((acc, s) => {
    acc[String(s.serviceId)] = s;
    return acc;
  }, {});

  return (
    <div style={{ padding: '24px 28px', maxWidth: '1600px', margin: '0 auto' }}>
      {/* ── Top Header Controls ────────────────────────── */}
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '16px',
          marginBottom: '24px',
        }}
      >
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <h1 style={{ fontSize: '22px', fontWeight: 800, color: 'var(--text-primary)', letterSpacing: '-0.02em' }}>
              Centralized Resource Hub
            </h1>
            <span
              className="mono"
              style={{
                fontSize: '10px',
                fontWeight: 700,
                padding: '2px 8px',
                borderRadius: '6px',
                background: 'color-mix(in srgb, var(--color-primary) 12%, transparent)',
                color: 'var(--color-primary)',
                border: '1px solid color-mix(in srgb, var(--color-primary) 30%, transparent)',
              }}
            >
              TIER 2 OPERATIONS
            </span>
          </div>
          <p style={{ fontSize: '13px', color: 'var(--text-secondary)', marginTop: '3px' }}>
            Multi-counter telemetry, dynamic counter morphing, and authoritative SLA audit reporting
          </p>
        </div>

        {/* Center Selector & Tab Switcher */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Building2 size={16} color="var(--text-muted)" />
            <select
              value={selectedCenterId}
              onChange={handleCenterChange}
              style={{
                background: 'var(--bg-card-alt)',
                border: '1px solid var(--border-subtle)',
                color: 'var(--text-primary)',
                borderRadius: '10px',
                padding: '8px 14px',
                fontSize: '13px',
                fontWeight: 600,
                outline: 'none',
                cursor: 'pointer',
              }}
            >
              {centers.map((c) => (
                <option key={c._id} value={c._id}>
                  {c.name} ({c.code})
                </option>
              ))}
            </select>
          </div>

          {/* View Tab Toggle */}
          <div
            style={{
              display: 'flex',
              background: 'rgba(15, 23, 42, 0.6)',
              borderRadius: '10px',
              padding: '3px',
              border: '1px solid var(--border-subtle)',
            }}
          >
            <button
              onClick={() => setActiveTab('overview')}
              style={{
                background: activeTab === 'overview' ? 'color-mix(in srgb, var(--color-primary) 15%, transparent)' : 'transparent',
                color: activeTab === 'overview' ? 'var(--color-primary)' : 'var(--text-secondary)',
                border: activeTab === 'overview' ? '1px solid color-mix(in srgb, var(--color-primary) 30%, transparent)' : '1px solid transparent',
                borderRadius: '8px',
                padding: '6px 14px',
                fontSize: '12px',
                fontWeight: 700,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
              }}
            >
              <Cpu size={14} />
              <span>Live Center Overview</span>
            </button>
            <button
              onClick={() => setActiveTab('historical')}
              style={{
                background: activeTab === 'historical' ? 'color-mix(in srgb, var(--color-primary) 15%, transparent)' : 'transparent',
                color: activeTab === 'historical' ? 'var(--color-primary)' : 'var(--text-secondary)',
                border: activeTab === 'historical' ? '1px solid color-mix(in srgb, var(--color-primary) 30%, transparent)' : '1px solid transparent',
                borderRadius: '8px',
                padding: '6px 14px',
                fontSize: '12px',
                fontWeight: 700,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
              }}
            >
              <BarChart2 size={14} />
              <span>Historical & SLA Reporting</span>
            </button>
            <button
              onClick={() => setActiveTab('forecast')}
              style={{
                background: activeTab === 'forecast' ? 'color-mix(in srgb, var(--color-primary) 15%, transparent)' : 'transparent',
                color: activeTab === 'forecast' ? 'var(--color-primary)' : 'var(--text-secondary)',
                border: activeTab === 'forecast' ? '1px solid color-mix(in srgb, var(--color-primary) 30%, transparent)' : '1px solid transparent',
                borderRadius: '8px',
                padding: '6px 14px',
                fontSize: '12px',
                fontWeight: 700,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
              }}
            >
              <TrendingUp size={14} />
              <span>Forecast & Staffing ML</span>
            </button>
            <button
              onClick={() => setActiveTab('workload')}
              style={{
                background: activeTab === 'workload' ? 'color-mix(in srgb, var(--color-primary) 15%, transparent)' : 'transparent',
                color: activeTab === 'workload' ? 'var(--color-primary)' : 'var(--text-secondary)',
                border: activeTab === 'workload' ? '1px solid color-mix(in srgb, var(--color-primary) 30%, transparent)' : '1px solid transparent',
                borderRadius: '8px',
                padding: '6px 14px',
                fontSize: '12px',
                fontWeight: 700,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
              }}
            >
              <Activity size={14} />
              <span>Workload & Balancing</span>
            </button>
          </div>

          <button
            onClick={activeTab === 'overview' ? fetchOverview : activeTab === 'historical' ? fetchHistorical : activeTab === 'forecast' ? () => fetchForecast(true) : fetchWorkload}
            disabled={overviewLoading || historicalLoading || forecastLoading || workloadLoading}
            className="btn-secondary"
            style={{ fontSize: '12px', padding: '8px 14px', gap: '6px' }}
          >
            <RefreshCw size={13} className={overviewLoading || historicalLoading || forecastLoading || workloadLoading ? 'animate-spin' : ''} />
            <span>Sync</span>
          </button>
        </div>
      </div>

      {/* ── Center Status Ribbon ────────────────────────── */}
      {centerInfo && (
        <div
          style={{
            background: 'var(--bg-card-alt)',
            border: '1px solid var(--border-subtle)',
            borderRadius: '16px',
            padding: '14px 20px',
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '16px',
            marginBottom: '24px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
            <div
              style={{
                width: '42px',
                height: '42px',
                borderRadius: '12px',
                background: 'color-mix(in srgb, var(--color-primary) 12%, transparent)',
                border: '1px solid color-mix(in srgb, var(--color-primary) 25%, transparent)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'var(--color-primary)',
              }}
            >
              <Building2 size={22} />
            </div>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{ fontSize: '16px', fontWeight: 800, color: 'var(--text-primary)' }}>
                  {centerInfo.name}
                </span>
                <span
                  className="mono"
                  style={{
                    fontSize: '11px',
                    fontWeight: 700,
                    padding: '2px 8px',
                    borderRadius: '6px',
                    background: centerInfo.isOpen ? 'color-mix(in srgb, var(--color-primary) 15%, transparent)' : 'color-mix(in srgb, var(--color-danger) 15%, transparent)',
                    color: centerInfo.isOpen ? 'var(--color-primary)' : 'var(--color-danger)',
                    border: `1px solid ${centerInfo.isOpen ? 'color-mix(in srgb, var(--color-primary) 30%, transparent)' : 'color-mix(in srgb, var(--color-danger) 30%, transparent)'}`,
                  }}
                >
                  {centerInfo.isOpen ? 'OPEN' : 'CLOSED'}
                </span>
              </div>
              <p className="mono" style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>
                CODE: {centerInfo.code} • FACILITY TYPE: {centerInfo.type} • CAPACITY: {centerInfo.capacity}
              </p>
            </div>
          </div>

          {/* Crowd & Telemetry Status */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '20px' }}>
            <div>
              <span style={{ fontSize: '11px', color: 'var(--text-muted)', display: 'block' }}>Live Crowd</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '2px' }}>
                <span style={{ fontSize: '15px', fontWeight: 800, color: 'var(--text-primary)' }}>
                  {typeof centerInfo.currentCrowd === 'number'
                    ? `${centerInfo.currentCrowd} / ${centerInfo.capacity ?? '—'}`
                    : 'Unavailable'}
                </span>
                <span
                  className="mono"
                  style={{
                    fontSize: '10px',
                    fontWeight: 700,
                    padding: '2px 6px',
                    borderRadius: '4px',
                    background:
                      centerInfo.crowdStatus === 'HIGH'
                        ? 'color-mix(in srgb, var(--color-danger) 20%, transparent)'
                        : centerInfo.crowdStatus === 'MODERATE'
                        ? 'color-mix(in srgb, var(--color-warning) 20%, transparent)'
                        : 'color-mix(in srgb, var(--color-primary) 20%, transparent)',
                    color:
                      centerInfo.crowdStatus === 'HIGH'
                        ? 'var(--color-danger)'
                        : centerInfo.crowdStatus === 'MODERATE'
                        ? 'var(--color-warning)'
                        : 'var(--color-primary)',
                  }}
                >
                  {centerInfo.crowdStatus ?? 'UNKNOWN'}
                  {typeof centerInfo.crowdPercent === 'number' ? ` (${centerInfo.crowdPercent}%)` : ''}
                </span>
              </div>
            </div>

            <div style={{ borderLeft: '1px solid var(--border-subtle)', paddingLeft: '20px' }}>
              <span style={{ fontSize: '11px', color: 'var(--text-muted)', display: 'block' }}>Telemetry Mesh</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '4px' }}>
                <span
                  style={{
                    width: '8px',
                    height: '8px',
                    borderRadius: '50%',
                    background: isConnected ? 'var(--color-primary)' : 'var(--color-warning)',
                  }}
                />
                <span className="mono" style={{ fontSize: '12px', fontWeight: 700, color: isConnected ? 'var(--color-primary)' : 'var(--color-warning)' }}>
                  {isConnected ? 'LIVE SYNC' : 'RECONNECTING'}
                </span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── TAB 1: LIVE CENTER OVERVIEW ────────────────────────── */}
      {activeTab === 'overview' && (
        <>
          {overviewError && <ErrorMessage message={overviewError} onRetry={fetchOverview} />}
          {overviewLoading && !overview ? (
            <LoadingSpinner message="Aggregating live counter mesh..." />
          ) : (
            <>
              {/* Stat Metric Pills */}
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
                  gap: '14px',
                  marginBottom: '24px',
                }}
              >
                <div className="stat-pill" style={{ padding: '16px 20px', alignItems: 'flex-start' }}>
                  <span className="stat-pill-label">Total Counters</span>
                  <span className="stat-pill-val" style={{ color: 'var(--text-primary)', marginTop: '4px' }}>
                    {metrics.totalCounters || 0}
                  </span>
                  <span style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>
                    {metrics.activeCounters || 0} Active • {metrics.closedCounters || 0} Closed
                  </span>
                </div>

                <div className="stat-pill" style={{ padding: '16px 20px', alignItems: 'flex-start' }}>
                  <span className="stat-pill-label">Active / Serving</span>
                  <span className="stat-pill-val" style={{ color: 'var(--color-primary)', marginTop: '4px' }}>
                    {metrics.servingCounters || 0}
                  </span>
                  <span style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>
                    {metrics.calledCounters || 0} Called tokens
                  </span>
                </div>

                <div className="stat-pill" style={{ padding: '16px 20px', alignItems: 'flex-start' }}>
                  <span className="stat-pill-label">Idle Counters</span>
                  <span className="stat-pill-val" style={{ color: 'var(--color-cyan)', marginTop: '4px' }}>
                    {metrics.idleCounters || 0}
                  </span>
                  <span style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>
                    Ready for next customer
                  </span>
                </div>

                <div className="stat-pill" style={{ padding: '16px 20px', alignItems: 'flex-start' }}>
                  <span className="stat-pill-label">On Break</span>
                  <span className="stat-pill-val" style={{ color: 'var(--color-warning)', marginTop: '4px' }}>
                    {metrics.breakCounters || 0}
                  </span>
                  <span style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>
                    Temporary teller pause
                  </span>
                </div>

                <div className="stat-pill" style={{ padding: '16px 20px', alignItems: 'flex-start' }}>
                  <span className="stat-pill-label">Waiting Queue</span>
                  <span className="stat-pill-val" style={{ color: 'var(--color-danger)', marginTop: '4px' }}>
                    {metrics.totalWaiting || 0}
                  </span>
                  <span style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>
                    Avg wait ~{metrics.avgWaitMinutes || 0} min
                  </span>
                </div>
              </div>

              {/* ══ CENTRALIZED RESOURCE ALLOCATION ══════════════════════
                  One queue, many counters, one backend allocator. Every value
                  below is read straight from the allocator's own snapshot —
                  the browser never picks a counter and never estimates a
                  number. Missing data renders as "Unavailable". */}
              <div
                style={{
                  background: 'rgba(15, 23, 42, 0.65)',
                  border: '1px solid color-mix(in srgb, var(--color-primary) 20%, transparent)',
                  borderRadius: '16px',
                  padding: '20px 24px',
                  marginBottom: '32px',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    flexWrap: 'wrap',
                    gap: '12px',
                    marginBottom: '6px',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <ShieldCheck size={18} color="var(--color-primary)" />
                    <h2 style={{ fontSize: '15px', fontWeight: 800, color: 'var(--text-primary)', margin: 0 }}>
                      Centralized Resource Allocation
                    </h2>
                    <span
                      className="mono"
                      style={{
                        fontSize: '10px',
                        fontWeight: 700,
                        padding: '2px 8px',
                        borderRadius: '6px',
                        background: allocEnabled
                          ? 'color-mix(in srgb, var(--color-cyan) 14%, transparent)'
                          : 'var(--bg-card-alt)',
                        color: allocEnabled ? 'var(--color-cyan)' : 'var(--text-muted)',
                        border: `1px solid ${allocEnabled ? 'color-mix(in srgb, var(--color-cyan) 34%, transparent)' : 'var(--border-subtle)'}`,
                      }}
                    >
                      {allocation ? (allocEnabled ? 'AUTO ALLOCATION ON' : 'AUTO ALLOCATION OFF') : 'STATUS UNAVAILABLE'}
                    </span>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <button
                      onClick={fetchAllocation}
                      className="btn-secondary"
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '6px',
                        fontSize: '12px',
                        fontWeight: 700,
                        padding: '7px 12px',
                        borderRadius: '8px',
                        border: '1px solid var(--border-subtle)',
                        background: 'var(--bg-card-alt)',
                        color: 'var(--text-primary)',
                        cursor: 'pointer',
                      }}
                    >
                      <RefreshCw size={13} /> Refresh
                    </button>
                    <button
                      onClick={handleRunAllocation}
                      disabled={allocationRunState?.loading || !selectedCenterId}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '6px',
                        fontSize: '12px',
                        fontWeight: 700,
                        padding: '7px 12px',
                        borderRadius: '8px',
                        border: '1px solid color-mix(in srgb, var(--color-primary) 40%, transparent)',
                        background: 'color-mix(in srgb, var(--color-primary) 16%, transparent)',
                        color: 'var(--color-primary)',
                        cursor: allocationRunState?.loading ? 'wait' : 'pointer',
                        opacity: allocationRunState?.loading ? 0.6 : 1,
                      }}
                    >
                      <Zap size={13} />
                      {allocationRunState?.loading ? 'Running…' : 'Run Allocation Now'}
                    </button>
                  </div>
                </div>

                <p style={{ fontSize: '11px', color: 'var(--text-muted)', margin: '0 0 14px 0' }}>
                  Customers never pick a counter. The backend allocator assigns the longest-waiting
                  eligible token to the least-loaded ready counter, in strict FIFO order, and re-runs
                  on every token, counter or completion event.
                </p>

                {allocationRunState?.error && (
                  <div style={{ fontSize: '12px', color: 'var(--color-danger)', marginBottom: '10px' }}>
                    {allocationRunState.error}
                  </div>
                )}
                {allocationRunState?.message && (
                  <div style={{ fontSize: '12px', color: 'var(--color-cyan)', marginBottom: '10px' }}>
                    {allocationRunState.message}
                  </div>
                )}
                {allocationError && <ErrorMessage message={allocationError} onRetry={fetchAllocation} />}

                {!allocation && !allocationError && (
                  <LoadingSpinner message="Reading allocator state..." />
                )}

                {allocation && (
                  <>
                    {/* Allocation metrics — all backend-computed */}
                    <div
                      style={{
                        display: 'grid',
                        gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
                        gap: '10px',
                        marginBottom: '18px',
                      }}
                    >
                      {[
                        { label: 'Total Counters', value: showValue(allocMetrics?.totalCounters) },
                        { label: 'Ready (allocatable)', value: showValue(allocMetrics?.readyCounters) },
                        { label: 'Busy (serving)', value: showValue(allocMetrics?.busyCounters) },
                        { label: 'On Break', value: showValue(allocMetrics?.breakCounters) },
                        { label: 'Closed', value: showValue(allocMetrics?.closedCounters) },
                        { label: 'Waiting Customers', value: showValue(allocMetrics?.waitingCustomers) },
                        { label: 'Live Occupancy', value: showValue(allocMetrics?.liveOccupancyPercent) },
                        { label: 'Counter Utilization', value: showValue(allocMetrics?.counterUtilization) },
                      ].map((m) => (
                        <div
                          key={m.label}
                          style={{
                            background: 'var(--bg-card-alt)',
                            border: '1px solid var(--border-subtle)',
                            borderRadius: '10px',
                            padding: '10px 12px',
                          }}
                        >
                          <span style={{ fontSize: '10px', color: 'var(--text-muted)', display: 'block', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                            {m.label}
                          </span>
                          <span className="mono" style={{ fontSize: '18px', fontWeight: 800, color: 'var(--text-primary)' }}>
                            {m.value}
                          </span>
                        </div>
                      ))}
                    </div>

                    {/* Per-counter truth table */}
                    <div style={{ fontSize: '12px', fontWeight: 800, color: 'var(--text-secondary)', marginBottom: '10px' }}>
                      COUNTERS ({allocCounters.length})
                    </div>
                    {allocCounters.length === 0 ? (
                      <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                        No counters registered at this center.
                      </div>
                    ) : (
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '12px' }}>
                        {allocCounters.map((c) => {
                          const tone = allocationStateTone(c.allocationState);
                          return (
                            <div
                              key={c._id}
                              style={{
                                background: 'var(--bg-card)',
                                border: '1px solid var(--border-subtle)',
                                borderLeft: `3px solid ${tone.fg}`,
                                borderRadius: '12px',
                                padding: '14px 16px',
                              }}
                            >
                              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
                                <span className="mono" style={{ fontSize: '14px', fontWeight: 800, color: 'var(--text-primary)' }}>
                                  {c.displayLabel || `Counter ${c.number}`}
                                </span>
                                <span
                                  className="mono"
                                  style={{
                                    fontSize: '10px',
                                    fontWeight: 800,
                                    padding: '2px 8px',
                                    borderRadius: '6px',
                                    background: tone.bg,
                                    color: tone.fg,
                                    border: `1px solid ${tone.bd}`,
                                  }}
                                >
                                  {c.allocationState || 'UNAVAILABLE'}
                                </span>
                              </div>

                              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '6px', marginTop: '10px', fontSize: '11px' }}>
                                <div>
                                  <span style={{ color: 'var(--text-muted)' }}>Status: </span>
                                  <span className="mono" style={{ color: 'var(--text-primary)' }}>{c.status || 'Unavailable'}</span>
                                </div>
                                <div>
                                  <span style={{ color: 'var(--text-muted)' }}>Service: </span>
                                  <span style={{ color: 'var(--text-primary)' }}>{c.service?.name || 'Unavailable'}</span>
                                </div>
                                <div>
                                  <span style={{ color: 'var(--text-muted)' }}>Current token: </span>
                                  <span className="mono" style={{ color: c.currentToken ? 'var(--color-primary)' : 'var(--text-muted)', fontWeight: 700 }}>
                                    {c.currentToken?.tokenCode || 'None'}
                                  </span>
                                </div>
                                <div>
                                  <span style={{ color: 'var(--text-muted)' }}>Token state: </span>
                                  <span className="mono" style={{ color: 'var(--text-primary)' }}>
                                    {c.currentToken?.status || 'Unavailable'}
                                  </span>
                                </div>
                                <div>
                                  <span style={{ color: 'var(--text-muted)' }}>Workload: </span>
                                  <span className="mono" style={{ color: 'var(--text-primary)' }}>
                                    {c.workloadScore === null || c.workloadScore === undefined
                                      ? 'Unavailable'
                                      : `${c.workloadScore} (${c.workloadLevel})`}
                                  </span>
                                </div>
                                <div>
                                  <span style={{ color: 'var(--text-muted)' }}>Idle: </span>
                                  <span className="mono" style={{ color: 'var(--text-primary)' }}>
                                    {c.idleMinutes === null || c.idleMinutes === undefined
                                      ? 'Unavailable'
                                      : `${c.idleMinutes} min`}
                                  </span>
                                </div>
                                <div>
                                  <span style={{ color: 'var(--text-muted)' }}>Operator: </span>
                                  <span style={{ color: 'var(--text-primary)' }}>{c.staff?.name || 'Unassigned'}</span>
                                </div>
                                <div>
                                  <span style={{ color: 'var(--text-muted)' }}>Serving since: </span>
                                  <span className="mono" style={{ color: 'var(--text-primary)' }}>
                                    {c.currentToken?.servingAt ? new Date(c.currentToken.servingAt).toLocaleTimeString() : 'Unavailable'}
                                  </span>
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}

                    {/* Queues + FIFO preview */}
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '16px', marginTop: '18px' }}>
                      <div>
                        <div style={{ fontSize: '12px', fontWeight: 800, color: 'var(--text-secondary)', marginBottom: '8px' }}>
                          QUEUES AT THIS CENTER
                        </div>
                        {allocQueues.length === 0 ? (
                          <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>No queue records for today.</div>
                        ) : (
                          allocQueues.map((q) => (
                            <div
                              key={String(q.serviceId)}
                              style={{
                                display: 'flex',
                                justifyContent: 'space-between',
                                gap: '10px',
                                fontSize: '12px',
                                padding: '6px 10px',
                                borderBottom: '1px solid var(--border-subtle)',
                                color: 'var(--text-primary)',
                              }}
                            >
                              <span>{q.serviceName || 'Unnamed service'}</span>
                              <span className="mono" style={{ color: 'var(--text-secondary)' }}>
                                waiting {showValue(q.waitingCount)} · active {showValue(q.activeCount)}
                              </span>
                            </div>
                          ))
                        )}
                      </div>

                      <div>
                        <div style={{ fontSize: '12px', fontWeight: 800, color: 'var(--text-secondary)', marginBottom: '8px' }}>
                          NEXT IN LINE (FIFO)
                        </div>
                        {allocWaiting.length === 0 ? (
                          <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Nobody waiting.</div>
                        ) : (
                          allocWaiting.slice(0, 8).map((t, i) => (
                            <div
                              key={t._id}
                              style={{
                                display: 'flex',
                                justifyContent: 'space-between',
                                gap: '10px',
                                fontSize: '12px',
                                padding: '6px 10px',
                                borderBottom: '1px solid var(--border-subtle)',
                                color: 'var(--text-primary)',
                              }}
                            >
                              <span className="mono">
                                {i + 1}. {t.tokenCode}
                              </span>
                              <span className="mono" style={{ color: 'var(--text-secondary)' }}>
                                {t.serviceName || '—'} · wait {showValue(t.waitEstimateMinutes, ' min')}
                              </span>
                            </div>
                          ))
                        )}
                      </div>
                    </div>
                  </>
                )}
              </div>

              {/* Tier 4 Feature 1: Ghost Queue Geofencing Telemetry */}
              {overview?.ghostQueue && (
                <div
                  style={{
                    background: 'rgba(15, 23, 42, 0.65)',
                    border: '1px solid color-mix(in srgb, var(--color-primary) 20%, transparent)',
                    borderRadius: '16px',
                    padding: '20px 24px',
                    marginBottom: '32px',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '14px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                      <span style={{ fontSize: '18px' }}>📍</span>
                      <div>
                        <h2 style={{ fontSize: '15px', fontWeight: 800, color: 'var(--text-primary)', margin: 0 }}>
                          Ghost Queue Geofencing Overview
                        </h2>
                        <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                          Server-authoritative customer proximity telemetry (Zero individual GPS coordinates exposed)
                        </span>
                      </div>
                    </div>
                    <span
                      className="mono"
                      style={{
                        fontSize: '11px',
                        fontWeight: 700,
                        padding: '3px 10px',
                        borderRadius: '8px',
                        background: overview.ghostQueue.enabled ? 'color-mix(in srgb, var(--color-primary) 15%, transparent)' : 'color-mix(in srgb, var(--text-secondary) 15%, transparent)',
                        color: overview.ghostQueue.enabled ? 'var(--color-primary)' : 'var(--text-secondary)',
                        border: `1px solid ${overview.ghostQueue.enabled ? 'color-mix(in srgb, var(--color-primary) 30%, transparent)' : 'color-mix(in srgb, var(--text-secondary) 30%, transparent)'}`,
                      }}
                    >
                      {overview.ghostQueue.enabled ? `GEOFENCE ACTIVE (r: ${overview.ghostQueue.radiusMeters}m)` : overview.ghostQueue.locationConfigured ? 'GEOFENCE DISABLED' : 'LOCATION NOT CONFIGURED'}
                    </span>
                  </div>

                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
                      gap: '12px',
                      marginTop: '12px',
                    }}
                  >
                    <div style={{ background: 'rgba(0, 0, 0, 0.25)', borderRadius: '10px', padding: '12px 16px', border: '1px solid var(--bg-card-alt)' }}>
                      <span style={{ fontSize: '11px', color: 'var(--text-secondary)', display: 'block' }}>Remote (Outside)</span>
                      <span style={{ fontSize: '20px', fontWeight: 800, color: 'var(--text-secondary)' }}>{overview.ghostQueue.remoteCustomers || 0}</span>
                    </div>
                    <div style={{ background: 'rgba(0, 0, 0, 0.25)', borderRadius: '10px', padding: '12px 16px', border: '1px solid var(--bg-card-alt)' }}>
                      <span style={{ fontSize: '11px', color: 'var(--color-warning)', display: 'block' }}>Approaching</span>
                      <span style={{ fontSize: '20px', fontWeight: 800, color: 'var(--color-warning)' }}>{overview.ghostQueue.approachingCustomers || 0}</span>
                    </div>
                    <div style={{ background: 'rgba(0, 0, 0, 0.25)', borderRadius: '10px', padding: '12px 16px', border: '1px solid var(--bg-card-alt)' }}>
                      <span style={{ fontSize: '11px', color: 'var(--color-cyan)', display: 'block' }}>Near Center</span>
                      <span style={{ fontSize: '20px', fontWeight: 800, color: 'var(--color-cyan)' }}>{overview.ghostQueue.nearCenter || 0}</span>
                    </div>
                    <div style={{ background: 'rgba(0, 0, 0, 0.25)', borderRadius: '10px', padding: '12px 16px', border: '1px solid var(--bg-card-alt)' }}>
                      <span style={{ fontSize: '11px', color: 'var(--color-primary)', display: 'block' }}>At Center (Inside)</span>
                      <span style={{ fontSize: '20px', fontWeight: 800, color: 'var(--color-primary)' }}>{overview.ghostQueue.atCenter || 0}</span>
                    </div>
                    <div style={{ background: 'rgba(0, 0, 0, 0.25)', borderRadius: '10px', padding: '12px 16px', border: '1px solid var(--bg-card-alt)' }}>
                      <span style={{ fontSize: '11px', color: 'var(--text-muted)', display: 'block' }}>Uncertain / Offline</span>
                      <span style={{ fontSize: '20px', fontWeight: 800, color: 'var(--text-muted)' }}>{overview.ghostQueue.unknownProximity || 0}</span>
                    </div>
                  </div>
                </div>
              )}

              {/* ── Operational Operator Roster ────────────────────────── */}
              <div style={{ marginBottom: '32px' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '14px', flexWrap: 'wrap', gap: '8px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <h2 style={{ fontSize: '16px', fontWeight: 800, color: 'var(--text-primary)', letterSpacing: '-0.01em', margin: 0 }}>
                      Active Facility Operators & Desk Assignment
                    </h2>
                    <span
                      className="mono"
                      style={{
                        fontSize: '11px',
                        fontWeight: 700,
                        padding: '2px 8px',
                        borderRadius: '6px',
                        background: 'rgba(56, 189, 248, 0.12)',
                        color: 'var(--color-cyan)',
                        border: '1px solid rgba(56, 189, 248, 0.25)',
                      }}
                    >
                      {operators.filter((o) => o.isAssigned).length} of {operators.length} Assigned
                    </span>
                  </div>
                  <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                    Authoritative staff & operator allocation from MongoDB
                  </span>
                </div>

                {operatorsLoading && operators.length === 0 ? (
                  <div style={{ padding: '24px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px' }}>
                    Loading operator roster...
                  </div>
                ) : operators.length === 0 ? (
                  <div
                    style={{
                      background: 'var(--bg-card-alt)',
                      border: '1px dashed var(--border-subtle)',
                      borderRadius: '16px',
                      padding: '30px',
                      textAlign: 'center',
                      color: 'var(--text-muted)',
                    }}
                  >
                    No staff or operators registered for this facility.
                  </div>
                ) : (
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(auto-fill, minmax(290px, 1fr))',
                      gap: '14px',
                    }}
                  >
                    {operators.map((op) => {
                      const isAssigned = op.isAssigned && op.assignedCounter;
                      const assignedCounter = op.assignedCounter;
                      const isServing = op.workload?.isServing;

                      return (
                        <div
                          key={op._id}
                          style={{
                            background: 'var(--bg-card-alt)',
                            border: `1px solid ${isAssigned ? 'rgba(56, 189, 248, 0.3)' : 'var(--border-subtle)'}`,
                            borderRadius: '14px',
                            padding: '16px',
                            display: 'flex',
                            flexDirection: 'column',
                            justifyContent: 'space-between',
                            position: 'relative',
                          }}
                        >
                          <div>
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                <div
                                  style={{
                                    width: '32px',
                                    height: '32px',
                                    borderRadius: '8px',
                                    background: isAssigned ? 'rgba(56, 189, 248, 0.15)' : 'rgba(255, 255, 255, 0.05)',
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    color: isAssigned ? 'var(--color-cyan)' : 'var(--text-muted)',
                                  }}
                                >
                                  <Users size={16} />
                                </div>
                                <div>
                                  <div style={{ fontSize: '13px', fontWeight: 800, color: 'var(--text-primary)' }}>
                                    {op.name}
                                  </div>
                                  <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                                    {op.email}
                                  </div>
                                </div>
                              </div>

                              <span
                                className="mono"
                                style={{
                                  fontSize: '10px',
                                  fontWeight: 800,
                                  padding: '2px 6px',
                                  borderRadius: '4px',
                                  background: op.isActive
                                    ? 'color-mix(in srgb, var(--color-primary) 15%, transparent)'
                                    : 'rgba(239, 68, 68, 0.15)',
                                  color: op.isActive ? 'var(--color-primary)' : 'var(--color-danger)',
                                  border: `1px solid ${op.isActive ? 'color-mix(in srgb, var(--color-primary) 30%, transparent)' : 'rgba(239, 68, 68, 0.3)'}`,
                                }}
                              >
                                {op.isActive ? (op.role === 'ADMIN' ? 'ADMIN / OP' : 'STAFF') : 'INACTIVE'}
                              </span>
                            </div>

                            {/* Assignment info */}
                            <div
                              style={{
                                background: isAssigned ? 'rgba(15, 23, 42, 0.6)' : 'rgba(15, 23, 42, 0.3)',
                                border: '1px solid var(--border-subtle)',
                                borderRadius: '10px',
                                padding: '10px 12px',
                                marginTop: '10px',
                                marginBottom: '12px',
                              }}
                            >
                              <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '3px' }}>
                                Desk Allocation
                              </div>
                              {isAssigned ? (
                                <div>
                                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                                    <span className="mono" style={{ fontSize: '13px', fontWeight: 800, color: 'var(--color-cyan)' }}>
                                      DESK #{assignedCounter.number} — {assignedCounter.name}
                                    </span>
                                    <span
                                      className="mono"
                                      style={{
                                        fontSize: '10px',
                                        fontWeight: 700,
                                        padding: '1px 5px',
                                        borderRadius: '4px',
                                        background: isServing ? 'color-mix(in srgb, var(--color-primary) 20%, transparent)' : 'rgba(255, 255, 255, 0.08)',
                                        color: isServing ? 'var(--color-primary)' : 'var(--text-secondary)',
                                      }}
                                    >
                                      {assignedCounter.status}
                                    </span>
                                  </div>
                                  {op.workload && (
                                    <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px' }}>
                                      Served today: <strong style={{ color: 'var(--text-primary)' }}>{op.workload.servedToday}</strong>
                                      {isServing && <span style={{ color: 'var(--color-primary)', marginLeft: '8px' }}>• Actively serving</span>}
                                    </div>
                                  )}
                                </div>
                              ) : (
                                <div style={{ fontSize: '12px', color: 'var(--text-dim)', fontStyle: 'italic' }}>
                                  Unassigned — Available for counter assignment
                                </div>
                              )}
                            </div>
                          </div>

                          {/* Quick Action Button */}
                          {isAdmin && (
                            <div style={{ display: 'flex', gap: '8px' }}>
                              {isAssigned ? (
                                <>
                                  <button
                                    onClick={() => openAssignModal(assignedCounter, op._id)}
                                    className="btn-secondary"
                                    style={{
                                      flex: 1,
                                      fontSize: '11px',
                                      padding: '6px 10px',
                                      fontWeight: 700,
                                      display: 'flex',
                                      alignItems: 'center',
                                      justifyContent: 'center',
                                      gap: '4px',
                                    }}
                                  >
                                    <Shuffle size={12} />
                                    <span>Reassign Desk</span>
                                  </button>
                                  <button
                                    onClick={() => handleQuickUnassign(assignedCounter._id)}
                                    disabled={quickActionLoading[assignedCounter._id] === 'unassign'}
                                    style={{
                                      background: 'rgba(239, 68, 68, 0.1)',
                                      border: '1px solid rgba(239, 68, 68, 0.25)',
                                      color: 'var(--color-danger)',
                                      borderRadius: '8px',
                                      fontSize: '11px',
                                      padding: '6px 10px',
                                      fontWeight: 700,
                                      cursor: 'pointer',
                                    }}
                                  >
                                    {quickActionLoading[assignedCounter._id] === 'unassign' ? '...' : 'Unassign'}
                                  </button>
                                </>
                              ) : (
                                <button
                                  onClick={() => {
                                    const target = counters.find((c) => !c.staffId && !c.staff) || counters[0];
                                    if (target) {
                                      openAssignModal(target, op._id);
                                    }
                                  }}
                                  disabled={counters.length === 0}
                                  style={{
                                    width: '100%',
                                    background: 'color-mix(in srgb, var(--color-primary) 15%, transparent)',
                                    border: '1px solid color-mix(in srgb, var(--color-primary) 30%, transparent)',
                                    color: 'var(--color-primary)',
                                    borderRadius: '8px',
                                    fontSize: '11px',
                                    padding: '6px 10px',
                                    fontWeight: 700,
                                    cursor: counters.length === 0 ? 'not-allowed' : 'pointer',
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    gap: '4px',
                                  }}
                                >
                                  <UserCheck size={13} />
                                  <span>Assign to Counter Desk</span>
                                </button>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* ── Counter Heat Grid ────────────────────────── */}
              <div style={{ marginBottom: '32px' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '14px' }}>
                  <h2 style={{ fontSize: '16px', fontWeight: 800, color: 'var(--text-primary)', letterSpacing: '-0.01em' }}>
                    Live Center Counter Matrix
                  </h2>
                  <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                    Real-time visual state across all physical desks
                  </span>
                </div>

                {counters.length === 0 ? (
                  <div
                    style={{
                      background: 'var(--bg-card-alt)',
                      border: '1px dashed var(--border-subtle)',
                      borderRadius: '16px',
                      padding: '40px',
                      textAlign: 'center',
                      color: 'var(--text-muted)',
                    }}
                  >
                    No counters configured for this center.
                  </div>
                ) : (
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(auto-fill, minmax(290px, 1fr))',
                      gap: '16px',
                    }}
                  >
                    {counters.map((c) => {
                      const isServing = c.status === 'ACTIVE' && c.currentToken?.status === 'SERVING';
                      const isCalled = c.status === 'ACTIVE' && c.currentToken?.status === 'CALLED';
                      const isIdle = c.status === 'ACTIVE' && !c.currentToken;
                      const isBreak = c.status === 'BREAK';
                      const isClosed = c.status === 'CLOSED';

                      const borderColor = isServing
                        ? 'color-mix(in srgb, var(--color-primary) 40%, transparent)'
                        : isCalled
                        ? 'rgba(56, 189, 248, 0.4)'
                        : isBreak
                        ? 'color-mix(in srgb, var(--color-warning) 40%, transparent)'
                        : isClosed
                        ? 'color-mix(in srgb, var(--color-danger) 20%, transparent)'
                        : 'var(--border-subtle)';

                      return (
                        <div
                          key={c._id}
                          style={{
                            background: 'var(--bg-card-alt)',
                            border: `1px solid ${borderColor}`,
                            borderRadius: '16px',
                            padding: '18px',
                            display: 'flex',
                            flexDirection: 'column',
                            justifyContent: 'space-between',
                            position: 'relative',
                            overflow: 'hidden',
                          }}
                        >
                          {/* Card Top: Counter Number & Status Badge */}
                          <div>
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                <span
                                  className="mono"
                                  style={{
                                    fontSize: '13px',
                                    fontWeight: 800,
                                    color: 'var(--text-primary)',
                                    padding: '3px 8px',
                                    borderRadius: '6px',
                                    background: 'var(--bg-card-alt)',
                                  }}
                                >
                                  DESK #{c.number}
                                </span>
                                <span style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)' }}>
                                  {c.name}
                                </span>
                              </div>

                              {/* Status Badge */}
                              <span
                                className="mono"
                                style={{
                                  fontSize: '10px',
                                  fontWeight: 800,
                                  padding: '3px 8px',
                                  borderRadius: '6px',
                                  background: isServing
                                    ? 'color-mix(in srgb, var(--color-primary) 15%, transparent)'
                                    : isCalled
                                    ? 'rgba(56, 189, 248, 0.15)'
                                    : isBreak
                                    ? 'color-mix(in srgb, var(--color-warning) 15%, transparent)'
                                    : isClosed
                                    ? 'color-mix(in srgb, var(--color-danger) 15%, transparent)'
                                    : 'color-mix(in srgb, var(--text-secondary) 15%, transparent)',
                                  color: isServing
                                    ? 'var(--color-primary)'
                                    : isCalled
                                    ? 'var(--color-cyan)'
                                    : isBreak
                                    ? 'var(--color-warning)'
                                    : isClosed
                                    ? 'var(--color-danger)'
                                    : 'var(--text-secondary)',
                                  border: `1px solid ${borderColor}`,
                                }}
                              >
                                {isServing
                                  ? 'SERVING'
                                  : isCalled
                                  ? 'CALLED'
                                  : isBreak
                                  ? 'ON BREAK'
                                  : isClosed
                                  ? 'CLOSED'
                                  : 'IDLE'}
                              </span>
                            </div>

                            {/* Service Assignment Badge */}
                            <div style={{ marginBottom: '12px' }}>
                              <span style={{ fontSize: '11px', color: 'var(--text-muted)', display: 'block', marginBottom: '3px' }}>
                                Assigned Service
                              </span>
                              {c.service ? (
                                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                                  <span
                                    className="mono"
                                    style={{
                                      fontSize: '10px',
                                      fontWeight: 800,
                                      padding: '2px 6px',
                                      borderRadius: '4px',
                                      background: 'rgba(56, 189, 248, 0.18)',
                                      color: 'var(--color-cyan)',
                                    }}
                                  >
                                    [{c.service.tokenPrefix}]
                                  </span>
                                  <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)' }}>
                                    {c.service.name}
                                  </span>
                                </div>
                              ) : (
                                <span style={{ fontSize: '12px', fontStyle: 'italic', color: 'var(--text-muted)' }}>
                                  Unassigned
                                </span>
                              )}
                            </div>

                            {/* Operator Assignment */}
                            <div style={{ marginBottom: '14px' }}>
                              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '4px' }}>
                                <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                                  Assigned Operator
                                </span>
                                {c.staff && (
                                  <span
                                    className="mono"
                                    style={{
                                      fontSize: '9px',
                                      fontWeight: 700,
                                      color: 'var(--color-primary)',
                                      background: 'color-mix(in srgb, var(--color-primary) 12%, transparent)',
                                      padding: '1px 6px',
                                      borderRadius: '4px',
                                    }}
                                  >
                                    ACTIVE
                                  </span>
                                )}
                              </div>

                              <div
                                style={{
                                  background: 'rgba(15, 23, 42, 0.4)',
                                  border: '1px solid var(--border-subtle)',
                                  borderRadius: '8px',
                                  padding: '8px 10px',
                                  display: 'flex',
                                  alignItems: 'center',
                                  justifyContent: 'space-between',
                                  gap: '8px',
                                }}
                              >
                                <div style={{ minWidth: 0, flex: 1 }}>
                                  <div style={{ fontSize: '12px', fontWeight: 700, color: c.staff ? 'var(--text-primary)' : 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                    {c.staff ? c.staff.name : 'No operator assigned'}
                                  </div>
                                  <div style={{ fontSize: '10px', color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                    {c.staff ? c.staff.email : 'Desk cannot serve tokens without staff'}
                                  </div>
                                </div>

                                {isAdmin && (
                                  <div style={{ display: 'flex', gap: '5px', flexShrink: 0 }}>
                                    <button
                                      type="button"
                                      onClick={() => openAssignModal(c)}
                                      title={c.staff ? 'Change assigned operator' : 'Assign operator to this desk'}
                                      style={{
                                        background: c.staff ? 'var(--bg-card-alt)' : 'color-mix(in srgb, var(--color-primary) 15%, transparent)',
                                        border: `1px solid ${c.staff ? 'var(--border-subtle)' : 'color-mix(in srgb, var(--color-primary) 30%, transparent)'}`,
                                        color: c.staff ? 'var(--text-primary)' : 'var(--color-primary)',
                                        borderRadius: '6px',
                                        padding: '4px 8px',
                                        fontSize: '11px',
                                        fontWeight: 700,
                                        cursor: 'pointer',
                                      }}
                                    >
                                      {c.staff ? 'Change' : 'Assign'}
                                    </button>
                                    {c.staff && (
                                      <button
                                        type="button"
                                        onClick={() => handleQuickUnassign(c._id)}
                                        disabled={quickActionLoading[c._id] === 'unassign'}
                                        title="Unassign operator from this desk"
                                        style={{
                                          background: 'rgba(239, 68, 68, 0.1)',
                                          border: '1px solid rgba(239, 68, 68, 0.25)',
                                          color: 'var(--color-danger)',
                                          borderRadius: '6px',
                                          padding: '4px 8px',
                                          fontSize: '11px',
                                          fontWeight: 700,
                                          cursor: 'pointer',
                                        }}
                                      >
                                        {quickActionLoading[c._id] === 'unassign' ? '...' : 'Unassign'}
                                      </button>
                                    )}
                                  </div>
                                )}
                              </div>
                            </div>

                            {/* Current Token Hero Display */}
                            <div
                              style={{
                                background: c.currentToken
                                  ? isServing
                                    ? 'color-mix(in srgb, var(--color-primary) 8%, transparent)'
                                    : 'rgba(56, 189, 248, 0.08)'
                                  : 'rgba(15, 23, 42, 0.4)',
                                border: `1px solid ${c.currentToken ? borderColor : 'var(--bg-card-alt)'}`,
                                borderRadius: '12px',
                                padding: '12px 14px',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'space-between',
                                marginBottom: '14px',
                              }}
                            >
                              <div>
                                <span style={{ fontSize: '10px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                                  {c.currentToken ? (isServing ? 'Serving Token' : 'Called Token') : 'Desk Status'}
                                </span>
                                <div style={{ fontSize: '18px', fontWeight: 900, color: c.currentToken ? 'var(--text-primary)' : 'var(--text-dim)', letterSpacing: '0.02em', marginTop: '2px' }}>
                                  {c.currentToken ? c.currentToken.tokenCode : 'Waiting for call'}
                                </div>
                              </div>

                              {c.currentToken && (
                                <div style={{ textAlign: 'right' }}>
                                  <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>Active Elapsed</span>
                                  <div className="mono" style={{ fontSize: '12px', fontWeight: 700, color: 'var(--color-cyan)', marginTop: '2px' }}>
                                    {Math.floor((c.servingElapsedSeconds || 0) / 60)}m {(c.servingElapsedSeconds || 0) % 60}s
                                  </div>
                                </div>
                              )}
                            </div>
                          </div>

                          {/* Actions: Desk Controls & Morphing */}
                          {isAdmin && (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                              {/* Quick Desk Status Controls */}
                              <div style={{ display: 'flex', gap: '6px' }}>
                                {c.status !== 'ACTIVE' ? (
                                  <button
                                    type="button"
                                    onClick={() => handleQuickStatusChange(c._id, 'ACTIVE')}
                                    disabled={quickActionLoading[c._id] === 'ACTIVE'}
                                    style={{
                                      flex: 1,
                                      background: 'color-mix(in srgb, var(--color-primary) 15%, transparent)',
                                      border: '1px solid color-mix(in srgb, var(--color-primary) 30%, transparent)',
                                      color: 'var(--color-primary)',
                                      borderRadius: '8px',
                                      padding: '7px 8px',
                                      fontSize: '11px',
                                      fontWeight: 700,
                                      cursor: 'pointer',
                                      display: 'flex',
                                      alignItems: 'center',
                                      justifyContent: 'center',
                                      gap: '4px',
                                    }}
                                  >
                                    <Play size={12} />
                                    <span>{quickActionLoading[c._id] === 'ACTIVE' ? 'Opening...' : 'Open Desk'}</span>
                                  </button>
                                ) : (
                                  <>
                                    <button
                                      type="button"
                                      onClick={() => handleQuickStatusChange(c._id, 'BREAK')}
                                      disabled={quickActionLoading[c._id] === 'BREAK'}
                                      style={{
                                        flex: 1,
                                        background: 'color-mix(in srgb, var(--color-warning) 15%, transparent)',
                                        border: '1px solid color-mix(in srgb, var(--color-warning) 30%, transparent)',
                                        color: 'var(--color-warning)',
                                        borderRadius: '8px',
                                        padding: '7px 8px',
                                        fontSize: '11px',
                                        fontWeight: 700,
                                        cursor: 'pointer',
                                        display: 'flex',
                                        alignItems: 'center',
                                        justifyContent: 'center',
                                        gap: '4px',
                                      }}
                                    >
                                      <Coffee size={12} />
                                      <span>{quickActionLoading[c._id] === 'BREAK' ? '...' : 'Break'}</span>
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => handleQuickStatusChange(c._id, 'CLOSED')}
                                      disabled={quickActionLoading[c._id] === 'CLOSED'}
                                      style={{
                                        flex: 1,
                                        background: 'color-mix(in srgb, var(--color-danger) 15%, transparent)',
                                        border: '1px solid color-mix(in srgb, var(--color-danger) 30%, transparent)',
                                        color: 'var(--color-danger)',
                                        borderRadius: '8px',
                                        padding: '7px 8px',
                                        fontSize: '11px',
                                        fontWeight: 700,
                                        cursor: 'pointer',
                                        display: 'flex',
                                        alignItems: 'center',
                                        justifyContent: 'center',
                                        gap: '4px',
                                      }}
                                    >
                                      <XCircle size={12} />
                                      <span>{quickActionLoading[c._id] === 'CLOSED' ? '...' : 'Close'}</span>
                                    </button>
                                  </>
                                )}
                              </div>

                              <button
                                type="button"
                                onClick={() => openMorphModal(c)}
                                style={{
                                  width: '100%',
                                  background: 'var(--bg-card-alt)',
                                  border: '1px solid rgba(255, 255, 255, 0.1)',
                                  borderRadius: '8px',
                                  padding: '7px 12px',
                                  color: 'var(--text-primary)',
                                  fontSize: '11px',
                                  fontWeight: 700,
                                  cursor: 'pointer',
                                  display: 'flex',
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                  gap: '6px',
                                  transition: 'all 0.15s ease',
                                }}
                                onMouseOver={(e) => {
                                  e.currentTarget.style.background = 'color-mix(in srgb, var(--color-primary) 15%, transparent)';
                                  e.currentTarget.style.color = 'var(--color-primary)';
                                  e.currentTarget.style.borderColor = 'color-mix(in srgb, var(--color-primary) 30%, transparent)';
                                }}
                                onMouseOut={(e) => {
                                  e.currentTarget.style.background = 'var(--bg-card-alt)';
                                  e.currentTarget.style.color = 'var(--text-primary)';
                                  e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.1)';
                                }}
                              >
                                <Shuffle size={12} />
                                <span>Morph Counter Service</span>
                              </button>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* ── Service Queues Status & Recent Events ────────────────────────── */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(400px, 1fr))', gap: '20px' }}>
                {/* Active Services Queue Depth */}
                <div
                  style={{
                    background: 'var(--bg-card-alt)',
                    border: '1px solid var(--border-subtle)',
                    borderRadius: '16px',
                    padding: '20px',
                  }}
                >
                  <h3 style={{ fontSize: '15px', fontWeight: 800, color: 'var(--text-primary)', marginBottom: '4px' }}>
                    Active Services Queue Depth
                  </h3>
                  <p style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '14px' }}>
                    Wait estimates are calculated by the QueueFlow backend from real queue, counter and
                    service-history data. This panel only displays the values the backend returns.
                  </p>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                    {services.map((svc) => {
                      const ewt = ewtServicesById[svc.serviceId] || null;
                      return (
                      <div
                        key={svc.serviceId}
                        style={{
                          background: 'rgba(15, 23, 42, 0.5)',
                          borderRadius: '10px',
                          padding: '12px 14px',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          border: '1px solid var(--bg-card-alt)',
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                          <span
                            className="mono"
                            style={{
                              fontSize: '11px',
                              fontWeight: 800,
                              padding: '2px 6px',
                              borderRadius: '4px',
                              background: 'color-mix(in srgb, var(--color-primary) 15%, transparent)',
                              color: 'var(--color-primary)',
                            }}
                          >
                            [{svc.tokenPrefix}]
                          </span>
                          <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)' }}>
                            {svc.name}
                          </span>
                          {ewt && (
                            <span
                              title={describeEwtSource(ewt)}
                              style={{
                                fontSize: '9px',
                                fontWeight: 800,
                                letterSpacing: '0.04em',
                                padding: '2px 6px',
                                borderRadius: '4px',
                                background: ewt.context?.fallbackUsed
                                  ? 'color-mix(in srgb, var(--color-warning) 15%, transparent)'
                                  : 'var(--bg-card-alt)',
                                color: ewt.context?.fallbackUsed ? 'var(--color-warning)' : 'var(--text-secondary)',
                                cursor: 'help',
                              }}
                            >
                              {ewtBadge(ewt)}
                            </span>
                          )}
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
                          <div style={{ textAlign: 'right' }}>
                            <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>Waiting</span>
                            <div className="mono" style={{ fontSize: '14px', fontWeight: 800, color: 'var(--color-danger)' }}>
                              {svc.waitingCount}
                            </div>
                          </div>
                          <div style={{ textAlign: 'right' }}>
                            <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>Serving</span>
                            <div className="mono" style={{ fontSize: '14px', fontWeight: 800, color: 'var(--color-primary)' }}>
                              {svc.servingCount}
                            </div>
                          </div>
                          <div style={{ textAlign: 'right' }}>
                            <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>Est. Wait</span>
                            <div
                              className="mono"
                              style={{ fontSize: '14px', fontWeight: 800, color: 'var(--color-cyan)' }}
                              data-testid={`ewt-${svc.serviceId}`}
                            >
                              {ewt ? `${ewt.estimatedWaitMinutes} min` : '—'}
                            </div>
                          </div>
                        </div>
                      </div>
                      );
                    })}
                    {ewtError && (
                      <span style={{ fontSize: '11px', color: 'var(--color-warning)' }}>{ewtError}</span>
                    )}
                  </div>
                </div>

                {/* Recent Operational Events / Audit Trail */}
                <div
                  style={{
                    background: 'var(--bg-card-alt)',
                    border: '1px solid var(--border-subtle)',
                    borderRadius: '16px',
                    padding: '20px',
                  }}
                >
                  <h3 style={{ fontSize: '15px', fontWeight: 800, color: 'var(--text-primary)', marginBottom: '14px' }}>
                    Recent Operational Events
                  </h3>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', maxHeight: '280px', overflowY: 'auto' }}>
                    {recentEvents.map((ev) => (
                      <div
                        key={ev._id}
                        style={{
                          background: 'rgba(15, 23, 42, 0.4)',
                          borderRadius: '8px',
                          padding: '8px 12px',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          fontSize: '11px',
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                          <span
                            className="mono"
                            style={{
                              fontSize: '9px',
                              fontWeight: 700,
                              padding: '2px 5px',
                              borderRadius: '4px',
                              background: ev.eventType === 'COUNTER_MORPHED' ? 'rgba(168, 85, 247, 0.2)' : 'var(--bg-card-alt)',
                              color: ev.eventType === 'COUNTER_MORPHED' ? 'var(--color-cyan)' : 'var(--text-secondary)',
                            }}
                          >
                            {ev.eventType}
                          </span>
                          <span style={{ color: 'var(--text-primary)' }}>
                            {ev.metadata?.counterName ? `${ev.metadata.counterName} • ` : ''}
                            {ev.metadata?.newServiceName ? `Reassigned to ${ev.metadata.newServiceName}` : ev.metadata?.status || ''}
                          </span>
                        </div>
                        <span className="mono" style={{ color: 'var(--text-muted)' }}>
                          {ev.createdAt ? new Date(ev.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : ''}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </>
          )}
        </>
      )}

      {/* ── TAB 2: HISTORICAL & SLA REPORTING ────────────────────────── */}
      {activeTab === 'historical' && (
        <>
          {/* Controls Bar */}
          <div
            style={{
              background: 'var(--bg-card-alt)',
              border: '1px solid var(--border-subtle)',
              borderRadius: '16px',
              padding: '16px 20px',
              display: 'flex',
              flexWrap: 'wrap',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '14px',
              marginBottom: '24px',
            }}
          >
            {/* Time Filter Buttons */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Calendar size={15} color="var(--text-muted)" />
              {['today', '7d', '30d'].map((range) => (
                <button
                  key={range}
                  onClick={() => {
                    setTimeRange(range);
                    setHistoricalPage(1);
                  }}
                  style={{
                    background: timeRange === range ? 'color-mix(in srgb, var(--color-primary) 15%, transparent)' : 'var(--bg-card-alt)',
                    color: timeRange === range ? 'var(--color-primary)' : 'var(--text-secondary)',
                    border: timeRange === range ? '1px solid color-mix(in srgb, var(--color-primary) 30%, transparent)' : '1px solid transparent',
                    borderRadius: '8px',
                    padding: '6px 12px',
                    fontSize: '12px',
                    fontWeight: 700,
                    cursor: 'pointer',
                    textTransform: 'uppercase',
                  }}
                >
                  {range === 'today' ? 'Today' : range === '7d' ? 'Last 7 Days' : 'Last 30 Days'}
                </button>
              ))}
            </div>

            {/* SLA Target input & export */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '14px', flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>SLA Target Wait:</span>
                <input
                  type="number"
                  min="1"
                  max="120"
                  value={targetWaitMinutes}
                  onChange={(e) => setTargetWaitMinutes(e.target.value)}
                  placeholder="e.g. 15"
                  style={{
                    width: '65px',
                    background: 'rgba(15, 23, 42, 0.8)',
                    border: '1px solid var(--border-subtle)',
                    color: 'var(--text-primary)',
                    borderRadius: '8px',
                    padding: '6px 10px',
                    fontSize: '12px',
                    fontWeight: 700,
                    textAlign: 'center',
                  }}
                />
                <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>min</span>
                <button
                  onClick={fetchHistorical}
                  className="btn-secondary"
                  style={{ fontSize: '11px', padding: '6px 10px' }}
                >
                  Apply
                </button>
              </div>

              <button
                onClick={handleExportCsv}
                style={{
                  background: 'color-mix(in srgb, var(--color-primary) 12%, transparent)',
                  border: '1px solid color-mix(in srgb, var(--color-primary) 30%, transparent)',
                  borderRadius: '8px',
                  color: 'var(--color-primary)',
                  padding: '7px 14px',
                  fontSize: '12px',
                  fontWeight: 700,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                }}
              >
                <Download size={13} />
                <span>Export CSV Report</span>
              </button>
            </div>
          </div>

          {historicalError && <ErrorMessage message={historicalError} onRetry={fetchHistorical} />}
          {historicalLoading && !historicalData ? (
            <LoadingSpinner message="Generating historical report datasets..." />
          ) : historicalData ? (
            <>
              {/* Top Historical Metric Cards */}
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
                  gap: '14px',
                  marginBottom: '24px',
                }}
              >
                <div className="stat-pill" style={{ padding: '16px 20px', alignItems: 'flex-start' }}>
                  <span className="stat-pill-label">Total Tokens Issued</span>
                  <span className="stat-pill-val" style={{ color: 'var(--text-primary)', marginTop: '4px' }}>
                    {historicalData.summary?.totalIssued || 0}
                  </span>
                  <span style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>
                    Completion Rate: {historicalData.summary?.completionRate || 0}%
                  </span>
                </div>

                <div className="stat-pill" style={{ padding: '16px 20px', alignItems: 'flex-start' }}>
                  <span className="stat-pill-label">Completed Services</span>
                  <span className="stat-pill-val" style={{ color: 'var(--color-primary)', marginTop: '4px' }}>
                    {historicalData.summary?.totalCompleted || 0}
                  </span>
                  <span style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>
                    {historicalData.summary?.totalSkipped || 0} Skipped • {historicalData.summary?.totalCancelled || 0} Cancelled
                  </span>
                </div>

                <div className="stat-pill" style={{ padding: '16px 20px', alignItems: 'flex-start' }}>
                  <span className="stat-pill-label">Average Wait Time</span>
                  <span className="stat-pill-val" style={{ color: 'var(--color-cyan)', marginTop: '4px' }}>
                    {historicalData.timing?.avgWaitSeconds != null
                      ? `${Math.round(historicalData.timing.avgWaitSeconds / 60)} min`
                      : 'N/A'}
                  </span>
                  <span style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>
                    Min: {historicalData.timing?.minWaitSeconds != null ? `${Math.round(historicalData.timing.minWaitSeconds / 60)}m` : '0m'} • Max: {historicalData.timing?.maxWaitSeconds != null ? `${Math.round(historicalData.timing.maxWaitSeconds / 60)}m` : '0m'}
                  </span>
                </div>

                <div className="stat-pill" style={{ padding: '16px 20px', alignItems: 'flex-start' }}>
                  <span className="stat-pill-label">Average Service Duration</span>
                  <span className="stat-pill-val" style={{ color: 'var(--color-warning)', marginTop: '4px' }}>
                    {historicalData.timing?.avgServiceSeconds != null
                      ? `${(historicalData.timing.avgServiceSeconds / 60).toFixed(1)} min`
                      : 'N/A'}
                  </span>
                  <span style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>
                    Active desk handle time
                  </span>
                </div>

                {/* SLA Compliance Card */}
                <div
                  className="stat-pill"
                  style={{
                    padding: '16px 20px',
                    alignItems: 'flex-start',
                    border:
                      historicalData.sla?.status === 'CONFIGURED'
                        ? '1px solid color-mix(in srgb, var(--color-primary) 30%, transparent)'
                        : '1px solid var(--border-subtle)',
                  }}
                >
                  <span className="stat-pill-label">SLA Compliance</span>
                  {historicalData.sla?.status === 'CONFIGURED' ? (
                    <>
                      <span className="stat-pill-val" style={{ color: 'var(--color-primary)', marginTop: '4px' }}>
                        {historicalData.sla.compliancePercent}%
                      </span>
                      <span style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>
                        {historicalData.sla.compliantCount} of {historicalData.sla.totalCompleted} within {historicalData.sla.targetWaitMinutes}m
                      </span>
                    </>
                  ) : (
                    <>
                      <span className="mono" style={{ fontSize: '14px', fontWeight: 800, color: 'var(--text-secondary)', marginTop: '6px' }}>
                        CONFIGURABLE
                      </span>
                      <span style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>
                        Enter SLA target above
                      </span>
                    </>
                  )}
                </div>
              </div>

              {/* Counter Utilization & Service Breakdown */}
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(450px, 1fr))',
                  gap: '20px',
                  marginBottom: '24px',
                }}
              >
                {/* Counter Performance Breakdown */}
                <div
                  style={{
                    background: 'var(--bg-card-alt)',
                    border: '1px solid var(--border-subtle)',
                    borderRadius: '16px',
                    padding: '20px',
                  }}
                >
                  <h3 style={{ fontSize: '15px', fontWeight: 800, color: 'var(--text-primary)', marginBottom: '14px' }}>
                    Counter Productivity & Utilization
                  </h3>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
                    <thead>
                      <tr style={{ borderBottom: '1px solid var(--border-subtle)', color: 'var(--text-muted)', textAlign: 'left' }}>
                        <th style={{ padding: '8px 0' }}>Desk</th>
                        <th style={{ padding: '8px 0' }}>Total Handled</th>
                        <th style={{ padding: '8px 0' }}>Completed</th>
                        <th style={{ padding: '8px 0' }}>Skipped</th>
                        <th style={{ padding: '8px 0' }}>Avg Service</th>
                      </tr>
                    </thead>
                    <tbody>
                      {historicalData.counterUtilization?.map((cu) => (
                        <tr key={cu.counterId} style={{ borderBottom: '1px solid var(--bg-card-alt)' }}>
                          <td style={{ padding: '10px 0', fontWeight: 600, color: 'var(--text-primary)' }}>
                            {cu.name}
                          </td>
                          <td className="mono" style={{ padding: '10px 0', color: 'var(--text-secondary)' }}>
                            {cu.totalHandled}
                          </td>
                          <td className="mono" style={{ padding: '10px 0', color: 'var(--color-primary)', fontWeight: 700 }}>
                            {cu.completed}
                          </td>
                          <td className="mono" style={{ padding: '10px 0', color: 'var(--color-warning)' }}>
                            {cu.skipped}
                          </td>
                          <td className="mono" style={{ padding: '10px 0', color: 'var(--color-cyan)' }}>
                            {cu.avgServiceSeconds != null ? `${(cu.avgServiceSeconds / 60).toFixed(1)}m` : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Service Demand Breakdown */}
                <div
                  style={{
                    background: 'var(--bg-card-alt)',
                    border: '1px solid var(--border-subtle)',
                    borderRadius: '16px',
                    padding: '20px',
                  }}
                >
                  <h3 style={{ fontSize: '15px', fontWeight: 800, color: 'var(--text-primary)', marginBottom: '14px' }}>
                    Service Demand Breakdown
                  </h3>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
                    <thead>
                      <tr style={{ borderBottom: '1px solid var(--border-subtle)', color: 'var(--text-muted)', textAlign: 'left' }}>
                        <th style={{ padding: '8px 0' }}>Service</th>
                        <th style={{ padding: '8px 0' }}>Total Issued</th>
                        <th style={{ padding: '8px 0' }}>Completed</th>
                        <th style={{ padding: '8px 0' }}>Cancelled</th>
                      </tr>
                    </thead>
                    <tbody>
                      {historicalData.servicePerformance?.map((sp) => (
                        <tr key={sp.serviceId} style={{ borderBottom: '1px solid var(--bg-card-alt)' }}>
                          <td style={{ padding: '10px 0', fontWeight: 600, color: 'var(--text-primary)' }}>
                            [{sp.tokenPrefix}] {sp.name}
                          </td>
                          <td className="mono" style={{ padding: '10px 0', color: 'var(--text-secondary)' }}>
                            {sp.totalIssued}
                          </td>
                          <td className="mono" style={{ padding: '10px 0', color: 'var(--color-primary)', fontWeight: 700 }}>
                            {sp.completed}
                          </td>
                          <td className="mono" style={{ padding: '10px 0', color: 'var(--color-danger)' }}>
                            {sp.cancelled}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Paginated Historical Tokens Log Table */}
              <div
                style={{
                  background: 'var(--bg-card-alt)',
                  border: '1px solid var(--border-subtle)',
                  borderRadius: '16px',
                  padding: '20px',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
                  <h3 style={{ fontSize: '15px', fontWeight: 800, color: 'var(--text-primary)' }}>
                    Persisted Token Audit History
                  </h3>
                  <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                    Total Records: {historicalData.pagination?.total || 0}
                  </span>
                </div>

                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
                    <thead>
                      <tr style={{ borderBottom: '1px solid var(--border-subtle)', color: 'var(--text-muted)', textAlign: 'left' }}>
                        <th style={{ padding: '10px 12px' }}>Token</th>
                        <th style={{ padding: '10px 12px' }}>Service</th>
                        <th style={{ padding: '10px 12px' }}>Counter</th>
                        <th style={{ padding: '10px 12px' }}>Operator</th>
                        <th style={{ padding: '10px 12px' }}>Status</th>
                        <th style={{ padding: '10px 12px' }}>Wait Time</th>
                        <th style={{ padding: '10px 12px' }}>Service Time</th>
                        <th style={{ padding: '10px 12px' }}>Created</th>
                        <th style={{ padding: '10px 12px' }}>Completed</th>
                      </tr>
                    </thead>
                    <tbody>
                      {historicalData.tokens?.map((t) => (
                        <tr key={t._id} style={{ borderBottom: '1px solid var(--bg-card-alt)' }}>
                          <td className="mono" style={{ padding: '10px 12px', fontWeight: 800, color: 'var(--color-primary)' }}>
                            {t.tokenCode}
                          </td>
                          <td style={{ padding: '10px 12px', color: 'var(--text-primary)' }}>
                            [{t.tokenPrefix}] {t.serviceName}
                          </td>
                          <td style={{ padding: '10px 12px', color: 'var(--text-secondary)' }}>
                            {t.counterName || '—'}
                          </td>
                          <td style={{ padding: '10px 12px', color: 'var(--text-secondary)' }}>
                            {t.operatorName || '—'}
                          </td>
                          <td style={{ padding: '10px 12px' }}>
                            <span
                              className="mono"
                              style={{
                                fontSize: '10px',
                                fontWeight: 700,
                                padding: '2px 6px',
                                borderRadius: '4px',
                                background:
                                  t.status === 'COMPLETED'
                                    ? 'color-mix(in srgb, var(--color-primary) 15%, transparent)'
                                    : t.status === 'SKIPPED'
                                    ? 'color-mix(in srgb, var(--color-warning) 15%, transparent)'
                                    : t.status === 'CANCELLED'
                                    ? 'color-mix(in srgb, var(--color-danger) 15%, transparent)'
                                    : 'color-mix(in srgb, var(--text-secondary) 15%, transparent)',
                                color:
                                  t.status === 'COMPLETED'
                                    ? 'var(--color-primary)'
                                    : t.status === 'SKIPPED'
                                    ? 'var(--color-warning)'
                                    : t.status === 'CANCELLED'
                                    ? 'var(--color-danger)'
                                    : 'var(--text-secondary)',
                              }}
                            >
                              {t.status}
                            </span>
                          </td>
                          <td className="mono" style={{ padding: '10px 12px', color: 'var(--color-cyan)' }}>
                            {t.waitSeconds != null ? `${Math.round(t.waitSeconds / 60)}m ${t.waitSeconds % 60}s` : '—'}
                          </td>
                          <td className="mono" style={{ padding: '10px 12px', color: 'var(--color-warning)' }}>
                            {t.serviceDurationSeconds != null
                              ? `${Math.round(t.serviceDurationSeconds / 60)}m ${t.serviceDurationSeconds % 60}s`
                              : '—'}
                          </td>
                          <td className="mono" style={{ padding: '10px 12px', color: 'var(--text-muted)' }}>
                            {t.createdAt ? new Date(t.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—'}
                          </td>
                          <td className="mono" style={{ padding: '10px 12px', color: 'var(--text-muted)' }}>
                            {t.completedAt ? new Date(t.completedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Pagination Controls */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '8px', marginTop: '16px' }}>
                  <button
                    disabled={historicalPage <= 1}
                    onClick={() => setHistoricalPage((p) => Math.max(1, p - 1))}
                    className="btn-secondary"
                    style={{ fontSize: '11px', padding: '6px 12px' }}
                  >
                    Previous
                  </button>
                  <span className="mono" style={{ fontSize: '12px', color: 'var(--text-secondary)', padding: '0 8px' }}>
                    Page {historicalPage} of {historicalData.pagination?.pages || 1}
                  </span>
                  <button
                    disabled={historicalPage >= (historicalData.pagination?.pages || 1)}
                    onClick={() => setHistoricalPage((p) => p + 1)}
                    className="btn-secondary"
                    style={{ fontSize: '11px', padding: '6px 12px' }}
                  >
                    Next
                  </button>
                </div>
              </div>
            </>
          ) : null}
        </>
      )}

      {/* ── TAB 3: FORECAST & STAFFING ML ────────────────────────── */}
      {activeTab === 'forecast' && (
        <>
          {/* Controls Bar */}
          <div
            style={{
              background: 'var(--bg-card-alt)',
              border: '1px solid var(--border-subtle)',
              borderRadius: '16px',
              padding: '16px 20px',
              display: 'flex',
              flexWrap: 'wrap',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '14px',
              marginBottom: '24px',
            }}
          >
            {/* Horizon Filter Buttons */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Clock size={15} color="var(--text-muted)" />
              <span style={{ fontSize: '12px', color: 'var(--text-secondary)', marginRight: '4px' }}>Forecast Horizon:</span>
              {[4, 6, 12, 24].map((hrs) => (
                <button
                  key={hrs}
                  onClick={() => setForecastHorizon(hrs)}
                  style={{
                    background: forecastHorizon === hrs ? 'color-mix(in srgb, var(--color-primary) 15%, transparent)' : 'var(--bg-card-alt)',
                    color: forecastHorizon === hrs ? 'var(--color-primary)' : 'var(--text-secondary)',
                    border: forecastHorizon === hrs ? '1px solid color-mix(in srgb, var(--color-primary) 30%, transparent)' : '1px solid transparent',
                    borderRadius: '8px',
                    padding: '6px 12px',
                    fontSize: '12px',
                    fontWeight: 700,
                    cursor: 'pointer',
                  }}
                >
                  {hrs}h
                </button>
              ))}
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <span
                className="mono"
                style={{
                  fontSize: '10px',
                  fontWeight: 700,
                  padding: '4px 8px',
                  borderRadius: '6px',
                  background: 'rgba(56, 189, 248, 0.15)',
                  color: 'var(--color-cyan)',
                  border: '1px solid rgba(56, 189, 248, 0.3)',
                }}
              >
                STRICTLY ADVISORY
              </span>
              <button
                onClick={() => fetchForecast(true)}
                disabled={forecastLoading}
                className="btn-secondary"
                style={{ fontSize: '11px', padding: '6px 12px', gap: '6px' }}
              >
                <RefreshCw size={12} className={forecastLoading ? 'animate-spin' : ''} />
                <span>Retrain / Refresh</span>
              </button>
            </div>
          </div>

          {forecastError && <ErrorMessage message={forecastError} onRetry={() => fetchForecast(true)} />}

          {forecastLoading && !forecastData ? (
            <LoadingSpinner message="Aggregating historical queue records & fitting ML model..." />
          ) : forecastData?.status === 'INSUFFICIENT_DATA' ? (
            <div
              style={{
                background: 'var(--bg-card-alt)',
                border: '1px solid color-mix(in srgb, var(--color-warning) 30%, transparent)',
                borderRadius: '16px',
                padding: '36px',
                textAlign: 'center',
                maxWidth: '680px',
                margin: '0 auto 30px auto',
              }}
            >
              <div
                style={{
                  width: '48px',
                  height: '48px',
                  borderRadius: '12px',
                  background: 'color-mix(in srgb, var(--color-warning) 15%, transparent)',
                  color: 'var(--color-warning)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  margin: '0 auto 16px auto',
                }}
              >
                <AlertTriangle size={24} />
              </div>
              <h3 style={{ fontSize: '17px', fontWeight: 800, color: 'var(--text-primary)', marginBottom: '8px' }}>
                Prediction Unavailable — Insufficient Historical Data
              </h3>
              <p style={{ fontSize: '13px', color: 'var(--text-secondary)', lineHeight: '1.6', marginBottom: '24px' }}>
                QueueFlow never generates fabricated or synthetic forecasts. Machine learning requires
                a minimum baseline of genuine queue traffic to derive statistical arrival patterns.
              </p>

              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
                  gap: '12px',
                  background: 'rgba(15, 23, 42, 0.6)',
                  borderRadius: '12px',
                  padding: '16px',
                  border: '1px solid var(--bg-card-alt)',
                  textAlign: 'left',
                }}
              >
                <div>
                  <span style={{ fontSize: '11px', color: 'var(--text-muted)', display: 'block' }}>Real Tokens Found</span>
                  <span className="mono" style={{ fontSize: '15px', fontWeight: 800, color: 'var(--text-primary)' }}>
                    {forecastData.sufficiency?.tokensFound || 0} / {forecastData.sufficiency?.tokensRequired || 10}
                  </span>
                </div>
                <div>
                  <span style={{ fontSize: '11px', color: 'var(--text-muted)', display: 'block' }}>Hourly Intervals</span>
                  <span className="mono" style={{ fontSize: '15px', fontWeight: 800, color: 'var(--text-primary)' }}>
                    {forecastData.sufficiency?.hourlyIntervalsFound || 0} / {forecastData.sufficiency?.hourlyIntervalsRequired || 5}
                  </span>
                </div>
                <div>
                  <span style={{ fontSize: '11px', color: 'var(--text-muted)', display: 'block' }}>History Window</span>
                  <span className="mono" style={{ fontSize: '15px', fontWeight: 800, color: 'var(--color-primary)' }}>
                    {forecastData.sufficiency?.historicalWindowDays || 14} days
                  </span>
                </div>
              </div>
            </div>
          ) : forecastData?.status === 'AVAILABLE' ? (
            <>
              {/* Model Provenance & Metadata Banner */}
              <div
                style={{
                  background: 'var(--bg-card-alt)',
                  border: '1px solid var(--border-subtle)',
                  borderRadius: '14px',
                  padding: '14px 18px',
                  display: 'flex',
                  flexWrap: 'wrap',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: '12px',
                  marginBottom: '20px',
                  fontSize: '12px',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <ShieldCheck size={16} color="var(--color-primary)" />
                    <span style={{ fontWeight: 700, color: 'var(--text-primary)' }}>
                      Model: {forecastData.modelMetadata?.modelType} ({forecastData.modelMetadata?.modelVersion})
                    </span>
                  </div>
                  <span style={{ color: 'var(--text-dim)' }}>•</span>
                  <span style={{ color: 'var(--text-secondary)' }}>
                    Trained on <strong style={{ color: 'var(--text-primary)' }}>{forecastData.modelMetadata?.trainingTokensCount}</strong> tokens across{' '}
                    <strong style={{ color: 'var(--text-primary)' }}>{forecastData.modelMetadata?.hourlyIntervalsAnalyzed}</strong> intervals ({forecastData.modelMetadata?.historicalWindowDays}d window)
                  </span>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
                  {forecastData.modelMetadata?.evaluationMetrics?.valMae != null && (
                    <span className="mono" style={{ fontSize: '11px', color: 'var(--color-cyan)' }}>
                      Val MAE: <strong>{forecastData.modelMetadata.evaluationMetrics.valMae}</strong>
                      {forecastData.modelMetadata.evaluationMetrics.baselineValMae != null && (
                        <span style={{ color: 'var(--text-muted)' }}> (baseline: {forecastData.modelMetadata.evaluationMetrics.baselineValMae})</span>
                      )}
                    </span>
                  )}
                  <span className="mono" style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                    Trained: {forecastData.modelMetadata?.trainedAt ? new Date(forecastData.modelMetadata.trainedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—'}
                  </span>
                </div>
              </div>

              {/* Timeline Grid */}
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
                  gap: '16px',
                  marginBottom: '24px',
                }}
              >
                {(forecastData.timeline || []).map((slot, idx) => {
                  const delta = slot.staffing?.staffingDelta || 0;
                  const isUnderstaffed = delta > 0;
                  const isOverstaffed = delta < 0;

                  return (
                    <div
                      key={idx}
                      style={{
                        background: 'var(--bg-card-alt)',
                        border: `1px solid ${isUnderstaffed ? 'color-mix(in srgb, var(--color-warning) 40%, transparent)' : 'var(--border-subtle)'}`,
                        borderRadius: '14px',
                        padding: '16px',
                        display: 'flex',
                        flexDirection: 'column',
                        justifyContent: 'space-between',
                      }}
                    >
                      <div>
                        {/* Time interval */}
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
                          <span className="mono" style={{ fontSize: '13px', fontWeight: 800, color: 'var(--text-primary)' }}>
                            {new Date(slot.intervalStart).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                          </span>
                          <span
                            className="mono"
                            style={{
                              fontSize: '10px',
                              fontWeight: 700,
                              padding: '2px 6px',
                              borderRadius: '4px',
                              background: isUnderstaffed
                                ? 'color-mix(in srgb, var(--color-warning) 20%, transparent)'
                                : isOverstaffed
                                ? 'rgba(56, 189, 248, 0.15)'
                                : 'color-mix(in srgb, var(--color-primary) 15%, transparent)',
                              color: isUnderstaffed ? 'var(--color-warning)' : isOverstaffed ? 'var(--color-cyan)' : 'var(--color-primary)',
                            }}
                          >
                            {isUnderstaffed
                              ? `+${delta} NEEDED`
                              : isOverstaffed
                              ? `${Math.abs(delta)} SURPLUS`
                              : 'BALANCED'}
                          </span>
                        </div>

                        {/* Forecast Hero Number */}
                        <div style={{ marginBottom: '14px' }}>
                          <span style={{ fontSize: '11px', color: 'var(--text-muted)', display: 'block' }}>Predicted Customer Arrivals</span>
                          <div style={{ display: 'flex', alignItems: 'baseline', gap: '6px', marginTop: '2px' }}>
                            <span style={{ fontSize: '24px', fontWeight: 900, color: 'var(--color-cyan)' }}>
                              ~{slot.predictedArrivals}
                            </span>
                            <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>tokens</span>
                          </div>
                        </div>

                        {/* Staffing Recommendation Breakdown */}
                        <div
                          style={{
                            background: 'rgba(15, 23, 42, 0.6)',
                            borderRadius: '10px',
                            padding: '10px 12px',
                            marginBottom: '10px',
                            border: '1px solid var(--bg-card-alt)',
                          }}
                        >
                          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
                            <span style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>Recommended Desks:</span>
                            <span className="mono" style={{ fontSize: '12px', fontWeight: 800, color: 'var(--color-primary)' }}>
                              {slot.staffing?.recommendedActiveCounters} active
                            </span>
                          </div>
                          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                            <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Currently Active:</span>
                            <span className="mono" style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)' }}>
                              {slot.staffing?.currentActiveCounters} active
                            </span>
                          </div>
                        </div>
                      </div>

                      {/* Workload Math Footnote */}
                      <div style={{ fontSize: '10px', color: 'var(--text-muted)', borderTop: '1px solid var(--bg-card-alt)', paddingTop: '8px' }}>
                        Workload ~{Math.round((slot.staffing?.estimatedWorkloadSeconds || 0) / 60)}m ({slot.staffing?.effectiveServiceSeconds}s handle time @ 85% util)
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          ) : null}
        </>
      )}
      {/* ── TAB 4: OPERATIONAL WORKLOAD & BALANCING (TIER 4 / FEATURE 5) ── */}
      {activeTab === 'workload' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
          {workloadLoading && !workloadOverview ? (
            <div style={{ padding: '60px 0', textAlign: 'center' }}>
              <LoadingSpinner />
              <p style={{ color: 'var(--text-secondary)', marginTop: '12px', fontSize: '13px' }}>
                Evaluating real-time operational workload metrics across center counters...
              </p>
            </div>
          ) : workloadError ? (
            <ErrorMessage message={workloadError} />
          ) : workloadOverview ? (
            <>
              {/* Top Operational Metrics Ribbon */}
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
                  gap: '16px',
                }}
              >
                <div className="q-card" style={{ padding: '20px' }}>
                  <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', marginBottom: '6px' }}>
                    Average Workload Score
                  </div>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px' }}>
                    <span style={{ fontSize: '28px', fontWeight: 800, color: 'var(--text-primary)', fontFamily: 'monospace' }}>
                      {workloadOverview.averageWorkloadScore ?? 0}
                    </span>
                    <span style={{ fontSize: '13px', color: 'var(--text-muted)' }}>/ 100</span>
                  </div>
                  <div style={{ fontSize: '11px', color: 'var(--color-primary)', marginTop: '6px' }}>
                    Max Center Score: {workloadOverview.maxWorkloadScore ?? 0}
                  </div>
                </div>

                <div className="q-card" style={{ padding: '20px' }}>
                  <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', marginBottom: '6px' }}>
                    Overloaded Units
                  </div>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px' }}>
                    <span style={{ fontSize: '28px', fontWeight: 800, color: (workloadOverview.overloadedUnits?.length || 0) > 0 ? 'var(--color-danger)' : 'var(--color-primary)', fontFamily: 'monospace' }}>
                      {workloadOverview.overloadedUnits?.length || 0}
                    </span>
                    <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>desks</span>
                  </div>
                  <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '6px' }}>
                    High or Sustained High load
                  </div>
                </div>

                <div className="q-card" style={{ padding: '20px' }}>
                  <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', marginBottom: '6px' }}>
                    Available Capacity
                  </div>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px' }}>
                    <span style={{ fontSize: '28px', fontWeight: 800, color: 'var(--color-primary)', fontFamily: 'monospace' }}>
                      {workloadOverview.availableCapacity?.length || 0}
                    </span>
                    <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>desks</span>
                  </div>
                  <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '6px' }}>
                    Operating at low workload
                  </div>
                </div>

                <div className="q-card" style={{ padding: '20px' }}>
                  <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', marginBottom: '6px' }}>
                    Active Operators
                  </div>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px' }}>
                    <span style={{ fontSize: '28px', fontWeight: 800, color: 'var(--text-primary)', fontFamily: 'monospace' }}>
                      {workloadOverview.activeOperatorsCount ?? 0}
                    </span>
                    <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>/ {workloadOverview.totalCountersCount ?? 0} total</span>
                  </div>
                  <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '6px' }}>
                    Status: {workloadOverview.dataSufficiency}
                  </div>
                </div>
              </div>

              {/* Workload Distribution Grid */}
              <div className="q-card" style={{ padding: '20px' }}>
                <h3 style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '14px' }}>
                  Center Operational Load Distribution
                </h3>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '12px' }}>
                  <div style={{ padding: '12px', borderRadius: '10px', background: 'color-mix(in srgb, var(--color-primary) 8%, transparent)', border: '1px solid color-mix(in srgb, var(--color-primary) 20%, transparent)' }}>
                    <div style={{ fontSize: '11px', color: 'var(--color-primary)', fontWeight: 700 }}>LOW LOAD (0-39)</div>
                    <div style={{ fontSize: '20px', fontWeight: 800, color: 'var(--text-primary)', margin: '4px 0' }}>
                      {workloadOverview.distribution?.LOW ?? 0}
                    </div>
                    <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Optimal capacity</div>
                  </div>

                  <div style={{ padding: '12px', borderRadius: '10px', background: 'color-mix(in srgb, var(--color-cyan) 8%, transparent)', border: '1px solid color-mix(in srgb, var(--color-cyan) 20%, transparent)' }}>
                    <div style={{ fontSize: '11px', color: 'var(--color-cyan)', fontWeight: 700 }}>MODERATE (40-69)</div>
                    <div style={{ fontSize: '20px', fontWeight: 800, color: 'var(--text-primary)', margin: '4px 0' }}>
                      {workloadOverview.distribution?.MODERATE ?? 0}
                    </div>
                    <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Balanced throughput</div>
                  </div>

                  <div style={{ padding: '12px', borderRadius: '10px', background: 'color-mix(in srgb, var(--color-warning) 8%, transparent)', border: '1px solid color-mix(in srgb, var(--color-warning) 20%, transparent)' }}>
                    <div style={{ fontSize: '11px', color: 'var(--color-warning)', fontWeight: 700 }}>HIGH (70-84)</div>
                    <div style={{ fontSize: '20px', fontWeight: 800, color: 'var(--text-primary)', margin: '4px 0' }}>
                      {workloadOverview.distribution?.HIGH ?? 0}
                    </div>
                    <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Heavy volume / queue</div>
                  </div>

                  <div style={{ padding: '12px', borderRadius: '10px', background: 'color-mix(in srgb, var(--color-danger) 8%, transparent)', border: '1px solid color-mix(in srgb, var(--color-danger) 20%, transparent)' }}>
                    <div style={{ fontSize: '11px', color: 'var(--color-danger)', fontWeight: 700 }}>SUSTAINED HIGH (85+)</div>
                    <div style={{ fontSize: '20px', fontWeight: 800, color: 'var(--text-primary)', margin: '4px 0' }}>
                      {workloadOverview.distribution?.SUSTAINED_HIGH ?? 0}
                    </div>
                    <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Requires supervisor rotation</div>
                  </div>
                </div>
              </div>

              {/* Advisory Balancing Recommendations */}
              <div className="q-card" style={{ padding: '24px' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
                  <div>
                    <h3 style={{ fontSize: '15px', fontWeight: 800, color: 'var(--text-primary)', margin: 0 }}>
                      Operational Balancing Recommendations
                    </h3>
                    <p style={{ fontSize: '12px', color: 'var(--text-secondary)', margin: '4px 0 0 0' }}>
                      Authoritative server-evaluated recommendations to redistribute operational load across compatible counters.
                    </p>
                  </div>
                  <span
                    style={{
                      fontSize: '11px',
                      fontWeight: 700,
                      padding: '3px 8px',
                      borderRadius: '8px',
                      background: 'color-mix(in srgb, var(--color-cyan) 15%, transparent)',
                      color: 'var(--color-cyan)',
                      border: '1px solid color-mix(in srgb, var(--color-cyan) 30%, transparent)',
                    }}
                  >
                    ADVISORY (NON-AUTOMATIC)
                  </span>
                </div>

                {!workloadRecommendations?.recommendations || workloadRecommendations.recommendations.length === 0 ? (
                  <div style={{ padding: '24px', textAlign: 'center', color: 'var(--text-muted)', background: 'var(--bg-card-alt)', borderRadius: '10px' }}>
                    <CheckCircle2 size={24} color="var(--color-primary)" style={{ marginBottom: '6px' }} />
                    <p style={{ margin: 0, fontSize: '13px', color: 'var(--text-secondary)' }}>
                      Current operational workload is balanced across all active units. No balancing adjustments recommended.
                    </p>
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                    {workloadRecommendations.recommendations.map((rec) => (
                      <div
                        key={rec.id}
                        style={{
                          padding: '16px 18px',
                          borderRadius: '12px',
                          background: 'rgba(15, 23, 42, 0.6)',
                          border: rec.priority === 'HIGH'
                            ? '1px solid color-mix(in srgb, var(--color-danger) 35%, transparent)'
                            : rec.priority === 'MEDIUM'
                            ? '1px solid color-mix(in srgb, var(--color-warning) 35%, transparent)'
                            : '1px solid var(--border-subtle)',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          gap: '16px',
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'flex-start', gap: '12px' }}>
                          <span
                            style={{
                              fontSize: '10px',
                              fontWeight: 800,
                              padding: '2px 8px',
                              borderRadius: '6px',
                              marginTop: '2px',
                              background: rec.priority === 'HIGH'
                                ? 'color-mix(in srgb, var(--color-danger) 20%, transparent)'
                                : rec.priority === 'MEDIUM'
                                ? 'color-mix(in srgb, var(--color-warning) 20%, transparent)'
                                : 'color-mix(in srgb, var(--color-cyan) 20%, transparent)',
                              color: rec.priority === 'HIGH'
                                ? 'var(--color-danger)'
                                : rec.priority === 'MEDIUM'
                                ? 'var(--color-warning)'
                                : 'var(--color-cyan)',
                            }}
                          >
                            {rec.type.replace('_', ' ')}
                          </span>
                          <div>
                            <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)', marginBottom: '3px' }}>
                              {rec.reason}
                            </div>
                            <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                              Generated at {new Date(rec.createdAt).toLocaleTimeString()} • Priority: {rec.priority}
                            </div>
                          </div>
                        </div>

                        {rec.type === 'MORPH_COUNTER' && rec.sourceCounterId && (
                          <button
                            onClick={() => {
                              const foundCounter = counters.find((c) => c._id === rec.sourceCounterId);
                              if (foundCounter) openMorphModal(foundCounter);
                            }}
                            className="btn-primary"
                            style={{ fontSize: '11px', padding: '6px 12px', whiteSpace: 'nowrap' }}
                          >
                            Morph Counter
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Operator & Counter Workload Table */}
              <div className="q-card" style={{ padding: '24px' }}>
                <h3 style={{ fontSize: '15px', fontWeight: 800, color: 'var(--text-primary)', marginBottom: '16px' }}>
                  Individual Counter & Operator Workload Breakdown
                </h3>

                {workloadOverview.operatorWorkloads?.length === 0 ? (
                  <div style={{ padding: '24px', textAlign: 'center', color: 'var(--text-muted)' }}>
                    No counters configured at this center.
                  </div>
                ) : (
                  <div style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
                      <thead>
                        <tr style={{ borderBottom: '1px solid var(--border-subtle)', textAlign: 'left', color: 'var(--text-secondary)' }}>
                          <th style={{ padding: '10px 12px' }}>COUNTER</th>
                          <th style={{ padding: '10px 12px' }}>OPERATOR</th>
                          <th style={{ padding: '10px 12px' }}>SERVICE</th>
                          <th style={{ padding: '10px 12px' }}>LOAD LEVEL</th>
                          <th style={{ padding: '10px 12px' }}>WORKLOAD SCORE</th>
                          <th style={{ padding: '10px 12px' }}>EXPLANATION</th>
                          <th style={{ padding: '10px 12px' }}>DATA STATE</th>
                        </tr>
                      </thead>
                      <tbody>
                        {workloadOverview.operatorWorkloads.map((op, idx) => (
                          <tr
                            key={op.counter?._id || idx}
                            style={{
                              borderBottom: '1px solid var(--bg-card-alt)',
                              background: op.loadLevel === 'SUSTAINED_HIGH' ? 'color-mix(in srgb, var(--color-danger) 4%, transparent)' : 'transparent',
                            }}
                          >
                            <td style={{ padding: '12px', fontWeight: 700, color: 'var(--text-primary)' }}>
                              {op.counter?.name || 'Counter'} (#{op.counter?.number ?? '—'})
                            </td>
                            <td style={{ padding: '12px', color: 'var(--text-primary)' }}>
                              {op.operator?.name || 'Unassigned'}
                            </td>
                            <td style={{ padding: '12px', color: 'var(--color-cyan)' }}>
                              {op.counter?.serviceName || 'None'}
                            </td>
                            <td style={{ padding: '12px' }}>
                              <span
                                style={{
                                  fontSize: '10px',
                                  fontWeight: 800,
                                  padding: '3px 8px',
                                  borderRadius: '6px',
                                  background: op.loadLevel === 'SUSTAINED_HIGH'
                                    ? 'color-mix(in srgb, var(--color-danger) 15%, transparent)'
                                    : op.loadLevel === 'HIGH'
                                    ? 'color-mix(in srgb, var(--color-warning) 15%, transparent)'
                                    : op.loadLevel === 'MODERATE'
                                    ? 'color-mix(in srgb, var(--color-cyan) 15%, transparent)'
                                    : 'color-mix(in srgb, var(--color-primary) 15%, transparent)',
                                  color: op.loadLevel === 'SUSTAINED_HIGH'
                                    ? 'var(--color-danger)'
                                    : op.loadLevel === 'HIGH'
                                    ? 'var(--color-warning)'
                                    : op.loadLevel === 'MODERATE'
                                    ? 'var(--color-cyan)'
                                    : 'var(--color-primary)',
                                }}
                              >
                                {op.loadLevel}
                              </span>
                            </td>
                            <td className="mono" style={{ padding: '12px', fontWeight: 800, fontSize: '14px', color: 'var(--text-primary)' }}>
                              {op.workloadScore != null ? `${op.workloadScore}/100` : '—'}
                            </td>
                            <td style={{ padding: '12px', color: 'var(--text-secondary)', maxWidth: '360px', lineHeight: '1.4' }}>
                              {op.explanation || '—'}
                            </td>
                            <td style={{ padding: '12px', color: 'var(--text-muted)' }}>
                              {op.dataSufficiency}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </>
          ) : (
            <div style={{ padding: '40px', textAlign: 'center', color: 'var(--text-muted)' }}>
              No operational workload data available for this center.
            </div>
          )}
        </div>
      )}
      {/* ── COUNTER MORPHING MODAL ────────────────────────── */}
      {morphModalOpen && selectedCounterForMorph && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0, 0, 0, 0.75)',
            backdropFilter: 'blur(6px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
            padding: '20px',
          }}
        >
          <div
            style={{
              background: 'var(--bg-card)',
              border: '1px solid var(--border-subtle)',
              borderRadius: '20px',
              maxWidth: '500px',
              width: '100%',
              padding: '24px 28px',
              boxShadow: '0 20px 60px rgba(0, 0, 0, 0.8)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '8px' }}>
              <div
                style={{
                  width: '36px',
                  height: '36px',
                  borderRadius: '10px',
                  background: 'color-mix(in srgb, var(--color-primary) 15%, transparent)',
                  color: 'var(--color-primary)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Shuffle size={18} />
              </div>
              <h2 style={{ fontSize: '18px', fontWeight: 800, color: 'var(--text-primary)' }}>
                Counter Morphing
              </h2>
            </div>

            <p style={{ fontSize: '13px', color: 'var(--text-secondary)', marginBottom: '20px' }}>
              Dynamically morph <strong style={{ color: 'var(--text-primary)' }}>{selectedCounterForMorph.name} (Desk #{selectedCounterForMorph.number})</strong> to serve a different active queue.
            </p>

            {/* Active Token Warning — Critical Safety */}
            {selectedCounterForMorph.currentToken && (
              <div
                style={{
                  background: 'color-mix(in srgb, var(--color-danger) 12%, transparent)',
                  border: '1px solid color-mix(in srgb, var(--color-danger) 30%, transparent)',
                  borderRadius: '12px',
                  padding: '12px 16px',
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: '10px',
                  marginBottom: '18px',
                  color: 'var(--color-danger)',
                  fontSize: '12px',
                }}
              >
                <AlertTriangle size={18} style={{ flexShrink: 0, marginTop: '2px' }} color="var(--color-danger)" />
                <div>
                  <strong style={{ color: 'var(--color-danger)', display: 'block', marginBottom: '2px' }}>
                    Active Customer Present
                  </strong>
                  Desk is currently handling token <strong>{selectedCounterForMorph.currentToken.tokenCode}</strong> ({selectedCounterForMorph.currentToken.status}). Complete or skip this token before reassigning services.
                </div>
              </div>
            )}

            {morphError && <ErrorMessage message={morphError} />}
            {morphSuccess && (
              <div
                style={{
                  background: 'color-mix(in srgb, var(--color-primary) 15%, transparent)',
                  border: '1px solid color-mix(in srgb, var(--color-primary) 30%, transparent)',
                  borderRadius: '10px',
                  padding: '10px 14px',
                  color: 'var(--color-primary)',
                  fontSize: '13px',
                  fontWeight: 600,
                  marginBottom: '16px',
                }}
              >
                {morphSuccess}
              </div>
            )}

            <form onSubmit={handleMorphSubmit}>
              {/* Service Selection */}
              <div style={{ marginBottom: '16px' }}>
                <label style={{ display: 'block', fontSize: '12px', fontWeight: 700, color: 'var(--text-secondary)', marginBottom: '6px' }}>
                  Target Service
                </label>
                <select
                  value={targetServiceId}
                  onChange={(e) => setTargetServiceId(e.target.value)}
                  style={{
                    width: '100%',
                    background: 'rgba(15, 23, 42, 0.8)',
                    border: '1px solid var(--border-subtle)',
                    color: 'var(--text-primary)',
                    borderRadius: '10px',
                    padding: '10px 14px',
                    fontSize: '13px',
                    fontWeight: 600,
                    outline: 'none',
                  }}
                >
                  <option value="">— Unassign Service —</option>
                  {services.map((svc) => (
                    <option key={svc.serviceId} value={svc.serviceId}>
                      [{svc.tokenPrefix}] {svc.name}
                    </option>
                  ))}
                </select>
              </div>

              {/* Reassignment Reason */}
              <div style={{ marginBottom: '20px' }}>
                <label style={{ display: 'block', fontSize: '12px', fontWeight: 700, color: 'var(--text-secondary)', marginBottom: '6px' }}>
                  Reason for Morph (Audit Log)
                </label>
                <input
                  type="text"
                  value={morphReason}
                  onChange={(e) => setMorphReason(e.target.value)}
                  placeholder="e.g. Surge mitigation, peak hour load rebalance"
                  style={{
                    width: '100%',
                    background: 'rgba(15, 23, 42, 0.8)',
                    border: '1px solid var(--border-subtle)',
                    color: 'var(--text-primary)',
                    borderRadius: '10px',
                    padding: '10px 14px',
                    fontSize: '13px',
                    outline: 'none',
                  }}
                />
              </div>

              {/* Modal Buttons */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '10px' }}>
                <button
                  type="button"
                  onClick={() => setMorphModalOpen(false)}
                  disabled={morphLoading}
                  className="btn-secondary"
                  style={{ fontSize: '13px', padding: '9px 18px' }}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={morphLoading || Boolean(selectedCounterForMorph.currentToken)}
                  style={{
                    background: selectedCounterForMorph.currentToken
                      ? 'color-mix(in srgb, var(--text-secondary) 20%, transparent)'
                      : 'var(--color-primary)',
                    color: selectedCounterForMorph.currentToken ? 'var(--text-muted)' : 'var(--bg-app)',
                    border: 'none',
                    borderRadius: '10px',
                    padding: '9px 20px',
                    fontSize: '13px',
                    fontWeight: 800,
                    cursor: selectedCounterForMorph.currentToken ? 'not-allowed' : 'pointer',
                    boxShadow: selectedCounterForMorph.currentToken ? 'none' : '',
                  }}
                >
                  {morphLoading ? 'Morphing...' : 'Confirm Morph'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── Assign / Reassign Operator Modal ─────────────────── */}
      {assignModalOpen && selectedCounterForAssign && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0, 0, 0, 0.75)',
            backdropFilter: 'blur(6px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
            padding: '20px',
          }}
          onClick={() => !assignLoading && setAssignModalOpen(false)}
        >
          <div
            style={{
              background: 'var(--bg-card)',
              border: '1px solid var(--border-subtle)',
              borderRadius: '20px',
              padding: '28px',
              width: '100%',
              maxWidth: '480px',
              boxShadow: '0 20px 40px rgba(0, 0, 0, 0.5)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '20px' }}>
              <div>
                <h3 style={{ fontSize: '18px', fontWeight: 800, color: 'var(--text-primary)', marginBottom: '4px' }}>
                  Assign Desk Operator
                </h3>
                <span className="mono" style={{ fontSize: '12px', color: 'var(--color-cyan)', fontWeight: 700 }}>
                  DESK #{selectedCounterForAssign.number} — {selectedCounterForAssign.name}
                </span>
              </div>
              <button
                type="button"
                onClick={() => setAssignModalOpen(false)}
                disabled={assignLoading}
                style={{
                  background: 'none',
                  border: 'none',
                  color: 'var(--text-muted)',
                  cursor: 'pointer',
                  padding: '4px',
                  borderRadius: '6px',
                }}
              >
                <X size={18} />
              </button>
            </div>

            {/* Current Allocation State */}
            <div
              style={{
                background: 'rgba(15, 23, 42, 0.5)',
                border: '1px solid var(--border-subtle)',
                borderRadius: '12px',
                padding: '12px 14px',
                marginBottom: '20px',
                fontSize: '12px',
              }}
            >
              <div style={{ color: 'var(--text-muted)', marginBottom: '4px' }}>Current Desk Staffing</div>
              <div style={{ fontWeight: 700, color: 'var(--text-primary)' }}>
                {selectedCounterForAssign.staff
                  ? `${selectedCounterForAssign.staff.name} (${selectedCounterForAssign.staff.email})`
                  : 'Currently Unassigned'}
              </div>
            </div>

            {assignError && <ErrorMessage message={assignError} />}
            {assignSuccess && (
              <div
                style={{
                  background: 'color-mix(in srgb, var(--color-primary) 15%, transparent)',
                  border: '1px solid color-mix(in srgb, var(--color-primary) 30%, transparent)',
                  borderRadius: '10px',
                  padding: '10px 14px',
                  color: 'var(--color-primary)',
                  fontSize: '13px',
                  fontWeight: 600,
                  marginBottom: '16px',
                }}
              >
                {assignSuccess}
              </div>
            )}

            <form onSubmit={handleAssignSubmit}>
              {/* Operator Selection */}
              <div style={{ marginBottom: '20px' }}>
                <label style={{ display: 'block', fontSize: '12px', fontWeight: 700, color: 'var(--text-secondary)', marginBottom: '8px' }}>
                  Select Facility Operator
                </label>
                <select
                  value={targetStaffId}
                  onChange={(e) => setTargetStaffId(e.target.value)}
                  style={{
                    width: '100%',
                    background: 'rgba(15, 23, 42, 0.8)',
                    border: '1px solid var(--border-subtle)',
                    color: 'var(--text-primary)',
                    borderRadius: '10px',
                    padding: '11px 14px',
                    fontSize: '13px',
                    fontWeight: 600,
                    outline: 'none',
                  }}
                >
                  <option value="">— Unassign Staff (Vacate Desk) —</option>
                  {operators.map((op) => {
                    const isCurrentForThisCounter = selectedCounterForAssign.staffId === op._id || selectedCounterForAssign.staff?._id === op._id;
                    const isAssignedElsewhere = op.isAssigned && !isCurrentForThisCounter;
                    const suffix = isCurrentForThisCounter
                      ? ' (Currently Assigned Here)'
                      : isAssignedElsewhere
                      ? ` (At Desk #${op.assignedCounter?.number || '?'})`
                      : ' (Available)';

                    return (
                      <option key={op._id} value={op._id}>
                        {op.name} — {op.email}{suffix}
                      </option>
                    );
                  })}
                </select>
                <span style={{ display: 'block', fontSize: '11px', color: 'var(--text-muted)', marginTop: '6px' }}>
                  If you choose an operator assigned to another desk, they will be automatically reassigned to this desk.
                </span>
              </div>

              {/* Modal Buttons */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '10px' }}>
                <button
                  type="button"
                  onClick={() => setAssignModalOpen(false)}
                  disabled={assignLoading}
                  className="btn-secondary"
                  style={{ fontSize: '13px', padding: '9px 18px' }}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={assignLoading}
                  style={{
                    background: 'var(--color-primary)',
                    color: 'var(--bg-app)',
                    border: 'none',
                    borderRadius: '10px',
                    padding: '9px 20px',
                    fontSize: '13px',
                    fontWeight: 800,
                    cursor: assignLoading ? 'not-allowed' : 'pointer',
                  }}
                >
                  {assignLoading ? 'Saving...' : 'Confirm Assignment'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
