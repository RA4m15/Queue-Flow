import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { authAPI, tokenAPI } from '../services/api';
import { storage } from '../services/storage';
import { connectSocket, disconnectSocket } from '../services/socket';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(() => storage.getUser());
  const [token, setToken] = useState(() => storage.getToken());
  const [activeToken, setActiveToken] = useState(() => storage.getLastKnownToken());
  const [loading, setLoading] = useState(true);

  const refreshActiveToken = useCallback(async () => {
    if (!storage.getToken()) {
      setActiveToken(null);
      return null;
    }
    try {
      const res = await tokenAPI.getActive();
      const current = res.data?.token || null;
      setActiveToken(current);
      if (current) {
        storage.setLastKnownToken(current);
      }
      return current;
    } catch {
      // Keep cached last known token if offline/error
      return storage.getLastKnownToken();
    }
  }, []);

  // Initialize auth state
  useEffect(() => {
    let mounted = true;

    async function initAuth() {
      const savedToken = storage.getToken();
      if (!savedToken) {
        if (mounted) setLoading(false);
        return;
      }

      try {
        const meRes = await authAPI.getMe();
        if (mounted && meRes.data?.user) {
          setUser(meRes.data.user);
          storage.setUser(meRes.data.user);
          connectSocket();
        }
      } catch {
        // If 401 or invalid token, clean up
        if (mounted) {
          setUser(null);
          setToken(null);
          storage.removeToken();
          storage.removeUser();
          disconnectSocket();
        }
      }

      // Check active token
      try {
        if (mounted) {
          await refreshActiveToken();
        }
      } catch {}

      if (mounted) setLoading(false);
    }

    initAuth();

    // Listen to global 401 unauthorized events
    const handleUnauthorized = () => {
      if (mounted) {
        setUser(null);
        setToken(null);
        setActiveToken(null);
        storage.clearAllSession();
        disconnectSocket();
      }
    };

    window.addEventListener('queueflow:unauthorized', handleUnauthorized);

    return () => {
      mounted = false;
      window.removeEventListener('queueflow:unauthorized', handleUnauthorized);
    };
  }, [refreshActiveToken]);

  const login = async (email, password) => {
    const res = await authAPI.login(email, password);
    const { token: newToken, user: newUser } = res.data;
    storage.setToken(newToken);
    storage.setUser(newUser);
    setToken(newToken);
    setUser(newUser);
    connectSocket();
    await refreshActiveToken();
    return newUser;
  };

  const register = async (name, email, password, phone) => {
    const res = await authAPI.register(name, email, password, phone);
    const { token: newToken, user: newUser } = res.data;
    storage.setToken(newToken);
    storage.setUser(newUser);
    setToken(newToken);
    setUser(newUser);
    connectSocket();
    await refreshActiveToken();
    return newUser;
  };

  const logout = async () => {
    try {
      await authAPI.logout();
    } catch {}
    storage.removeToken();
    storage.removeUser();
    storage.setLastKnownToken(null);
    setToken(null);
    setUser(null);
    setActiveToken(null);
    disconnectSocket();
  };

  const value = {
    user,
    token,
    activeToken,
    isAuthenticated: Boolean(token && user),
    loading,
    login,
    register,
    logout,
    setActiveToken,
    refreshActiveToken,
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
