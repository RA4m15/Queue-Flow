import React, { useState, useEffect, useRef } from 'react';
import { useAuth } from '../context/AuthContext';
import { useServices, useCenters } from '../hooks/useServices';
import {
  Plus,
  RefreshCw,
  Search,
  ChevronDown,
  Edit2,
  Power,
  PowerOff,
  CheckCircle,
  XCircle,
  Clock,
  Tag,
  Hash,
  AlignLeft,
  Layers,
} from 'lucide-react';

// ─── Sub-components ─────────────────────────────────────────────────────────

function StatusBadge({ isActive }) {
  return (
    <span
      className={isActive ? 'badge badge-serving' : 'badge badge-break'}
      style={{ fontSize: '10px', padding: '2px 8px' }}
    >
      {isActive ? (
        <>
          <CheckCircle size={9} />
          ACTIVE
        </>
      ) : (
        <>
          <XCircle size={9} />
          INACTIVE
        </>
      )}
    </span>
  );
}

function ServiceRow({ service, isActionLoading, onEdit, onToggle, isAdminRole }) {
  return (
    <tr
      style={{
        borderBottom: '1px solid var(--border-subtle)',
        transition: 'background 0.15s ease',
        opacity: service.isActive ? 1 : 0.6,
      }}
      onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.025)')}
      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
    >
      {/* Token Prefix */}
      <td style={{ padding: '14px 16px', minWidth: '80px' }}>
        <span
          className="mono"
          style={{
            fontSize: '14px',
            fontWeight: 800,
            color: service.isActive ? 'var(--color-primary)' : 'var(--text-muted)',
            letterSpacing: '0.05em',
            background: service.isActive
              ? 'rgba(0, 229, 168, 0.08)'
              : 'rgba(100, 116, 139, 0.1)',
            border: `1px solid ${service.isActive ? 'rgba(0,229,168,0.2)' : 'rgba(100,116,139,0.2)'}`,
            borderRadius: '8px',
            padding: '4px 10px',
            display: 'inline-block',
          }}
        >
          {service.tokenPrefix}
        </span>
      </td>

      {/* Name */}
      <td style={{ padding: '14px 16px' }}>
        <div style={{ fontWeight: 600, fontSize: '14px', color: 'var(--text-main)' }}>
          {service.name}
        </div>
        {service.description && (
          <div
            style={{
              fontSize: '11px',
              color: 'var(--text-muted)',
              marginTop: '3px',
              maxWidth: '280px',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {service.description}
          </div>
        )}
      </td>

      {/* Avg Time */}
      <td style={{ padding: '14px 16px', textAlign: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px' }}>
          <Clock size={12} style={{ color: 'var(--text-muted)' }} />
          <span className="mono" style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
            {service.avgServiceTimeMinutes ?? 8} min
          </span>
        </div>
      </td>

      {/* Order */}
      <td style={{ padding: '14px 16px', textAlign: 'center' }}>
        <span className="mono" style={{ fontSize: '12px', color: 'var(--text-subtle)' }}>
          {service.order ?? 0}
        </span>
      </td>

      {/* Status */}
      <td style={{ padding: '14px 16px', textAlign: 'center' }}>
        <StatusBadge isActive={service.isActive} />
      </td>

      {/* ID */}
      <td style={{ padding: '14px 16px', maxWidth: '120px' }}>
        <span
          className="mono"
          style={{
            fontSize: '10px',
            color: 'var(--text-subtle)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            display: 'block',
            whiteSpace: 'nowrap',
          }}
          title={service._id}
        >
          {service._id}
        </span>
      </td>

      {/* Actions */}
      {isAdminRole && (
        <td style={{ padding: '14px 16px', textAlign: 'right' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '8px' }}>
            <button
              className="btn-secondary"
              onClick={() => onEdit(service)}
              disabled={isActionLoading}
              style={{ fontSize: '11px', padding: '5px 10px', gap: '4px' }}
              title="Edit service"
            >
              <Edit2 size={12} />
              Edit
            </button>
            <button
              className={service.isActive ? 'btn-danger' : 'btn-success'}
              onClick={() => onToggle(service._id, service.isActive)}
              disabled={isActionLoading}
              style={{ fontSize: '11px', padding: '5px 10px', gap: '4px' }}
              title={service.isActive ? 'Deactivate — hides from customers' : 'Activate — makes visible to customers'}
            >
              {service.isActive ? <PowerOff size={12} /> : <Power size={12} />}
              {service.isActive ? 'Deactivate' : 'Activate'}
            </button>
          </div>
        </td>
      )}
    </tr>
  );
}

// ─── Service Form Modal ──────────────────────────────────────────────────────

function ServiceFormModal({ mode, initial, centerId, onClose, onSubmit }) {
  const isEdit = mode === 'edit';
  const [form, setForm] = useState({
    name: initial?.name ?? '',
    tokenPrefix: initial?.tokenPrefix ?? '',
    description: initial?.description ?? '',
    avgServiceTimeMinutes: initial?.avgServiceTimeMinutes ?? 8,
    order: initial?.order ?? 0,
  });
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState(null);
  const firstInputRef = useRef(null);

  useEffect(() => {
    firstInputRef.current?.focus();
  }, []);

  const set = (key) => (e) => setForm((prev) => ({ ...prev, [key]: e.target.value }));
  const setNum = (key) => (e) => setForm((prev) => ({ ...prev, [key]: Number(e.target.value) }));

  const validate = () => {
    if (!form.name.trim()) return 'Service name is required.';
    if (!isEdit && !form.tokenPrefix.trim()) return 'Token prefix is required.';
    if (!isEdit && form.tokenPrefix.trim().length > 3) return 'Token prefix max 3 characters.';
    if (form.avgServiceTimeMinutes < 1 || form.avgServiceTimeMinutes > 120)
      return 'Average service time must be 1–120 minutes.';
    if (form.order < 0) return 'Order must be 0 or greater.';
    return null;
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    const err = validate();
    if (err) { setServerError(err); return; }
    setServerError(null);
    setSubmitting(true);
    try {
      const payload = isEdit
        ? {
            name: form.name.trim(),
            description: form.description.trim() || undefined,
            avgServiceTimeMinutes: Number(form.avgServiceTimeMinutes),
            order: Number(form.order),
          }
        : {
            centerId,
            name: form.name.trim(),
            tokenPrefix: form.tokenPrefix.trim().toUpperCase(),
            description: form.description.trim() || undefined,
            avgServiceTimeMinutes: Number(form.avgServiceTimeMinutes),
            order: Number(form.order),
          };
      await onSubmit(payload);
      onClose();
    } catch (err) {
      setServerError(err.message ?? 'Failed to save service');
    } finally {
      setSubmitting(false);
    }
  };

  const fieldStyle = {
    width: '100%',
    padding: '10px 14px',
    fontSize: '13px',
    borderRadius: '10px',
  };
  const labelStyle = {
    display: 'block',
    fontSize: '11px',
    fontWeight: 600,
    color: 'var(--text-secondary)',
    marginBottom: '6px',
    letterSpacing: '0.05em',
    textTransform: 'uppercase',
  };

  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal-content" style={{ maxWidth: '520px' }}>
        {/* Header */}
        <div
          style={{
            padding: '20px 24px',
            borderBottom: '1px solid var(--border-subtle)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <div>
            <h2 style={{ fontSize: '16px', fontWeight: 700, color: 'var(--text-main)' }}>
              {isEdit ? 'Edit Service' : 'Create New Service'}
            </h2>
            <p style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '3px' }}>
              {isEdit
                ? 'Update service details. Token prefix cannot be changed.'
                : 'Define a new service for this center.'}
            </p>
          </div>
          <button
            onClick={onClose}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--text-muted)',
              cursor: 'pointer',
              fontSize: '20px',
              lineHeight: 1,
              padding: '4px',
            }}
          >
            ×
          </button>
        </div>

        {/* Body */}
        <form onSubmit={handleSubmit} style={{ padding: '24px' }}>
          {serverError && (
            <div
              style={{
                background: 'rgba(239, 68, 68, 0.1)',
                border: '1px solid rgba(239, 68, 68, 0.3)',
                borderRadius: '10px',
                padding: '10px 14px',
                fontSize: '13px',
                color: '#F87171',
                marginBottom: '18px',
              }}
            >
              {serverError}
            </div>
          )}

          <div style={{ display: 'grid', gap: '16px' }}>
            {/* Name */}
            <div>
              <label style={labelStyle}>
                <Tag size={10} style={{ display: 'inline', marginRight: '4px' }} />
                Service Name *
              </label>
              <input
                ref={firstInputRef}
                type="text"
                value={form.name}
                onChange={set('name')}
                placeholder="e.g. Account Opening"
                maxLength={100}
                style={fieldStyle}
                required
              />
            </div>

            {/* Token Prefix — only for create */}
            {!isEdit && (
              <div>
                <label style={labelStyle}>
                  <Hash size={10} style={{ display: 'inline', marginRight: '4px' }} />
                  Token Prefix * (1–3 chars, e.g. "A" → A-001)
                </label>
                <input
                  type="text"
                  value={form.tokenPrefix}
                  onChange={(e) =>
                    setForm((prev) => ({
                      ...prev,
                      tokenPrefix: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''),
                    }))
                  }
                  placeholder="A"
                  maxLength={3}
                  style={{ ...fieldStyle, width: '120px', fontFamily: 'var(--font-mono)', fontWeight: 700, letterSpacing: '0.1em' }}
                  required
                />
                <p style={{ fontSize: '11px', color: 'var(--text-subtle)', marginTop: '5px' }}>
                  Cannot be changed after creation. Must be unique within this center.
                </p>
              </div>
            )}

            {/* Description */}
            <div>
              <label style={labelStyle}>
                <AlignLeft size={10} style={{ display: 'inline', marginRight: '4px' }} />
                Description (optional)
              </label>
              <textarea
                value={form.description}
                onChange={set('description')}
                placeholder="Brief description of this service"
                maxLength={300}
                rows={2}
                style={{ ...fieldStyle, resize: 'vertical' }}
              />
            </div>

            {/* Avg Time + Order side-by-side */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
              <div>
                <label style={labelStyle}>
                  <Clock size={10} style={{ display: 'inline', marginRight: '4px' }} />
                  Avg. Service Time (min)
                </label>
                <input
                  type="number"
                  value={form.avgServiceTimeMinutes}
                  onChange={setNum('avgServiceTimeMinutes')}
                  min={1}
                  max={120}
                  style={fieldStyle}
                />
              </div>
              <div>
                <label style={labelStyle}>
                  <Layers size={10} style={{ display: 'inline', marginRight: '4px' }} />
                  Display Order
                </label>
                <input
                  type="number"
                  value={form.order}
                  onChange={setNum('order')}
                  min={0}
                  style={fieldStyle}
                />
                <p style={{ fontSize: '11px', color: 'var(--text-subtle)', marginTop: '5px' }}>
                  Lower numbers appear first.
                </p>
              </div>
            </div>
          </div>

          {/* Footer */}
          <div
            style={{
              display: 'flex',
              justifyContent: 'flex-end',
              gap: '10px',
              marginTop: '24px',
              paddingTop: '18px',
              borderTop: '1px solid var(--border-subtle)',
            }}
          >
            <button type="button" className="btn-secondary" onClick={onClose} disabled={submitting}>
              Cancel
            </button>
            <button type="submit" className="btn-primary" disabled={submitting}>
              {submitting ? 'Saving…' : isEdit ? 'Save Changes' : 'Create Service'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Main Page ───────────────────────────────────────────────────────────────

export default function Services() {
  const { isAdmin } = useAuth();
  const { centers, loading: centersLoading, error: centersError, fetchCenters } = useCenters();
  const [selectedCenterId, setSelectedCenterId] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [filterStatus, setFilterStatus] = useState('all'); // 'all' | 'active' | 'inactive'
  const [modal, setModal] = useState(null); // null | { mode:'create' } | { mode:'edit', service }
  const [toastMsg, setToastMsg] = useState(null);
  const toastTimerRef = useRef(null);

  const {
    services,
    loading,
    error,
    actionLoadingId,
    fetchServices,
    createService,
    updateService,
    toggleActive,
  } = useServices(selectedCenterId);

  // Load centers on mount
  useEffect(() => {
    fetchCenters();
  }, [fetchCenters]);

  // Auto-select first center when centers load
  useEffect(() => {
    if (centers.length > 0 && !selectedCenterId) {
      setSelectedCenterId(centers[0]._id);
    }
  }, [centers, selectedCenterId]);

  // Load services whenever selected center changes
  useEffect(() => {
    if (selectedCenterId) fetchServices(selectedCenterId);
  }, [selectedCenterId, fetchServices]);

  const showToast = (msg) => {
    setToastMsg(msg);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToastMsg(null), 3500);
  };

  // Filter services client-side (search + status)
  const filtered = services.filter((s) => {
    const matchSearch =
      !searchQuery ||
      s.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      s.tokenPrefix.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (s.description && s.description.toLowerCase().includes(searchQuery.toLowerCase()));

    const matchStatus =
      filterStatus === 'all' ||
      (filterStatus === 'active' && s.isActive) ||
      (filterStatus === 'inactive' && !s.isActive);

    return matchSearch && matchStatus;
  });

  const handleCreate = async (payload) => {
    await createService(payload);
    showToast('✅ Service created successfully');
  };

  const handleUpdate = async (payload) => {
    await updateService(modal.service._id, payload);
    showToast('✅ Service updated successfully');
  };

  const handleToggle = async (id, currentIsActive) => {
    await toggleActive(id, currentIsActive);
    showToast(
      currentIsActive
        ? '🔒 Service deactivated — hidden from customers'
        : '✅ Service activated — now visible to customers'
    );
  };

  const selectedCenter = centers.find((c) => c._id === selectedCenterId);
  const activeCount = services.filter((s) => s.isActive).length;
  const inactiveCount = services.filter((s) => !s.isActive).length;

  const inputStyle = {
    background: 'var(--bg-input)',
    border: '1px solid var(--border-medium)',
    borderRadius: '10px',
    color: 'var(--text-main)',
    fontFamily: 'var(--font-main)',
    fontSize: '13px',
    padding: '8px 14px',
    outline: 'none',
  };

  const thStyle = {
    padding: '10px 16px',
    fontSize: '10px',
    fontWeight: 700,
    letterSpacing: '0.08em',
    color: 'var(--text-muted)',
    textTransform: 'uppercase',
    fontFamily: 'var(--font-mono)',
    textAlign: 'left',
    borderBottom: '1px solid var(--border-subtle)',
    background: 'rgba(17, 27, 44, 0.5)',
  };

  return (
    <div style={{ padding: '24px 28px', maxWidth: '1400px', margin: '0 auto' }}>

      {/* ── Toast notification ── */}
      {toastMsg && (
        <div
          style={{
            position: 'fixed',
            top: '80px',
            right: '24px',
            zIndex: 1200,
            background: '#111B2C',
            border: '1px solid var(--border-accent)',
            borderRadius: '12px',
            padding: '12px 18px',
            fontSize: '13px',
            fontWeight: 600,
            color: 'var(--text-main)',
            boxShadow: '0 8px 28px rgba(0,0,0,0.5), 0 0 16px rgba(0,229,168,0.15)',
            animation: 'fadeIn 0.2s ease',
          }}
        >
          {toastMsg}
        </div>
      )}

      {/* ── Page Header ── */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '24px', flexWrap: 'wrap', gap: '12px' }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <h1 style={{ fontSize: '22px', fontWeight: 800, color: 'var(--text-main)', letterSpacing: '-0.02em' }}>
              Service Management
            </h1>
            <span
              className="mono"
              style={{
                fontSize: '10px',
                fontWeight: 700,
                padding: '2px 8px',
                borderRadius: '6px',
                background: 'rgba(0, 229, 168, 0.1)',
                color: 'var(--color-primary)',
                border: '1px solid rgba(0, 229, 168, 0.25)',
              }}
            >
              ADMIN
            </span>
          </div>
          <p style={{ fontSize: '13px', color: 'var(--text-secondary)', marginTop: '4px' }}>
            Create, edit, and activate services visible to customers in the app and web portal.
          </p>
        </div>

        <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
          <button
            className="btn-secondary"
            onClick={() => fetchServices(selectedCenterId)}
            disabled={loading || !selectedCenterId}
            style={{ fontSize: '12px', padding: '8px 14px', gap: '6px' }}
            title="Refresh service list from backend"
          >
            <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
            Refresh
          </button>
          {isAdmin && (
            <button
              className="btn-primary"
              onClick={() => setModal({ mode: 'create' })}
              disabled={!selectedCenterId}
              style={{ gap: '7px' }}
            >
              <Plus size={15} />
              New Service
            </button>
          )}
        </div>
      </div>

      {/* ── Center Picker ── */}
      <div className="q-card" style={{ padding: '18px 20px', marginBottom: '20px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flex: '1', minWidth: '240px' }}>
            <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
              Service Center:
            </span>
            {centersLoading ? (
              <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Loading centers…</span>
            ) : centersError ? (
              <span style={{ fontSize: '12px', color: 'var(--color-danger)' }}>{centersError}</span>
            ) : (
              <div style={{ position: 'relative', flex: 1, maxWidth: '320px' }}>
                <select
                  id="service-center-select"
                  value={selectedCenterId}
                  onChange={(e) => { setSelectedCenterId(e.target.value); setSearchQuery(''); }}
                  style={{ ...inputStyle, width: '100%', paddingRight: '36px', appearance: 'none', cursor: 'pointer' }}
                >
                  {centers.length === 0 && <option value="">No centers found</option>}
                  {centers.map((c) => (
                    <option key={c._id} value={c._id}>
                      {c.name} ({c.code})
                    </option>
                  ))}
                </select>
                <ChevronDown
                  size={14}
                  style={{ position: 'absolute', right: '10px', top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none', color: 'var(--text-muted)' }}
                />
              </div>
            )}
          </div>

          {/* Summary pills */}
          {selectedCenter && services.length > 0 && (
            <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
              <div
                style={{
                  fontSize: '11px',
                  fontWeight: 700,
                  padding: '4px 10px',
                  borderRadius: '8px',
                  background: 'rgba(0,229,168,0.08)',
                  color: 'var(--color-primary)',
                  border: '1px solid rgba(0,229,168,0.2)',
                  fontFamily: 'var(--font-mono)',
                }}
              >
                {activeCount} ACTIVE
              </div>
              {inactiveCount > 0 && (
                <div
                  style={{
                    fontSize: '11px',
                    fontWeight: 700,
                    padding: '4px 10px',
                    borderRadius: '8px',
                    background: 'rgba(100,116,139,0.12)',
                    color: 'var(--text-muted)',
                    border: '1px solid rgba(100,116,139,0.2)',
                    fontFamily: 'var(--font-mono)',
                  }}
                >
                  {inactiveCount} INACTIVE
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ── Filters Row ── */}
      <div style={{ display: 'flex', gap: '12px', marginBottom: '16px', flexWrap: 'wrap', alignItems: 'center' }}>
        {/* Search */}
        <div style={{ position: 'relative', flex: 1, minWidth: '200px', maxWidth: '340px' }}>
          <Search size={13} style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', pointerEvents: 'none' }} />
          <input
            id="service-search"
            type="text"
            placeholder="Search by name or prefix…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            style={{ ...inputStyle, width: '100%', paddingLeft: '32px' }}
          />
        </div>

        {/* Status Filter */}
        <div style={{ position: 'relative' }}>
          <select
            id="service-status-filter"
            value={filterStatus}
            onChange={(e) => setFilterStatus(e.target.value)}
            style={{ ...inputStyle, paddingRight: '30px', appearance: 'none', cursor: 'pointer' }}
          >
            <option value="all">All Services</option>
            <option value="active">Active Only</option>
            <option value="inactive">Inactive Only</option>
          </select>
          <ChevronDown size={12} style={{ position: 'absolute', right: '8px', top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none', color: 'var(--text-muted)' }} />
        </div>
      </div>

      {/* ── Content Area ── */}
      {error && (
        <div
          style={{
            background: 'rgba(239, 68, 68, 0.08)',
            border: '1px solid rgba(239, 68, 68, 0.25)',
            borderRadius: '14px',
            padding: '18px 20px',
            marginBottom: '16px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '12px',
          }}
        >
          <div>
            <p style={{ fontSize: '13px', fontWeight: 600, color: '#F87171' }}>Failed to load services</p>
            <p style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '3px' }}>{error}</p>
          </div>
          <button
            className="btn-secondary"
            onClick={() => fetchServices(selectedCenterId)}
            style={{ fontSize: '12px', padding: '7px 14px' }}
          >
            <RefreshCw size={12} />
            Retry
          </button>
        </div>
      )}

      {!selectedCenterId && !centersLoading && (
        <div className="q-card" style={{ padding: '60px 24px', textAlign: 'center', color: 'var(--text-muted)' }}>
          <Layers size={36} style={{ marginBottom: '12px', opacity: 0.4 }} />
          <p style={{ fontSize: '15px', fontWeight: 600, color: 'var(--text-secondary)' }}>
            Select a Service Center
          </p>
          <p style={{ fontSize: '13px', marginTop: '6px' }}>
            Choose a center above to view and manage its services.
          </p>
        </div>
      )}

      {selectedCenterId && loading && (
        <div
          className="q-card"
          style={{ padding: '60px 24px', textAlign: 'center', color: 'var(--text-muted)' }}
        >
          <RefreshCw
            size={28}
            className="animate-spin"
            style={{ marginBottom: '12px', color: 'var(--color-primary)', opacity: 0.7 }}
          />
          <p style={{ fontSize: '13px' }}>Loading services…</p>
        </div>
      )}

      {selectedCenterId && !loading && !error && services.length === 0 && (
        <div className="q-card" style={{ padding: '60px 24px', textAlign: 'center' }}>
          <Layers size={36} style={{ marginBottom: '12px', opacity: 0.3, color: 'var(--color-primary)' }} />
          <p style={{ fontSize: '15px', fontWeight: 600, color: 'var(--text-secondary)' }}>
            No services yet
          </p>
          <p style={{ fontSize: '13px', color: 'var(--text-muted)', marginTop: '6px', marginBottom: '18px' }}>
            This center has no services configured. Create the first one to get started.
          </p>
          {isAdmin && (
            <button className="btn-primary" onClick={() => setModal({ mode: 'create' })}>
              <Plus size={14} />
              Create First Service
            </button>
          )}
        </div>
      )}

      {selectedCenterId && !loading && !error && services.length > 0 && filtered.length === 0 && (
        <div className="q-card" style={{ padding: '40px 24px', textAlign: 'center', color: 'var(--text-muted)' }}>
          <Search size={28} style={{ marginBottom: '10px', opacity: 0.4 }} />
          <p style={{ fontSize: '14px' }}>No services match your search</p>
          <button
            className="btn-secondary"
            onClick={() => { setSearchQuery(''); setFilterStatus('all'); }}
            style={{ marginTop: '12px', fontSize: '12px' }}
          >
            Clear filters
          </button>
        </div>
      )}

      {/* ── Services Table ── */}
      {selectedCenterId && !loading && !error && filtered.length > 0 && (
        <div
          className="q-card"
          style={{ overflow: 'hidden', borderRadius: '16px' }}
        >
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={thStyle}>Prefix</th>
                <th style={thStyle}>Name / Description</th>
                <th style={{ ...thStyle, textAlign: 'center' }}>Avg. Time</th>
                <th style={{ ...thStyle, textAlign: 'center' }}>Order</th>
                <th style={{ ...thStyle, textAlign: 'center' }}>Status</th>
                <th style={thStyle}>Service ID</th>
                {isAdmin && <th style={{ ...thStyle, textAlign: 'right' }}>Actions</th>}
              </tr>
            </thead>
            <tbody>
              {filtered.map((service) => (
                <ServiceRow
                  key={service._id}
                  service={service}
                  isActionLoading={actionLoadingId === service._id}
                  onEdit={(svc) => setModal({ mode: 'edit', service: svc })}
                  onToggle={handleToggle}
                  isAdminRole={isAdmin}
                />
              ))}
            </tbody>
          </table>

          <div
            style={{
              padding: '12px 16px',
              borderTop: '1px solid var(--border-subtle)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <span className="mono" style={{ fontSize: '10px', color: 'var(--text-subtle)' }}>
              SHOWING {filtered.length} OF {services.length} SERVICES — {selectedCenter?.name}
            </span>
            <span className="mono" style={{ fontSize: '10px', color: 'var(--text-subtle)' }}>
              SOURCE: LIVE BACKEND
            </span>
          </div>
        </div>
      )}

      {/* ── Modals ── */}
      {modal?.mode === 'create' && (
        <ServiceFormModal
          mode="create"
          centerId={selectedCenterId}
          onClose={() => setModal(null)}
          onSubmit={handleCreate}
        />
      )}
      {modal?.mode === 'edit' && (
        <ServiceFormModal
          mode="edit"
          initial={modal.service}
          centerId={selectedCenterId}
          onClose={() => setModal(null)}
          onSubmit={handleUpdate}
        />
      )}
    </div>
  );
}
