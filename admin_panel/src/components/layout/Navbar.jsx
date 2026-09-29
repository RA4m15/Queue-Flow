import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { useSocket } from '../../context/SocketContext';
import { serviceCenterAPI } from '../../services/api';
import { resolveDefaultCenterId, rememberCenterId } from '../../services/defaultCenter';
import { LogOut, Building2, ChevronDown, Menu, User, Shield } from 'lucide-react';

export default function Navbar({ onToggleSidebar }) {
  const { user, logout } = useAuth();
  const { activeCenterId, setActiveCenterId } = useSocket();
  const [centers, setCenters] = useState([]);
  const [currentTime, setCurrentTime] = useState('');
  const navigate = useNavigate();

  const DEFAULT_CENTERS = [
    { _id: '64f1a2b3c4d5e6f7a8b9c001', name: 'City Hall — Branch 01', code: 'CITYHAL01', isOpen: true },
    { _id: '64f1a2b3c4d5e6f7a8b9c002', name: 'State Bank — Main Branch', code: 'SBANK001', isOpen: true },
  ];

  // Load the service centers an operator can actually run.
  useEffect(() => {
    async function loadCenters() {
      try {
        const res = await serviceCenterAPI.list({ isOpen: true });
        if (res.success && res.data?.centers) {
          const list = res.data.centers;
          setCenters(list);
          const resolved = resolveDefaultCenterId(list, activeCenterId);
          if (resolved && resolved !== activeCenterId) {
            setActiveCenterId(resolved);
          }
          return;
        }
      } catch (err) {
        console.warn('Using default service centers fallback:', err.message);
      }
      setCenters(DEFAULT_CENTERS);
      if (!activeCenterId) {
        setActiveCenterId(DEFAULT_CENTERS[0]._id);
      }
    }
    loadCenters();
  }, [activeCenterId, setActiveCenterId]);


  // Record only deliberate changes made from the facility dropdown, so an
  // automatically resolved default is never mistaken for a manual selection.
  const handleSelectCenter = (centerId) => {
    if (!centerId) return;
    rememberCenterId(centerId);
    setActiveCenterId(centerId);
  };

  // Live clock ticker
  useEffect(() => {
    function updateClock() {
      const now = new Date();
      setCurrentTime(
        `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`
      );
    }
    updateClock();
    const interval = setInterval(updateClock, 1000);
    return () => clearInterval(interval);
  }, []);

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  const currentCenter = centers.find((c) => c._id === activeCenterId);

  return (
    <header
      style={{
        background: 'var(--bg-app)',
        backdropFilter: 'blur(16px)',
        WebkitBackdropFilter: 'blur(16px)',
        borderBottom: '1px solid var(--border-subtle)',
        position: 'sticky',
        top: 0,
        zIndex: 80,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '12px 24px',
          maxWidth: '1600px',
          margin: '0 auto',
          gap: '16px',
        }}
      >
        {/* Left: Mobile Toggle & Center Switcher */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          <button
            onClick={onToggleSidebar}
            className="btn-secondary"
            style={{
              padding: '8px',
              borderRadius: '10px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
            title="Toggle Navigation"
            aria-label="Toggle navigation menu"
          >
            <Menu size={18} />
          </button>

          {/* Active Center Dropdown */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              background: 'var(--bg-card-alt)',
              border: '1px solid var(--border-medium)',
              borderRadius: '12px',
              padding: '4px 12px',
              gap: '8px',
              position: 'relative',
              boxShadow: 'var(--shadow-sm)',
            }}
          >
            <Building2 size={16} color="var(--color-primary)" style={{ flexShrink: 0 }} />
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <span className="mono" style={{ fontSize: '9px', color: 'var(--text-muted)', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                ACTIVE FACILITY
              </span>
              <select
                value={activeCenterId || ''}
                onChange={(e) => handleSelectCenter(e.target.value)}
                style={{
                  fontFamily: 'var(--font-main)',
                  fontSize: '13px',
                  fontWeight: 600,
                  color: 'var(--text-primary)',
                  background: 'transparent',
                  border: 'none',
                  outline: 'none',
                  cursor: 'pointer',
                  appearance: 'none',
                  paddingRight: '18px',
                  boxShadow: 'none',
                }}
              >
                {centers.filter((c) => c.isOpen).map((c) => (
                  <option
                    key={c._id}
                    value={c._id}
                    style={{ background: 'var(--bg-card)', color: 'var(--text-primary)' }}
                  >
                    {c.name} ({c.code})
                  </option>
                ))}
                {centers.some((c) => !c.isOpen) && (
                  <optgroup label="── Inactive / Closed Facilities ──" style={{ background: 'var(--bg-card)', color: 'var(--text-muted)' }}>
                    {centers.filter((c) => !c.isOpen).map((c) => (
                      <option
                        key={c._id}
                        value={c._id}
                        style={{ background: 'var(--bg-card)', color: 'var(--text-muted)' }}
                      >
                        [CLOSED] {c.name} ({c.code})
                      </option>
                    ))}
                  </optgroup>
                )}
              </select>
            </div>
            <ChevronDown
              size={13}
              style={{
                position: 'absolute',
                right: '10px',
                pointerEvents: 'none',
                color: 'var(--text-secondary)',
              }}
            />
          </div>
        </div>

        {/* Right: Time, Operator Profile & Sign Out */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '18px' }}>
          {/* Live UTC/Local Ticker */}
          <div
            className="mono"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              fontSize: '12px',
              color: 'var(--text-secondary)',
              background: 'var(--bg-card-alt)',
              padding: '6px 12px',
              borderRadius: '10px',
              border: '1px solid var(--border-subtle)',
            }}
          >
            <span style={{ color: 'var(--color-primary)', fontWeight: 700 }}>LIVE</span>
            <span>{currentTime || '—:—:—'}</span>
          </div>

          {/* User Profile Card */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '10px',
              padding: '4px 8px 4px 4px',
              borderRadius: '12px',
              background: 'var(--bg-card-alt)',
              border: '1px solid var(--border-subtle)',
            }}
          >
            <div
              style={{
                width: '32px',
                height: '32px',
                borderRadius: '9px',
                background: 'var(--bg-card)',
                border: '1px solid color-mix(in srgb, var(--color-primary) 30%, transparent)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'var(--color-primary)',
                fontWeight: 700,
                fontSize: '13px',
              }}
            >
              {user?.name ? user.name[0].toUpperCase() : <User size={15} />}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)', lineHeight: 1.2 }}>
                {user?.name || '—'}
              </span>
              <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                <Shield size={10} color="var(--color-primary)" />
                <span className="mono" style={{ fontSize: '9px', color: 'var(--color-primary)', fontWeight: 700 }}>
                  {user?.role || 'STAFF'}
                </span>
              </div>
            </div>
          </div>

          {/* Sign Out Button */}
          <button
            onClick={handleLogout}
            className="btn-secondary"
            style={{
              padding: '8px 12px',
              fontSize: '12px',
              gap: '6px',
            }}
            title="Sign out of command console"
          >
            <LogOut size={14} color="var(--color-danger)" />
            <span style={{ color: 'var(--color-danger)' }}>Sign out</span>
          </button>
        </div>
      </div>
    </header>
  );
}
