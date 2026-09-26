import { useState, useEffect, useRef } from 'react';
import { notificationAPI } from '../services/api';
import { connectSocket } from '../services/socket';
import { useAuth } from '../context/AuthContext';
import { playChime } from '../utils/announcer';

export function NotificationBell() {
  const { isAuthenticated } = useAuth();
  const [notifications, setNotifications] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [isOpen, setIsOpen] = useState(false);
  const [toast, setToast] = useState(null);
  const dropdownRef = useRef(null);

  // Load initial notifications on auth
  useEffect(() => {
    if (!isAuthenticated) {
      setNotifications([]);
      setUnreadCount(0);
      return;
    }

    let isMounted = true;
    notificationAPI
      .list(false, 1, 15)
      .then((res) => {
        if (isMounted && res?.data) {
          setNotifications(res.data.notifications || []);
          setUnreadCount(res.data.unreadCount || 0);
        }
      })
      .catch(() => {});

    return () => {
      isMounted = false;
    };
  }, [isAuthenticated]);

  // Real-time socket subscription
  useEffect(() => {
    if (!isAuthenticated) return;

    const socket = connectSocket();

    const handleNewNotification = (data) => {
      const notif = data?.notification;
      if (!notif) return;

      setNotifications((prev) => [notif, ...prev.filter((n) => n._id !== notif._id)]);
      setUnreadCount((prev) => prev + 1);

      // Show toast banner
      setToast(notif);
      playChimeSound();

      // Auto-dismiss toast after 6 seconds
      setTimeout(() => {
        setToast((current) => (current?._id === notif._id ? null : current));
      }, 6000);
    };

    socket.on('notification.created', handleNewNotification);

    return () => {
      socket.off('notification.created', handleNewNotification);
    };
  }, [isAuthenticated]);

  // Close dropdown on outside click
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleMarkRead = async (id) => {
    try {
      await notificationAPI.markRead(id);
      setNotifications((prev) =>
        prev.map((n) => (n._id === id ? { ...n, isRead: true } : n))
      );
      setUnreadCount((prev) => Math.max(0, prev - 1));
    } catch (_) {}
  };

  const handleMarkAllRead = async () => {
    try {
      await notificationAPI.markAllRead();
      setNotifications((prev) => prev.map((n) => ({ ...n, isRead: true })));
      setUnreadCount(0);
    } catch (_) {}
  };

  if (!isAuthenticated) return null;

  return (
    <div style={{ position: 'relative' }} ref={dropdownRef}>
      {/* Toast Alert Banner */}
      {toast && (
        <div
          style={{
            position: 'fixed',
            top: '70px',
            right: '20px',
            maxWidth: '380px',
            background: 'rgba(15, 23, 42, 0.95)',
            border: '1px solid var(--color-primary)',
            borderRadius: '12px',
            boxShadow: '0 8px 30px rgba(0, 229, 168, 0.25)',
            padding: '1rem',
            zIndex: 9999,
            display: 'flex',
            alignItems: 'flex-start',
            gap: '0.75rem',
            animation: 'fadeIn 0.3s ease',
          }}
          role="alert"
        >
          <div style={{ fontSize: '1.4rem' }}>
            {toast.type === 'TOKEN_CALLED'
              ? '🔔'
              : toast.type === 'NO_SHOW_WARNING'
                ? '⚠️'
                : '⚡'}
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: '700', fontSize: '0.9rem', color: 'var(--text-main)', marginBottom: '0.2rem' }}>
              {toast.title}
            </div>
            <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', lineHeight: 1.4 }}>
              {toast.body}
            </div>
          </div>
          <button
            type="button"
            onClick={() => setToast(null)}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--text-muted)',
              cursor: 'pointer',
              fontSize: '1rem',
              lineHeight: 1,
            }}
            aria-label="Dismiss alert"
          >
            ×
          </button>
        </div>
      )}

      {/* Bell Button */}
      <button
        type="button"
        onClick={() => setIsOpen((prev) => !prev)}
        style={{
          background: 'transparent',
          border: '1px solid var(--border-subtle)',
          borderRadius: '8px',
          width: '36px',
          height: '36px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'pointer',
          position: 'relative',
          color: 'var(--text-main)',
        }}
        aria-label="Notifications"
        title="View Notifications"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>

        {unreadCount > 0 && (
          <span
            style={{
              position: 'absolute',
              top: '-4px',
              right: '-4px',
              background: 'var(--color-primary)',
              color: '#05070D',
              fontSize: '0.7rem',
              fontWeight: '800',
              borderRadius: '999px',
              padding: '1px 5px',
              minWidth: '16px',
              textAlign: 'center',
              lineHeight: '14px',
              boxShadow: '0 0 8px rgba(0, 229, 168, 0.6)',
            }}
          >
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>

      {/* Dropdown Card */}
      {isOpen && (
        <div
          style={{
            position: 'absolute',
            top: '44px',
            right: '0',
            width: '320px',
            maxHeight: '400px',
            background: 'rgba(10, 15, 29, 0.98)',
            border: '1px solid var(--border-subtle)',
            borderRadius: '12px',
            boxShadow: '0 12px 35px rgba(0, 0, 0, 0.6)',
            backdropFilter: 'blur(16px)',
            zIndex: 100,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
          }}
        >
          {/* Header */}
          <div
            style={{
              padding: '0.75rem 1rem',
              borderBottom: '1px solid var(--border-subtle)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <span style={{ fontWeight: '700', fontSize: '0.85rem', color: 'var(--text-main)' }}>
              Notifications {unreadCount > 0 && `(${unreadCount})`}
            </span>
            {unreadCount > 0 && (
              <button
                type="button"
                onClick={handleMarkAllRead}
                style={{
                  background: 'none',
                  border: 'none',
                  color: 'var(--color-primary)',
                  fontSize: '0.75rem',
                  fontWeight: '600',
                  cursor: 'pointer',
                  padding: 0,
                }}
              >
                Mark all read
              </button>
            )}
          </div>

          {/* List */}
          <div style={{ overflowY: 'auto', flex: 1, maxHeight: '340px' }}>
            {notifications.length === 0 ? (
              <div style={{ padding: '2rem 1rem', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.8rem' }}>
                No notifications yet
              </div>
            ) : (
              notifications.map((n) => (
                <div
                  key={n._id}
                  onClick={() => !n.isRead && handleMarkRead(n._id)}
                  style={{
                    padding: '0.75rem 1rem',
                    borderBottom: '1px solid rgba(255, 255, 255, 0.05)',
                    background: n.isRead ? 'transparent' : 'rgba(0, 229, 168, 0.04)',
                    cursor: n.isRead ? 'default' : 'pointer',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '0.25rem',
                    transition: 'background 0.2s ease',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <span style={{ fontWeight: n.isRead ? '600' : '700', fontSize: '0.82rem', color: 'var(--text-main)' }}>
                      {n.title}
                    </span>
                    {!n.isRead && (
                      <span
                        style={{
                          width: '6px',
                          height: '6px',
                          borderRadius: '50%',
                          background: 'var(--color-primary)',
                          display: 'inline-block',
                        }}
                      />
                    )}
                  </div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', lineHeight: 1.35 }}>
                    {n.body}
                  </div>
                  <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)', marginTop: '0.15rem' }}>
                    {new Date(n.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
