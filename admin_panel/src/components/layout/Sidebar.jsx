import React from 'react';
import { NavLink } from 'react-router-dom';
import { useSocket } from '../../context/SocketContext';
import { useAuth } from '../../context/AuthContext';
import {
  LayoutDashboard,
  BarChart3,
  Bell,
  Monitor,
  Radio,
  ExternalLink,
  Layers,
  UserCheck,
  Cpu,
} from 'lucide-react';

export default function Sidebar({ isOpen = true, onClose = () => {} }) {
  const { isConnected, activeCenterId } = useSocket();
  const { user } = useAuth();
  const isStaff = user?.role === 'STAFF';

  const navItems = isStaff
    ? [
        {
          to: '/operator',
          label: 'Operator Counter',
          icon: UserCheck,
          badge: 'TELLER',
        },
      ]
    : [
        {
          to: '/dashboard',
          label: 'Live Operations',
          icon: LayoutDashboard,
          badge: 'REALTIME',
        },
        {
          to: '/resource-hub',
          label: 'Resource Hub',
          icon: Cpu,
          badge: 'HUB',
        },
        {
          to: '/operator',
          label: 'Operator Portal',
          icon: UserCheck,
          badge: 'TELLER',
        },
        {
          to: '/services',
          label: 'Service Management',
          icon: Layers,
        },
        {
          to: '/analytics',
          label: 'Analytics & Trends',
          icon: BarChart3,
        },
        {
          to: '/alerts',
          label: 'Alerts & Broadcast',
          icon: Bell,
        },
      ];

  return (
    <>
      {/* Mobile backdrop */}
      <div
        className="sidebar-backdrop"
        onClick={onClose}
        style={{
          display: isOpen ? 'block' : 'none',
          position: 'fixed',
          inset: 0,
          background: 'rgba(0, 0, 0, 0.65)',
          backdropFilter: 'blur(4px)',
          zIndex: 90,
        }}
      />

      <aside
        style={{
          width: '260px',
          background: 'var(--bg-sidebar)',
          borderRight: '1px solid var(--border-subtle)',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          position: 'fixed',
          top: 0,
          bottom: 0,
          left: 0,
          zIndex: 100,
          transform: isOpen ? 'translateX(0)' : 'translateX(-100%)',
          transition: 'transform 0.25s cubic-bezier(0.16, 1, 0.3, 1)',
        }}
      >
        {/* Brand Header */}
        <div>
          <div
            style={{
              padding: '24px 20px 20px',
              display: 'flex',
              alignItems: 'center',
              gap: '12px',
              borderBottom: '1px solid var(--border-subtle)',
            }}
          >
            <div
              style={{
                width: '38px',
                height: '38px',
                borderRadius: '12px',
                background: 'linear-gradient(135deg, #FFE600 0%, #FFB300 100%)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#0A0B05',
                boxShadow: '0 0 20px rgba(255, 230, 0, 0.4)',
                flexShrink: 0,
              }}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                <circle cx="9" cy="7" r="4" />
                <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                <path d="M16 3.13a4 4 0 0 1 0 7.75" />
              </svg>
            </div>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{ fontWeight: 800, fontSize: '18px', color: '#FEFCE8', letterSpacing: '-0.02em' }}>
                  QueueFlow
                </span>
                <span
                  className="mono"
                  style={{
                    fontSize: '9px',
                    fontWeight: 700,
                    padding: '2px 6px',
                    borderRadius: '5px',
                    background: 'rgba(255, 230, 0, 0.14)',
                    color: '#FFE600',
                    border: '1px solid rgba(255, 230, 0, 0.3)',
                  }}
                >
                  ADMIN
                </span>
              </div>
              <p style={{ fontSize: '11px', color: '#64748B', marginTop: '1px' }}>
                Command & Telemetry
              </p>
            </div>
          </div>

          {/* Navigation Section */}
          <div style={{ padding: '18px 12px' }}>
            <p
              className="mono"
              style={{
                fontSize: '10px',
                fontWeight: 600,
                color: '#475569',
                letterSpacing: '0.1em',
                padding: '0 12px 10px',
                textTransform: 'uppercase',
              }}
            >
              NAVIGATION
            </p>

            <nav style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              {navItems.map((item) => {
                const Icon = item.icon;
                return (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    onClick={onClose}
                    style={({ isActive }) => ({
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '10px 14px',
                      borderRadius: '12px',
                      fontSize: '13px',
                      fontWeight: 600,
                      textDecoration: 'none',
                      transition: 'all 0.18s ease',
                      background: isActive
                        ? 'linear-gradient(90deg, rgba(255, 230, 0, 0.18) 0%, rgba(255, 230, 0, 0.03) 100%)'
                        : 'transparent',
                      color: isActive ? '#FFE600' : '#94A3B8',
                      borderLeft: isActive ? '3px solid #FFE600' : '3px solid transparent',
                      boxShadow: isActive ? 'inset 0 0 15px rgba(255, 230, 0, 0.08)' : 'none',
                    })}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                      <Icon size={17} />
                      <span>{item.label}</span>
                    </div>
                    {item.badge && (
                      <span
                        className="mono"
                        style={{
                          fontSize: '8px',
                          fontWeight: 700,
                          padding: '2px 5px',
                          borderRadius: '4px',
                          background: 'rgba(255, 230, 0, 0.18)',
                          color: '#FFE600',
                        }}
                      >
                        {item.badge}
                      </span>
                    )}
                  </NavLink>
                );
              })}
            </nav>
          </div>
        </div>

        {/* Bottom Footer Section */}
        <div style={{ padding: '16px', borderTop: '1px solid var(--border-subtle)' }}>
          {/* Connection Status Card */}
          <div
            style={{
              padding: '12px 14px',
              borderRadius: '12px',
              background: 'rgba(26, 30, 14, 0.6)',
              border: '1px solid var(--border-subtle)',
              marginBottom: '10px',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '4px' }}>
              <span style={{ fontSize: '11px', color: '#64748B', fontWeight: 500 }}>Engine Telemetry</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <span className="pulsing-dot">
                  <span
                    className="pulsing-dot-ping"
                    style={{ backgroundColor: isConnected ? '#FFE600' : '#F59E0B' }}
                  />
                  <span
                    className="pulsing-dot-core"
                    style={{ backgroundColor: isConnected ? '#FFE600' : '#F59E0B' }}
                  />
                </span>
                <span
                  className="mono"
                  style={{
                    fontSize: '10px',
                    fontWeight: 700,
                    color: isConnected ? '#FFE600' : '#F59E0B',
                    letterSpacing: '0.04em',
                  }}
                >
                  {isConnected ? 'ONLINE' : 'CONNECTING'}
                </span>
              </div>
            </div>
            <p className="mono" style={{ fontSize: '10px', color: '#475569' }}>
              Socket.IO Cluster Mesh
            </p>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '10px', color: '#475569', padding: '0 4px' }}>
            <span>QueueFlow Command v1.0</span>
            <span>Secure TLS</span>
          </div>
        </div>
      </aside>
    </>
  );
}
