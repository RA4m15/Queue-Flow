import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { authAPI } from '../services/api';
import { disconnectSocket } from '../services/socket';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(() => {
    const saved = localStorage.getItem('queueflow_admin_user');
    return saved ? JSON.parse(saved) : null;
  });
  const [token, setToken] = useState(() => localStorage.getItem('queueflow_admin_token'));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Load user profile on mount if token exists
  useEffect(() => {
    async function loadUser() {
      if (!token) {
        setLoading(false);
        return;
      }
      try {
        const res = await authAPI.getMe();
        if (res.success && res.data?.user) {
          const userData = res.data.user;
          // Security check: Only STAFF and ADMIN allowed in Admin Panel
          if (!['ADMIN', 'STAFF'].includes(userData.role)) {
            throw new Error('Access denied. Admin or Staff role required.');
          }
          setUser(userData);
          localStorage.setItem('queueflow_admin_user', JSON.stringify(userData));
        }
      } catch (err) {
        console.warn('Failed to verify existing session:', err.message);
        logout();
      } finally {
        setLoading(false);
      }
    }
    loadUser();
  }, [token]);

  const login = useCallback(async (email, password) => {
    setError(null);
    try {
      const res = await authAPI.login(email, password);
      if (!res.success || !res.data) {
        throw new Error(res.message || 'Login failed');
      }

      const { token: newToken, user: userData } = res.data;

      // Verify role boundary
      if (!['ADMIN', 'STAFF'].includes(userData.role)) {
        throw new Error('Access denied. This panel is restricted to Admin and Staff only.');
      }

      disconnectSocket();
      localStorage.setItem('queueflow_admin_token', newToken);
      localStorage.setItem('queueflow_admin_user', JSON.stringify(userData));
      setToken(newToken);
      setUser(userData);

      return userData;
    } catch (err) {
      setError(err.message);
      throw err;
    }
  }, []);

  const logout = useCallback(async () => {
    try {
      await authAPI.logout();
    } catch (_) {
      // Best effort remote logout
    } finally {
      localStorage.removeItem('queueflow_admin_token');
      localStorage.removeItem('queueflow_admin_user');
      disconnectSocket();
      setToken(null);
      setUser(null);
    }
  }, []);

  const value = {
    user,
    token,
    loading,
    error,
    isAuthenticated: !!user && !!token,
    isAdmin: user?.role === 'ADMIN',
    isStaff: user?.role === 'STAFF',
    login,
    logout,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
