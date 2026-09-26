import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { useSocket } from '../../context/SocketContext';
import { serviceCenterAPI } from '../../services/api';
import { LogOut, Building2, ChevronDown, Menu, User, Shield } from 'lucide-react';

export default function Navbar({ onToggleSidebar }) {
  const { user, logout } = useAuth();
  const { activeCenterId, setActiveCenterId } = useSocket();
  const [centers, setCenters] = useState([]);
  const [currentTime, setCurrentTime] = useState('');
  const navigate = useNavigate();

  // Load available service centers
  useEffect(() => {
    async function loadCenters() {
      try {
        const res = await serviceCenterAPI.list();
        if (res.success && res.data?.centers) {
          const list = res.data.centers;
          setCenters(list);
          if (list.length > 0 && !activeCenterId) {
            setActiveCenterId(list[0]._id);
          }
        }
      } catch (err) {
        console.error('Failed to load service centers:', err);
      }
    }
    loadCenters();
  }, [activeCenterId, setActiveCenterId]);

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
        background: 'rgba(8, 12, 22, 0.85)',
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
              background: 'rgba(17, 27, 44, 0.75)',
              border: '1px solid var(--border-medium)',
              borderRadius: '12px',
              padding: '4px 12px',
              gap: '8px',
              position: 'relative',
              boxShadow: 'var(--shadow-sm)',
            }}
          >
            <Building2 size={16} color="#00E5A8" style={{ flexShrink: 0 }} />
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <span className="mono" style={{ fontSize: '9px', color: '#64748B', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                ACTIVE FACILITY
              </span>
              <select
                value={activeCenterId || ''}
                onChange={(e) => setActiveCenterId(e.target.value)}
                style={{
                  fontFamily: 'var(--font-main)',
                  fontSize: '13px',
                  fontWeight: 600,
                  color: '#F8FAFC',
                  background: 'transparent',
                  border: 'none',
                  outline: 'none',
                  cursor: 'pointer',
                  appearance: 'none',
                  paddingRight: '18px',
                  boxShadow: 'none',
                }}
              >
                {centers.map((c) => (
                  <option
                    key={c._id}
                    value={c._id}
                    style={{ background: '#0D1422', color: '#F8FAFC' }}
                  >
                    {c.name} ({c.code})
                  </option>
                ))}
              </select>
            </div>
            <ChevronDown
              size={13}
              style={{
                position: 'absolute',
                right: '10px',
                pointerEvents: 'none',
                color: '#94A3B8',
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
              color: '#94A3B8',
              background: 'rgba(255, 255, 255, 0.03)',
              padding: '6px 12px',
              borderRadius: '10px',
              border: '1px solid var(--border-subtle)',
            }}
          >
            <span style={{ color: '#00E5A8', fontWeight: 700 }}>LIVE</span>
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
              background: 'rgba(17, 27, 44, 0.6)',
              border: '1px solid var(--border-subtle)',
            }}
          >
            <div
              style={{
                width: '32px',
                height: '32px',
                borderRadius: '9px',
                background: 'linear-gradient(135deg, rgba(0, 229, 168, 0.25) 0%, rgba(0, 210, 255, 0.15) 100%)',
                border: '1px solid rgba(0, 229, 168, 0.3)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#00E5A8',
                fontWeight: 700,
                fontSize: '13px',
              }}
            >
              {user?.name ? user.name[0].toUpperCase() : <User size={15} />}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <span style={{ fontSize: '13px', fontWeight: 600, color: '#F8FAFC', lineHeight: 1.2 }}>
                {user?.name || '—'}
              </span>
              <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                <Shield size={10} color="#00E5A8" />
                <span className="mono" style={{ fontSize: '9px', color: '#00E5A8', fontWeight: 700 }}>
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
            <LogOut size={14} color="#EF4444" />
            <span style={{ color: '#F87171' }}>Sign out</span>
          </button>
        </div>
      </div>
    </header>
  );
}
