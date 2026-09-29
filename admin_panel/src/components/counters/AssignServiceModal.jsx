import React, { useState, useEffect } from 'react';
import { serviceAPI } from '../../services/api';
import { X, Layers } from 'lucide-react';

export default function AssignServiceModal({ counter, centerId, onClose, onAssign }) {
  const [services, setServices] = useState([]);
  const [selectedServiceId, setSelectedServiceId] = useState(
    counter?.serviceId?._id || counter?.serviceId || ''
  );
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    async function loadServices() {
      if (!centerId) return;
      try {
        const res = await serviceAPI.list(centerId);
        if (res.success && res.data?.services) {
          setServices(res.data.services);
        }
      } catch (err) {
        console.error('Failed to load services for counter assignment:', err);
      } finally {
        setLoading(false);
      }
    }
    loadServices();
  }, [centerId]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      await onAssign(counter._id, selectedServiceId || null);
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-overlay">
      <div className="modal-content">
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '18px 22px',
            borderBottom: '1px solid var(--border-subtle)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <div
              style={{
                width: '32px',
                height: '32px',
                borderRadius: '8px',
                background: 'rgba(0, 229, 168, 0.12)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#00E5A8',
              }}
            >
              <Layers size={16} />
            </div>
            <h3 style={{ fontSize: '16px', fontWeight: 700, color: '#F8FAFC' }}>
              Assign Service: {counter?.name}
            </h3>
          </div>
          <button
            onClick={onClose}
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              color: '#64748B',
              padding: '4px',
              borderRadius: '6px',
            }}
            aria-label="Close dialog"
          >
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit} style={{ padding: '22px' }}>
          <p style={{ fontSize: '13px', color: '#94A3B8', marginBottom: '16px', lineHeight: 1.5 }}>
            Select the designated service queue for this counter. Calling next will draw customers sequentially from this service.
          </p>

          {loading ? (
            <p style={{ fontSize: '13px', color: '#64748B', textAlign: 'center', padding: '20px' }}>
              Loading facility service catalog...
            </p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '22px', maxHeight: '280px', overflowY: 'auto' }}>
              {/* Unassigned Option */}
              <label
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '12px',
                  padding: '12px 16px',
                  borderRadius: '12px',
                  border: !selectedServiceId ? '1px solid #00E5A8' : '1px solid var(--border-subtle)',
                  background: !selectedServiceId ? 'rgba(0, 229, 168, 0.08)' : 'rgba(255, 255, 255, 0.02)',
                  cursor: 'pointer',
                  transition: 'all 0.15s ease',
                }}
              >
                <input
                  type="radio"
                  name="service"
                  value=""
                  checked={!selectedServiceId}
                  onChange={() => setSelectedServiceId('')}
                  style={{ accentColor: '#00E5A8' }}
                />
                <span style={{ fontSize: '13px', fontWeight: 600, color: '#F8FAFC' }}>
                  Unassigned (Idle Counter)
                </span>
              </label>

              {services.map((svc) => {
                const isSelected = selectedServiceId === svc._id;
                return (
                  <label
                    key={svc._id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '12px',
                      padding: '12px 16px',
                      borderRadius: '12px',
                      border: isSelected ? '1px solid #00E5A8' : '1px solid var(--border-subtle)',
                      background: isSelected ? 'rgba(0, 229, 168, 0.08)' : 'rgba(255, 255, 255, 0.02)',
                      cursor: 'pointer',
                      transition: 'all 0.15s ease',
                    }}
                  >
                    <input
                      type="radio"
                      name="service"
                      value={svc._id}
                      checked={isSelected}
                      onChange={() => setSelectedServiceId(svc._id)}
                      style={{ accentColor: '#00E5A8' }}
                    />
                    <div style={{ flex: 1 }}>
                      <p style={{ fontSize: '13px', fontWeight: 600, color: '#F8FAFC' }}>{svc.name}</p>
                      <p className="mono" style={{ fontSize: '11px', color: '#94A3B8', marginTop: '2px' }}>
                        Prefix: <strong style={{ color: '#00E5A8' }}>{svc.tokenPrefix}</strong> • ~{svc.avgServiceTimeMinutes}m estimate
                      </p>
                    </div>
                  </label>
                );
              })}
            </div>
          )}

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
            <button type="button" onClick={onClose} className="btn-secondary">
              Cancel
            </button>
            <button type="submit" disabled={saving} className="btn-primary">
              {saving ? 'Saving...' : 'Save Assignment'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
