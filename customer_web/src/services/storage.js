/**
 * QueueFlow — Customer Web Storage Utility
 * Handles token, user session, and offline state caching safely.
 */

const TOKEN_KEY = 'queueflow_customer_token';
const USER_KEY = 'queueflow_customer_user';
const LAST_TOKEN_KEY = 'queueflow_last_known_token';

export const storage = {
  getToken: () => {
    try {
      return localStorage.getItem(TOKEN_KEY) || null;
    } catch (_) {
      return null;
    }
  },

  setToken: (token) => {
    try {
      if (token) {
        localStorage.setItem(TOKEN_KEY, token);
      } else {
        localStorage.removeItem(TOKEN_KEY);
      }
    } catch (_) {}
  },

  removeToken: () => {
    try {
      localStorage.removeItem(TOKEN_KEY);
    } catch (_) {}
  },

  getUser: () => {
    try {
      const raw = localStorage.getItem(USER_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (_) {
      return null;
    }
  },

  setUser: (user) => {
    try {
      if (user) {
        localStorage.setItem(USER_KEY, JSON.stringify(user));
      } else {
        localStorage.removeItem(USER_KEY);
      }
    } catch (_) {}
  },

  removeUser: () => {
    try {
      localStorage.removeItem(USER_KEY);
    } catch (_) {}
  },

  getLastKnownToken: () => {
    try {
      const raw = localStorage.getItem(LAST_TOKEN_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (_) {
      return null;
    }
  },

  setLastKnownToken: (token) => {
    try {
      if (token) {
        localStorage.setItem(LAST_TOKEN_KEY, JSON.stringify(token));
      } else {
        localStorage.removeItem(LAST_TOKEN_KEY);
      }
    } catch (_) {}
  },

  clearAllSession: () => {
    try {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(USER_KEY);
    } catch (_) {}
  }
};
