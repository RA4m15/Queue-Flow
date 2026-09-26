import axios from 'axios';
import { storage } from './storage';

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:5000';

const api = axios.create({
  baseURL: `${API_BASE_URL}/api`,
  timeout: 15000,
  headers: {
    'Content-Type': 'application/json',
  },
});

// Request interceptor: attach customer JWT if present
api.interceptors.request.use(
  (config) => {
    const token = storage.getToken();
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error) => Promise.reject(error)
);

// Response interceptor: handle 401 and errors cleanly
api.interceptors.response.use(
  (response) => response.data,
  (error) => {
    if (error.response && error.response.status === 401) {
      storage.removeToken();
      storage.removeUser();
      window.dispatchEvent(new CustomEvent('queueflow:unauthorized'));
    }
    const message =
      error.response?.data?.message ||
      error.message ||
      'An unexpected network error occurred';
    
    const customError = new Error(message);
    customError.status = error.response?.status;
    customError.data = error.response?.data;
    return Promise.reject(customError);
  }
);

// ─── Customer API Methods ───────────────────────────────────────────────────

export const authAPI = {
  register: (name, email, password, phone) => 
    api.post('/auth/register', { name, email, password, phone: phone || undefined }),
  login: (email, password) => 
    api.post('/auth/login', { email, password }),
  getMe: () => 
    api.get('/auth/me'),
  logout: () => 
    api.post('/auth/logout').catch(() => {}),
};

export const serviceCenterAPI = {
  list: () => 
    api.get('/service-centers'),
  getById: (id) => 
    api.get(`/service-centers/${id}`),
};

export const serviceAPI = {
  listByCenter: (centerId) => 
    api.get(`/services${centerId ? `?centerId=${centerId}` : ''}`),
  getById: (id) => 
    api.get(`/services/${id}`),
};

export const queueAPI = {
  getServiceQueue: (centerId, serviceId) => 
    api.get(`/queue/${centerId}/${serviceId}`),
  getCenterQueue: (centerId) => 
    api.get(`/queue/${centerId}`),
  getCenterDisplay: (centerId) =>
    api.get(`/queue/${centerId}/display`),
};

export const tokenAPI = {
  /**
   * Authoritative token generation request.
   * Client NEVER generates token number locally.
   */
  joinQueue: (centerId, serviceId) => 
    api.post('/tokens', { centerId, serviceId }),
  getActive: () => 
    api.get('/tokens/active'),
  getById: (id) => 
    api.get(`/tokens/${id}`),
  getMyTokens: (page = 1, limit = 10) => 
    api.get(`/tokens/my?page=${page}&limit=${limit}`),
  cancel: (id) => 
    api.post(`/tokens/${id}/cancel`),
  getQR: (id) => 
    api.get(`/tokens/${id}/qr`),
};

export const notificationAPI = {
  list: (unreadOnly = false, page = 1, limit = 20) =>
    api.get(`/notifications?unreadOnly=${unreadOnly}&page=${page}&limit=${limit}`),
  markRead: (id) =>
    api.patch(`/notifications/${id}/read`),
  markAllRead: () =>
    api.patch('/notifications/read-all'),
};

export default api;
