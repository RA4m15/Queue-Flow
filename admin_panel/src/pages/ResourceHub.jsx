import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useSocket } from '../context/SocketContext';
import { useAuth } from '../context/AuthContext';
import { serviceCenterAPI, counterAPI, analyticsAPI, serviceAPI } from '../services/api';
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

  // Tier 3 / Feature 1: context-aware EWT explainability (backend-computed only)
  const [ewtData, setEwtData] = useState(null);
  const [ewtError, setEwtError] = useState(null);

  // Tier 3 / Feature 2: ML Footfall & Staffing Predictor
  const [forecastData, setForecastData] = useState(null);
  const [forecastLoading, setForecastLoading] = useState(false);
  const [forecastError, setForecastError] = useState(null);
  const [forecastHorizon, setForecastHorizon] = useState(6);

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

  // 1. Fetch available centers on mount
  useEffect(() => {
    let mounted = true;
    serviceCenterAPI
      .list()
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

  useEffect(() => {
    if (selectedCenterId) {
      if (activeTab === 'overview') {
        fetchOverview();
      } else if (activeTab === 'historical') {
        fetchHistorical();
      } else if (activeTab === 'forecast') {
        fetchForecast();
      }
    }
  }, [selectedCenterId, activeTab, fetchOverview, fetchHistorical, fetchForecast]);

  // EWT explainability is admin-only; a 403/401 simply hides the panel.
  useEffect(() => {
    if (selectedCenterId && isAdmin) {
      fetchEwt();
    } else {
      setEwtData(null);
    }
  }, [selectedCenterId, isAdmin, fetchEwt]);

  // 4. Real-time Socket.IO Listeners
  useEffect(() => {
    if (!socket || !selectedCenterId) return;

    const handleCounterEvent = () => {
      fetchOverview();
      if (isAdmin) fetchEwt();
    };

    const handleQueueEvent = () => {
      fetchOverview();
      if (isAdmin) fetchEwt();
    };

    socket.on('counter.updated', handleCounterEvent);
    socket.on('counter.morphed', handleCounterEvent);
    socket.on('queue.updated', handleQueueEvent);
    socket.on('token.called', handleQueueEvent);
    socket.on('token.serving', handleQueueEvent);
    socket.on('token.completed', handleQueueEvent);
    socket.on('token.skipped', handleQueueEvent);

    return () => {
      socket.off('counter.updated', handleCounterEvent);
      socket.off('counter.morphed', handleCounterEvent);
      socket.off('queue.updated', handleQueueEvent);
      socket.off('token.called', handleQueueEvent);
      socket.off('token.serving', handleQueueEvent);
      socket.off('token.completed', handleQueueEvent);
      socket.off('token.skipped', handleQueueEvent);
    };
  }, [socket, selectedCenterId, fetchOverview, fetchEwt, isAdmin]);

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
            <h1 style={{ fontSize: '22px', fontWeight: 800, color: '#F8FAFC', letterSpacing: '-0.02em' }}>
              Centralized Resource Hub
            </h1>
            <span
              className="mono"
              style={{
                fontSize: '10px',
                fontWeight: 700,
                padding: '2px 8px',
                borderRadius: '6px',
                background: 'rgba(0, 229, 168, 0.12)',
                color: '#00E5A8',
                border: '1px solid rgba(0, 229, 168, 0.3)',
              }}
            >
              TIER 2 OPERATIONS
            </span>
          </div>
          <p style={{ fontSize: '13px', color: '#94A3B8', marginTop: '3px' }}>
            Multi-counter telemetry, dynamic counter morphing, and authoritative SLA audit reporting
          </p>
        </div>

        {/* Center Selector & Tab Switcher */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Building2 size={16} color="#64748B" />
            <select
              value={selectedCenterId}
              onChange={handleCenterChange}
              style={{
                background: 'rgba(17, 27, 44, 0.8)',
                border: '1px solid var(--border-subtle)',
                color: '#F8FAFC',
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
                background: activeTab === 'overview' ? 'rgba(0, 229, 168, 0.15)' : 'transparent',
                color: activeTab === 'overview' ? '#00E5A8' : '#94A3B8',
                border: activeTab === 'overview' ? '1px solid rgba(0, 229, 168, 0.3)' : '1px solid transparent',
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
                background: activeTab === 'historical' ? 'rgba(0, 229, 168, 0.15)' : 'transparent',
                color: activeTab === 'historical' ? '#00E5A8' : '#94A3B8',
                border: activeTab === 'historical' ? '1px solid rgba(0, 229, 168, 0.3)' : '1px solid transparent',
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
                background: activeTab === 'forecast' ? 'rgba(0, 229, 168, 0.15)' : 'transparent',
                color: activeTab === 'forecast' ? '#00E5A8' : '#94A3B8',
                border: activeTab === 'forecast' ? '1px solid rgba(0, 229, 168, 0.3)' : '1px solid transparent',
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
          </div>

          <button
            onClick={activeTab === 'overview' ? fetchOverview : activeTab === 'historical' ? fetchHistorical : () => fetchForecast(true)}
            disabled={overviewLoading || historicalLoading || forecastLoading}
            className="btn-secondary"
            style={{ fontSize: '12px', padding: '8px 14px', gap: '6px' }}
          >
            <RefreshCw size={13} className={overviewLoading || historicalLoading || forecastLoading ? 'animate-spin' : ''} />
            <span>Sync</span>
          </button>
        </div>
      </div>

      {/* ── Center Status Ribbon ────────────────────────── */}
      {centerInfo && (
        <div
          style={{
            background: 'linear-gradient(90deg, rgba(17, 27, 44, 0.7) 0%, rgba(13, 20, 34, 0.7) 100%)',
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
                background: 'rgba(0, 229, 168, 0.12)',
                border: '1px solid rgba(0, 229, 168, 0.25)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#00E5A8',
              }}
            >
              <Building2 size={22} />
            </div>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{ fontSize: '16px', fontWeight: 800, color: '#F8FAFC' }}>
                  {centerInfo.name}
                </span>
                <span
                  className="mono"
                  style={{
                    fontSize: '11px',
                    fontWeight: 700,
                    padding: '2px 8px',
                    borderRadius: '6px',
                    background: centerInfo.isOpen ? 'rgba(0, 229, 168, 0.15)' : 'rgba(239, 68, 68, 0.15)',
                    color: centerInfo.isOpen ? '#00E5A8' : '#EF4444',
                    border: `1px solid ${centerInfo.isOpen ? 'rgba(0, 229, 168, 0.3)' : 'rgba(239, 68, 68, 0.3)'}`,
                  }}
                >
                  {centerInfo.isOpen ? 'OPEN' : 'CLOSED'}
                </span>
              </div>
              <p className="mono" style={{ fontSize: '11px', color: '#64748B', marginTop: '2px' }}>
                CODE: {centerInfo.code} • FACILITY TYPE: {centerInfo.type} • CAPACITY: {centerInfo.capacity}
              </p>
            </div>
          </div>

          {/* Crowd & Telemetry Status */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '20px' }}>
            <div>
              <span style={{ fontSize: '11px', color: '#64748B', display: 'block' }}>Live Crowd</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '2px' }}>
                <span style={{ fontSize: '15px', fontWeight: 800, color: '#F8FAFC' }}>
                  {centerInfo.currentCrowd || 0} / {centerInfo.capacity}
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
                        ? 'rgba(239, 68, 68, 0.2)'
                        : centerInfo.crowdStatus === 'MODERATE'
                        ? 'rgba(245, 158, 11, 0.2)'
                        : 'rgba(0, 229, 168, 0.2)',
                    color:
                      centerInfo.crowdStatus === 'HIGH'
                        ? '#EF4444'
                        : centerInfo.crowdStatus === 'MODERATE'
                        ? '#F59E0B'
                        : '#00E5A8',
                  }}
                >
                  {centerInfo.crowdStatus || 'LOW'} ({centerInfo.crowdPercent || 0}%)
                </span>
              </div>
            </div>

            <div style={{ borderLeft: '1px solid var(--border-subtle)', paddingLeft: '20px' }}>
              <span style={{ fontSize: '11px', color: '#64748B', display: 'block' }}>Telemetry Mesh</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '4px' }}>
                <span
                  style={{
                    width: '8px',
                    height: '8px',
                    borderRadius: '50%',
                    background: isConnected ? '#00E5A8' : '#F59E0B',
                    boxShadow: isConnected ? '0 0 10px #00E5A8' : 'none',
                  }}
                />
                <span className="mono" style={{ fontSize: '12px', fontWeight: 700, color: isConnected ? '#00E5A8' : '#F59E0B' }}>
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
                  <span className="stat-pill-val" style={{ color: '#F8FAFC', marginTop: '4px' }}>
                    {metrics.totalCounters || 0}
                  </span>
                  <span style={{ fontSize: '11px', color: '#64748B', marginTop: '2px' }}>
                    {metrics.activeCounters || 0} Active • {metrics.closedCounters || 0} Closed
                  </span>
                </div>

                <div className="stat-pill" style={{ padding: '16px 20px', alignItems: 'flex-start' }}>
                  <span className="stat-pill-label">Active / Serving</span>
                  <span className="stat-pill-val" style={{ color: '#00E5A8', marginTop: '4px' }}>
                    {metrics.servingCounters || 0}
                  </span>
                  <span style={{ fontSize: '11px', color: '#64748B', marginTop: '2px' }}>
                    {metrics.calledCounters || 0} Called tokens
                  </span>
                </div>

                <div className="stat-pill" style={{ padding: '16px 20px', alignItems: 'flex-start' }}>
                  <span className="stat-pill-label">Idle Counters</span>
                  <span className="stat-pill-val" style={{ color: '#38BDF8', marginTop: '4px' }}>
                    {metrics.idleCounters || 0}
                  </span>
                  <span style={{ fontSize: '11px', color: '#64748B', marginTop: '2px' }}>
                    Ready for next customer
                  </span>
                </div>

                <div className="stat-pill" style={{ padding: '16px 20px', alignItems: 'flex-start' }}>
                  <span className="stat-pill-label">On Break</span>
                  <span className="stat-pill-val" style={{ color: '#F59E0B', marginTop: '4px' }}>
                    {metrics.breakCounters || 0}
                  </span>
                  <span style={{ fontSize: '11px', color: '#64748B', marginTop: '2px' }}>
                    Temporary teller pause
                  </span>
                </div>

                <div className="stat-pill" style={{ padding: '16px 20px', alignItems: 'flex-start' }}>
                  <span className="stat-pill-label">Waiting Queue</span>
                  <span className="stat-pill-val" style={{ color: '#EC4899', marginTop: '4px' }}>
                    {metrics.totalWaiting || 0}
                  </span>
                  <span style={{ fontSize: '11px', color: '#64748B', marginTop: '2px' }}>
                    Avg wait ~{metrics.avgWaitMinutes || 0} min
                  </span>
                </div>
              </div>

              {/* ── Counter Heat Grid ────────────────────────── */}
              <div style={{ marginBottom: '32px' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '14px' }}>
                  <h2 style={{ fontSize: '16px', fontWeight: 800, color: '#F8FAFC', letterSpacing: '-0.01em' }}>
                    Live Center Counter Matrix
                  </h2>
                  <span style={{ fontSize: '12px', color: '#64748B' }}>
                    Real-time visual state across all physical desks
                  </span>
                </div>

                {counters.length === 0 ? (
                  <div
                    style={{
                      background: 'rgba(17, 27, 44, 0.4)',
                      border: '1px dashed var(--border-subtle)',
                      borderRadius: '16px',
                      padding: '40px',
                      textAlign: 'center',
                      color: '#64748B',
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
                        ? 'rgba(0, 229, 168, 0.4)'
                        : isCalled
                        ? 'rgba(56, 189, 248, 0.4)'
                        : isBreak
                        ? 'rgba(245, 158, 11, 0.4)'
                        : isClosed
                        ? 'rgba(239, 68, 68, 0.2)'
                        : 'var(--border-subtle)';

                      return (
                        <div
                          key={c._id}
                          style={{
                            background: 'rgba(17, 27, 44, 0.65)',
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
                                    color: '#F8FAFC',
                                    padding: '3px 8px',
                                    borderRadius: '6px',
                                    background: 'rgba(255, 255, 255, 0.08)',
                                  }}
                                >
                                  DESK #{c.number}
                                </span>
                                <span style={{ fontSize: '13px', fontWeight: 700, color: '#E2E8F0' }}>
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
                                    ? 'rgba(0, 229, 168, 0.15)'
                                    : isCalled
                                    ? 'rgba(56, 189, 248, 0.15)'
                                    : isBreak
                                    ? 'rgba(245, 158, 11, 0.15)'
                                    : isClosed
                                    ? 'rgba(239, 68, 68, 0.15)'
                                    : 'rgba(148, 163, 184, 0.15)',
                                  color: isServing
                                    ? '#00E5A8'
                                    : isCalled
                                    ? '#38BDF8'
                                    : isBreak
                                    ? '#F59E0B'
                                    : isClosed
                                    ? '#EF4444'
                                    : '#94A3B8',
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
                              <span style={{ fontSize: '11px', color: '#64748B', display: 'block', marginBottom: '3px' }}>
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
                                      color: '#38BDF8',
                                    }}
                                  >
                                    [{c.service.tokenPrefix}]
                                  </span>
                                  <span style={{ fontSize: '13px', fontWeight: 600, color: '#F1F5F9' }}>
                                    {c.service.name}
                                  </span>
                                </div>
                              ) : (
                                <span style={{ fontSize: '12px', fontStyle: 'italic', color: '#64748B' }}>
                                  Unassigned
                                </span>
                              )}
                            </div>

                            {/* Operator Assignment */}
                            <div style={{ marginBottom: '14px' }}>
                              <span style={{ fontSize: '11px', color: '#64748B', display: 'block', marginBottom: '2px' }}>
                                Operator
                              </span>
                              <span style={{ fontSize: '12px', fontWeight: 500, color: c.staff ? '#94A3B8' : '#475569' }}>
                                {c.staff ? `${c.staff.name} (${c.staff.email})` : 'No staff currently assigned'}
                              </span>
                            </div>

                            {/* Current Token Hero Display */}
                            <div
                              style={{
                                background: c.currentToken
                                  ? isServing
                                    ? 'rgba(0, 229, 168, 0.08)'
                                    : 'rgba(56, 189, 248, 0.08)'
                                  : 'rgba(15, 23, 42, 0.4)',
                                border: `1px solid ${c.currentToken ? borderColor : 'rgba(255, 255, 255, 0.05)'}`,
                                borderRadius: '12px',
                                padding: '12px 14px',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'space-between',
                                marginBottom: '14px',
                              }}
                            >
                              <div>
                                <span style={{ fontSize: '10px', color: '#64748B', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                                  {c.currentToken ? (isServing ? 'Serving Token' : 'Called Token') : 'Desk Status'}
                                </span>
                                <div style={{ fontSize: '18px', fontWeight: 900, color: c.currentToken ? '#F8FAFC' : '#475569', letterSpacing: '0.02em', marginTop: '2px' }}>
                                  {c.currentToken ? c.currentToken.tokenCode : 'Waiting for call'}
                                </div>
                              </div>

                              {c.currentToken && (
                                <div style={{ textAlign: 'right' }}>
                                  <span style={{ fontSize: '10px', color: '#64748B' }}>Active Elapsed</span>
                                  <div className="mono" style={{ fontSize: '12px', fontWeight: 700, color: '#38BDF8', marginTop: '2px' }}>
                                    {Math.floor((c.servingElapsedSeconds || 0) / 60)}m {(c.servingElapsedSeconds || 0) % 60}s
                                  </div>
                                </div>
                              )}
                            </div>
                          </div>

                          {/* Action Button: Counter Morphing */}
                          {isAdmin && (
                            <button
                              onClick={() => openMorphModal(c)}
                              style={{
                                width: '100%',
                                background: 'rgba(255, 255, 255, 0.06)',
                                border: '1px solid rgba(255, 255, 255, 0.1)',
                                borderRadius: '8px',
                                padding: '8px 12px',
                                color: '#E2E8F0',
                                fontSize: '12px',
                                fontWeight: 700,
                                cursor: 'pointer',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                gap: '6px',
                                transition: 'all 0.15s ease',
                              }}
                              onMouseOver={(e) => {
                                e.currentTarget.style.background = 'rgba(0, 229, 168, 0.15)';
                                e.currentTarget.style.color = '#00E5A8';
                                e.currentTarget.style.borderColor = 'rgba(0, 229, 168, 0.3)';
                              }}
                              onMouseOut={(e) => {
                                e.currentTarget.style.background = 'rgba(255, 255, 255, 0.06)';
                                e.currentTarget.style.color = '#E2E8F0';
                                e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.1)';
                              }}
                            >
                              <Shuffle size={13} />
                              <span>Morph Counter Service</span>
                            </button>
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
                    background: 'rgba(17, 27, 44, 0.6)',
                    border: '1px solid var(--border-subtle)',
                    borderRadius: '16px',
                    padding: '20px',
                  }}
                >
                  <h3 style={{ fontSize: '15px', fontWeight: 800, color: '#F8FAFC', marginBottom: '4px' }}>
                    Active Services Queue Depth
                  </h3>
                  <p style={{ fontSize: '11px', color: '#64748B', marginBottom: '14px' }}>
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
                          border: '1px solid rgba(255, 255, 255, 0.05)',
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
                              background: 'rgba(0, 229, 168, 0.15)',
                              color: '#00E5A8',
                            }}
                          >
                            [{svc.tokenPrefix}]
                          </span>
                          <span style={{ fontSize: '13px', fontWeight: 600, color: '#F1F5F9' }}>
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
                                  ? 'rgba(251, 191, 36, 0.15)'
                                  : 'rgba(255, 255, 255, 0.07)',
                                color: ewt.context?.fallbackUsed ? '#FBBF24' : '#94A3B8',
                                cursor: 'help',
                              }}
                            >
                              {ewtBadge(ewt)}
                            </span>
                          )}
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
                          <div style={{ textAlign: 'right' }}>
                            <span style={{ fontSize: '10px', color: '#64748B' }}>Waiting</span>
                            <div className="mono" style={{ fontSize: '14px', fontWeight: 800, color: '#EC4899' }}>
                              {svc.waitingCount}
                            </div>
                          </div>
                          <div style={{ textAlign: 'right' }}>
                            <span style={{ fontSize: '10px', color: '#64748B' }}>Serving</span>
                            <div className="mono" style={{ fontSize: '14px', fontWeight: 800, color: '#00E5A8' }}>
                              {svc.servingCount}
                            </div>
                          </div>
                          <div style={{ textAlign: 'right' }}>
                            <span style={{ fontSize: '10px', color: '#64748B' }}>Est. Wait</span>
                            <div
                              className="mono"
                              style={{ fontSize: '14px', fontWeight: 800, color: '#38BDF8' }}
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
                      <span style={{ fontSize: '11px', color: '#FBBF24' }}>{ewtError}</span>
                    )}
                  </div>
                </div>

                {/* Recent Operational Events / Audit Trail */}
                <div
                  style={{
                    background: 'rgba(17, 27, 44, 0.6)',
                    border: '1px solid var(--border-subtle)',
                    borderRadius: '16px',
                    padding: '20px',
                  }}
                >
                  <h3 style={{ fontSize: '15px', fontWeight: 800, color: '#F8FAFC', marginBottom: '14px' }}>
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
                              background: ev.eventType === 'COUNTER_MORPHED' ? 'rgba(168, 85, 247, 0.2)' : 'rgba(255, 255, 255, 0.08)',
                              color: ev.eventType === 'COUNTER_MORPHED' ? '#C084FC' : '#94A3B8',
                            }}
                          >
                            {ev.eventType}
                          </span>
                          <span style={{ color: '#E2E8F0' }}>
                            {ev.metadata?.counterName ? `${ev.metadata.counterName} • ` : ''}
                            {ev.metadata?.newServiceName ? `Reassigned to ${ev.metadata.newServiceName}` : ev.metadata?.status || ''}
                          </span>
                        </div>
                        <span className="mono" style={{ color: '#64748B' }}>
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
              background: 'rgba(17, 27, 44, 0.6)',
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
              <Calendar size={15} color="#64748B" />
              {['today', '7d', '30d'].map((range) => (
                <button
                  key={range}
                  onClick={() => {
                    setTimeRange(range);
                    setHistoricalPage(1);
                  }}
                  style={{
                    background: timeRange === range ? 'rgba(0, 229, 168, 0.15)' : 'rgba(255, 255, 255, 0.05)',
                    color: timeRange === range ? '#00E5A8' : '#94A3B8',
                    border: timeRange === range ? '1px solid rgba(0, 229, 168, 0.3)' : '1px solid transparent',
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
                <span style={{ fontSize: '12px', color: '#94A3B8' }}>SLA Target Wait:</span>
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
                    color: '#F8FAFC',
                    borderRadius: '8px',
                    padding: '6px 10px',
                    fontSize: '12px',
                    fontWeight: 700,
                    textAlign: 'center',
                  }}
                />
                <span style={{ fontSize: '12px', color: '#64748B' }}>min</span>
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
                  background: 'rgba(0, 229, 168, 0.12)',
                  border: '1px solid rgba(0, 229, 168, 0.3)',
                  borderRadius: '8px',
                  color: '#00E5A8',
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
                  <span className="stat-pill-val" style={{ color: '#F8FAFC', marginTop: '4px' }}>
                    {historicalData.summary?.totalIssued || 0}
                  </span>
                  <span style={{ fontSize: '11px', color: '#64748B', marginTop: '2px' }}>
                    Completion Rate: {historicalData.summary?.completionRate || 0}%
                  </span>
                </div>

                <div className="stat-pill" style={{ padding: '16px 20px', alignItems: 'flex-start' }}>
                  <span className="stat-pill-label">Completed Services</span>
                  <span className="stat-pill-val" style={{ color: '#00E5A8', marginTop: '4px' }}>
                    {historicalData.summary?.totalCompleted || 0}
                  </span>
                  <span style={{ fontSize: '11px', color: '#64748B', marginTop: '2px' }}>
                    {historicalData.summary?.totalSkipped || 0} Skipped • {historicalData.summary?.totalCancelled || 0} Cancelled
                  </span>
                </div>

                <div className="stat-pill" style={{ padding: '16px 20px', alignItems: 'flex-start' }}>
                  <span className="stat-pill-label">Average Wait Time</span>
                  <span className="stat-pill-val" style={{ color: '#38BDF8', marginTop: '4px' }}>
                    {historicalData.timing?.avgWaitSeconds != null
                      ? `${Math.round(historicalData.timing.avgWaitSeconds / 60)} min`
                      : 'N/A'}
                  </span>
                  <span style={{ fontSize: '11px', color: '#64748B', marginTop: '2px' }}>
                    Min: {historicalData.timing?.minWaitSeconds != null ? `${Math.round(historicalData.timing.minWaitSeconds / 60)}m` : '0m'} • Max: {historicalData.timing?.maxWaitSeconds != null ? `${Math.round(historicalData.timing.maxWaitSeconds / 60)}m` : '0m'}
                  </span>
                </div>

                <div className="stat-pill" style={{ padding: '16px 20px', alignItems: 'flex-start' }}>
                  <span className="stat-pill-label">Average Service Duration</span>
                  <span className="stat-pill-val" style={{ color: '#F59E0B', marginTop: '4px' }}>
                    {historicalData.timing?.avgServiceSeconds != null
                      ? `${(historicalData.timing.avgServiceSeconds / 60).toFixed(1)} min`
                      : 'N/A'}
                  </span>
                  <span style={{ fontSize: '11px', color: '#64748B', marginTop: '2px' }}>
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
                        ? '1px solid rgba(0, 229, 168, 0.3)'
                        : '1px solid var(--border-subtle)',
                  }}
                >
                  <span className="stat-pill-label">SLA Compliance</span>
                  {historicalData.sla?.status === 'CONFIGURED' ? (
                    <>
                      <span className="stat-pill-val" style={{ color: '#00E5A8', marginTop: '4px' }}>
                        {historicalData.sla.compliancePercent}%
                      </span>
                      <span style={{ fontSize: '11px', color: '#64748B', marginTop: '2px' }}>
                        {historicalData.sla.compliantCount} of {historicalData.sla.totalCompleted} within {historicalData.sla.targetWaitMinutes}m
                      </span>
                    </>
                  ) : (
                    <>
                      <span className="mono" style={{ fontSize: '14px', fontWeight: 800, color: '#94A3B8', marginTop: '6px' }}>
                        CONFIGURABLE
                      </span>
                      <span style={{ fontSize: '11px', color: '#64748B', marginTop: '2px' }}>
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
                    background: 'rgba(17, 27, 44, 0.6)',
                    border: '1px solid var(--border-subtle)',
                    borderRadius: '16px',
                    padding: '20px',
                  }}
                >
                  <h3 style={{ fontSize: '15px', fontWeight: 800, color: '#F8FAFC', marginBottom: '14px' }}>
                    Counter Productivity & Utilization
                  </h3>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
                    <thead>
                      <tr style={{ borderBottom: '1px solid var(--border-subtle)', color: '#64748B', textAlign: 'left' }}>
                        <th style={{ padding: '8px 0' }}>Desk</th>
                        <th style={{ padding: '8px 0' }}>Total Handled</th>
                        <th style={{ padding: '8px 0' }}>Completed</th>
                        <th style={{ padding: '8px 0' }}>Skipped</th>
                        <th style={{ padding: '8px 0' }}>Avg Service</th>
                      </tr>
                    </thead>
                    <tbody>
                      {historicalData.counterUtilization?.map((cu) => (
                        <tr key={cu.counterId} style={{ borderBottom: '1px solid rgba(255, 255, 255, 0.04)' }}>
                          <td style={{ padding: '10px 0', fontWeight: 600, color: '#F1F5F9' }}>
                            {cu.name}
                          </td>
                          <td className="mono" style={{ padding: '10px 0', color: '#94A3B8' }}>
                            {cu.totalHandled}
                          </td>
                          <td className="mono" style={{ padding: '10px 0', color: '#00E5A8', fontWeight: 700 }}>
                            {cu.completed}
                          </td>
                          <td className="mono" style={{ padding: '10px 0', color: '#F59E0B' }}>
                            {cu.skipped}
                          </td>
                          <td className="mono" style={{ padding: '10px 0', color: '#38BDF8' }}>
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
                    background: 'rgba(17, 27, 44, 0.6)',
                    border: '1px solid var(--border-subtle)',
                    borderRadius: '16px',
                    padding: '20px',
                  }}
                >
                  <h3 style={{ fontSize: '15px', fontWeight: 800, color: '#F8FAFC', marginBottom: '14px' }}>
                    Service Demand Breakdown
                  </h3>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
                    <thead>
                      <tr style={{ borderBottom: '1px solid var(--border-subtle)', color: '#64748B', textAlign: 'left' }}>
                        <th style={{ padding: '8px 0' }}>Service</th>
                        <th style={{ padding: '8px 0' }}>Total Issued</th>
                        <th style={{ padding: '8px 0' }}>Completed</th>
                        <th style={{ padding: '8px 0' }}>Cancelled</th>
                      </tr>
                    </thead>
                    <tbody>
                      {historicalData.servicePerformance?.map((sp) => (
                        <tr key={sp.serviceId} style={{ borderBottom: '1px solid rgba(255, 255, 255, 0.04)' }}>
                          <td style={{ padding: '10px 0', fontWeight: 600, color: '#F1F5F9' }}>
                            [{sp.tokenPrefix}] {sp.name}
                          </td>
                          <td className="mono" style={{ padding: '10px 0', color: '#94A3B8' }}>
                            {sp.totalIssued}
                          </td>
                          <td className="mono" style={{ padding: '10px 0', color: '#00E5A8', fontWeight: 700 }}>
                            {sp.completed}
                          </td>
                          <td className="mono" style={{ padding: '10px 0', color: '#EF4444' }}>
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
                  background: 'rgba(17, 27, 44, 0.6)',
                  border: '1px solid var(--border-subtle)',
                  borderRadius: '16px',
                  padding: '20px',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
                  <h3 style={{ fontSize: '15px', fontWeight: 800, color: '#F8FAFC' }}>
                    Persisted Token Audit History
                  </h3>
                  <span style={{ fontSize: '12px', color: '#64748B' }}>
                    Total Records: {historicalData.pagination?.total || 0}
                  </span>
                </div>

                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
                    <thead>
                      <tr style={{ borderBottom: '1px solid var(--border-subtle)', color: '#64748B', textAlign: 'left' }}>
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
                        <tr key={t._id} style={{ borderBottom: '1px solid rgba(255, 255, 255, 0.04)' }}>
                          <td className="mono" style={{ padding: '10px 12px', fontWeight: 800, color: '#00E5A8' }}>
                            {t.tokenCode}
                          </td>
                          <td style={{ padding: '10px 12px', color: '#E2E8F0' }}>
                            [{t.tokenPrefix}] {t.serviceName}
                          </td>
                          <td style={{ padding: '10px 12px', color: '#94A3B8' }}>
                            {t.counterName || '—'}
                          </td>
                          <td style={{ padding: '10px 12px', color: '#94A3B8' }}>
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
                                    ? 'rgba(0, 229, 168, 0.15)'
                                    : t.status === 'SKIPPED'
                                    ? 'rgba(245, 158, 11, 0.15)'
                                    : t.status === 'CANCELLED'
                                    ? 'rgba(239, 68, 68, 0.15)'
                                    : 'rgba(148, 163, 184, 0.15)',
                                color:
                                  t.status === 'COMPLETED'
                                    ? '#00E5A8'
                                    : t.status === 'SKIPPED'
                                    ? '#F59E0B'
                                    : t.status === 'CANCELLED'
                                    ? '#EF4444'
                                    : '#94A3B8',
                              }}
                            >
                              {t.status}
                            </span>
                          </td>
                          <td className="mono" style={{ padding: '10px 12px', color: '#38BDF8' }}>
                            {t.waitSeconds != null ? `${Math.round(t.waitSeconds / 60)}m ${t.waitSeconds % 60}s` : '—'}
                          </td>
                          <td className="mono" style={{ padding: '10px 12px', color: '#F59E0B' }}>
                            {t.serviceDurationSeconds != null
                              ? `${Math.round(t.serviceDurationSeconds / 60)}m ${t.serviceDurationSeconds % 60}s`
                              : '—'}
                          </td>
                          <td className="mono" style={{ padding: '10px 12px', color: '#64748B' }}>
                            {t.createdAt ? new Date(t.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—'}
                          </td>
                          <td className="mono" style={{ padding: '10px 12px', color: '#64748B' }}>
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
                  <span className="mono" style={{ fontSize: '12px', color: '#94A3B8', padding: '0 8px' }}>
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
              background: 'rgba(17, 27, 44, 0.6)',
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
              <Clock size={15} color="#64748B" />
              <span style={{ fontSize: '12px', color: '#94A3B8', marginRight: '4px' }}>Forecast Horizon:</span>
              {[4, 6, 12, 24].map((hrs) => (
                <button
                  key={hrs}
                  onClick={() => setForecastHorizon(hrs)}
                  style={{
                    background: forecastHorizon === hrs ? 'rgba(0, 229, 168, 0.15)' : 'rgba(255, 255, 255, 0.05)',
                    color: forecastHorizon === hrs ? '#00E5A8' : '#94A3B8',
                    border: forecastHorizon === hrs ? '1px solid rgba(0, 229, 168, 0.3)' : '1px solid transparent',
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
                  color: '#38BDF8',
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
                background: 'rgba(17, 27, 44, 0.65)',
                border: '1px solid rgba(245, 158, 11, 0.3)',
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
                  background: 'rgba(245, 158, 11, 0.15)',
                  color: '#F59E0B',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  margin: '0 auto 16px auto',
                }}
              >
                <AlertTriangle size={24} />
              </div>
              <h3 style={{ fontSize: '17px', fontWeight: 800, color: '#F8FAFC', marginBottom: '8px' }}>
                Prediction Unavailable — Insufficient Historical Data
              </h3>
              <p style={{ fontSize: '13px', color: '#94A3B8', lineHeight: '1.6', marginBottom: '24px' }}>
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
                  border: '1px solid rgba(255, 255, 255, 0.05)',
                  textAlign: 'left',
                }}
              >
                <div>
                  <span style={{ fontSize: '11px', color: '#64748B', display: 'block' }}>Real Tokens Found</span>
                  <span className="mono" style={{ fontSize: '15px', fontWeight: 800, color: '#F8FAFC' }}>
                    {forecastData.sufficiency?.tokensFound || 0} / {forecastData.sufficiency?.tokensRequired || 10}
                  </span>
                </div>
                <div>
                  <span style={{ fontSize: '11px', color: '#64748B', display: 'block' }}>Hourly Intervals</span>
                  <span className="mono" style={{ fontSize: '15px', fontWeight: 800, color: '#F8FAFC' }}>
                    {forecastData.sufficiency?.hourlyIntervalsFound || 0} / {forecastData.sufficiency?.hourlyIntervalsRequired || 5}
                  </span>
                </div>
                <div>
                  <span style={{ fontSize: '11px', color: '#64748B', display: 'block' }}>History Window</span>
                  <span className="mono" style={{ fontSize: '15px', fontWeight: 800, color: '#00E5A8' }}>
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
                  background: 'rgba(17, 27, 44, 0.6)',
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
                    <ShieldCheck size={16} color="#00E5A8" />
                    <span style={{ fontWeight: 700, color: '#F8FAFC' }}>
                      Model: {forecastData.modelMetadata?.modelType} ({forecastData.modelMetadata?.modelVersion})
                    </span>
                  </div>
                  <span style={{ color: '#475569' }}>•</span>
                  <span style={{ color: '#94A3B8' }}>
                    Trained on <strong style={{ color: '#F8FAFC' }}>{forecastData.modelMetadata?.trainingTokensCount}</strong> tokens across{' '}
                    <strong style={{ color: '#F8FAFC' }}>{forecastData.modelMetadata?.hourlyIntervalsAnalyzed}</strong> intervals ({forecastData.modelMetadata?.historicalWindowDays}d window)
                  </span>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
                  {forecastData.modelMetadata?.evaluationMetrics?.valMae != null && (
                    <span className="mono" style={{ fontSize: '11px', color: '#38BDF8' }}>
                      Val MAE: <strong>{forecastData.modelMetadata.evaluationMetrics.valMae}</strong>
                      {forecastData.modelMetadata.evaluationMetrics.baselineValMae != null && (
                        <span style={{ color: '#64748B' }}> (baseline: {forecastData.modelMetadata.evaluationMetrics.baselineValMae})</span>
                      )}
                    </span>
                  )}
                  <span className="mono" style={{ fontSize: '11px', color: '#64748B' }}>
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
                        background: 'rgba(17, 27, 44, 0.7)',
                        border: `1px solid ${isUnderstaffed ? 'rgba(245, 158, 11, 0.4)' : 'var(--border-subtle)'}`,
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
                          <span className="mono" style={{ fontSize: '13px', fontWeight: 800, color: '#F8FAFC' }}>
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
                                ? 'rgba(245, 158, 11, 0.2)'
                                : isOverstaffed
                                ? 'rgba(56, 189, 248, 0.15)'
                                : 'rgba(0, 229, 168, 0.15)',
                              color: isUnderstaffed ? '#F59E0B' : isOverstaffed ? '#38BDF8' : '#00E5A8',
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
                          <span style={{ fontSize: '11px', color: '#64748B', display: 'block' }}>Predicted Customer Arrivals</span>
                          <div style={{ display: 'flex', alignItems: 'baseline', gap: '6px', marginTop: '2px' }}>
                            <span style={{ fontSize: '24px', fontWeight: 900, color: '#38BDF8' }}>
                              ~{slot.predictedArrivals}
                            </span>
                            <span style={{ fontSize: '12px', color: '#94A3B8' }}>tokens</span>
                          </div>
                        </div>

                        {/* Staffing Recommendation Breakdown */}
                        <div
                          style={{
                            background: 'rgba(15, 23, 42, 0.6)',
                            borderRadius: '10px',
                            padding: '10px 12px',
                            marginBottom: '10px',
                            border: '1px solid rgba(255, 255, 255, 0.04)',
                          }}
                        >
                          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
                            <span style={{ fontSize: '11px', color: '#94A3B8' }}>Recommended Desks:</span>
                            <span className="mono" style={{ fontSize: '12px', fontWeight: 800, color: '#00E5A8' }}>
                              {slot.staffing?.recommendedActiveCounters} active
                            </span>
                          </div>
                          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                            <span style={{ fontSize: '11px', color: '#64748B' }}>Currently Active:</span>
                            <span className="mono" style={{ fontSize: '12px', fontWeight: 600, color: '#94A3B8' }}>
                              {slot.staffing?.currentActiveCounters} active
                            </span>
                          </div>
                        </div>
                      </div>

                      {/* Workload Math Footnote */}
                      <div style={{ fontSize: '10px', color: '#64748B', borderTop: '1px solid rgba(255, 255, 255, 0.05)', paddingTop: '8px' }}>
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
              background: '#0D1422',
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
                  background: 'rgba(0, 229, 168, 0.15)',
                  color: '#00E5A8',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Shuffle size={18} />
              </div>
              <h2 style={{ fontSize: '18px', fontWeight: 800, color: '#F8FAFC' }}>
                Counter Morphing
              </h2>
            </div>

            <p style={{ fontSize: '13px', color: '#94A3B8', marginBottom: '20px' }}>
              Dynamically morph <strong style={{ color: '#F8FAFC' }}>{selectedCounterForMorph.name} (Desk #{selectedCounterForMorph.number})</strong> to serve a different active queue.
            </p>

            {/* Active Token Warning — Critical Safety */}
            {selectedCounterForMorph.currentToken && (
              <div
                style={{
                  background: 'rgba(239, 68, 68, 0.12)',
                  border: '1px solid rgba(239, 68, 68, 0.3)',
                  borderRadius: '12px',
                  padding: '12px 16px',
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: '10px',
                  marginBottom: '18px',
                  color: '#FCA5A5',
                  fontSize: '12px',
                }}
              >
                <AlertTriangle size={18} style={{ flexShrink: 0, marginTop: '2px' }} color="#EF4444" />
                <div>
                  <strong style={{ color: '#EF4444', display: 'block', marginBottom: '2px' }}>
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
                  background: 'rgba(0, 229, 168, 0.15)',
                  border: '1px solid rgba(0, 229, 168, 0.3)',
                  borderRadius: '10px',
                  padding: '10px 14px',
                  color: '#00E5A8',
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
                <label style={{ display: 'block', fontSize: '12px', fontWeight: 700, color: '#94A3B8', marginBottom: '6px' }}>
                  Target Service
                </label>
                <select
                  value={targetServiceId}
                  onChange={(e) => setTargetServiceId(e.target.value)}
                  style={{
                    width: '100%',
                    background: 'rgba(15, 23, 42, 0.8)',
                    border: '1px solid var(--border-subtle)',
                    color: '#F8FAFC',
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
                <label style={{ display: 'block', fontSize: '12px', fontWeight: 700, color: '#94A3B8', marginBottom: '6px' }}>
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
                    color: '#F8FAFC',
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
                      ? 'rgba(148, 163, 184, 0.2)'
                      : 'linear-gradient(135deg, #00E5A8 0%, #008f6b 100%)',
                    color: selectedCounterForMorph.currentToken ? '#64748B' : '#05070D',
                    border: 'none',
                    borderRadius: '10px',
                    padding: '9px 20px',
                    fontSize: '13px',
                    fontWeight: 800,
                    cursor: selectedCounterForMorph.currentToken ? 'not-allowed' : 'pointer',
                    boxShadow: selectedCounterForMorph.currentToken ? 'none' : '0 0 20px rgba(0, 229, 168, 0.3)',
                  }}
                >
                  {morphLoading ? 'Morphing...' : 'Confirm Morph'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
