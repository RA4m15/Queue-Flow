import axios from 'axios';
import { disconnectSocket } from './socket';

const API_BASE_URL = import.meta.env.VITE_API_URL;

const api = axios.create({
  baseURL: `${API_BASE_URL}/api`,
  timeout: 15000,
  headers: {
    'Content-Type': 'application/json',
  },
});

// Request interceptor: attach token
api.interceptors.request.use(
  (config) => {
    const token = localStorage.getItem('queueflow_admin_token');
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error) => Promise.reject(error)
);

// Response interceptor: handle token expiration
api.interceptors.response.use(
  (response) => response.data,
  (error) => {
    if (error.response && error.response.status === 401) {
      // Clear token and disconnect socket on 401
      localStorage.removeItem('queueflow_admin_token');
      localStorage.removeItem('queueflow_admin_user');
      disconnectSocket();
      if (window.location.pathname !== '/login') {
        window.location.href = '/login?expired=1';
      }
    }
    const message =
      error.response?.data?.message ||
      error.message ||
      'An unexpected network error occurred';
    return Promise.reject(new Error(message));
  }
);

// ─── API Methods ─────────────────────────────────────────────────────────────

export const authAPI = {
  login: (email, password) => api.post('/auth/login', { email, password }),
  getMe: () => api.get('/auth/me'),
  logout: () => api.post('/auth/logout'),
};

export const serviceCenterAPI = {
  list: () => api.get('/service-centers'),
  getById: (id) => api.get(`/service-centers/${id}`),
};

export const serviceAPI = {
  /** Public — only active services (used by customer features) */
  list: (centerId) => api.get(`/services${centerId ? `?centerId=${centerId}` : ''}`),
  /** Admin-only — all services including inactive */
  listAdmin: (centerId) => api.get(`/services/admin?centerId=${centerId}`),
  getById: (id) => api.get(`/services/${id}`),
  /** POST /api/services — Admin creates a new service */
  create: (payload) => api.post('/services', payload),
  /** PATCH /api/services/:id — Admin updates name/description/avgTime/isActive/order */
  update: (id, payload) => api.patch(`/services/${id}`, payload),
  /** Convenience toggle — sends {isActive} patch */
  toggleActive: (id, isActive) => api.patch(`/services/${id}`, { isActive }),
};

export const queueAPI = {
  getStatus: (centerId) => api.get(`/queue/${centerId}`),
  getServiceQueue: (centerId, serviceId) => api.get(`/queue/${centerId}/${serviceId}`),
  getRecentEvents: (centerId) => api.get(`/queue/${centerId}/events/recent`),
};

export const counterAPI = {
  list: (centerId) => api.get(`/counters${centerId ? `?centerId=${centerId}` : ''}`),
  getById: (id) => api.get(`/counters/${id}`),
  getOperatorCounter: (centerId, counterId) =>
    api.get(`/counters/operator/me${counterId ? `?counterId=${counterId}` : (centerId ? `?centerId=${centerId}` : '')}`),
  updateStatus: (id, status) => api.patch(`/counters/${id}/status`, { status }),
  assignService: (id, serviceId) => api.patch(`/counters/${id}/assign`, { serviceId }),
  morph: (id, serviceId, reason) => api.patch(`/counters/${id}/morph`, { serviceId, reason }),
  assignStaff: (id, staffId) => api.patch(`/counters/${id}/assign-staff`, { staffId }),
  callNext: (id) => api.post(`/counters/${id}/call-next`),
  recall: (id) => api.post(`/counters/${id}/recall`),
  startServing: (id) => api.post(`/counters/${id}/start-serving`),
  complete: (id) => api.post(`/counters/${id}/complete`),
  skip: (id, tokenId) => api.post(`/counters/${id}/skip`, { tokenId }),
};

export const tokenAPI = {
  getById: (id) => api.get(`/tokens/${id}`),
};

export const crowdAPI = {
  getStatus: (centerId) => api.get(`/crowd/${centerId}`),
  getTodayEvents: (centerId) => api.get(`/crowd/${centerId}/events/today`),
};

export const analyticsAPI = {
  getDashboard: (centerId) => api.get(`/analytics/${centerId}`),
  getTokens: (centerId, hours = 8) => api.get(`/analytics/${centerId}/tokens?hours=${hours}`),
  getOperationalOverview: (centerId) => api.get(`/analytics/${centerId}/operational-overview`),
  getEwtIntelligence: (centerId) => api.get(`/analytics/${centerId}/ewt`),
  getForecast: (centerId, params = {}) => {
    const q = new URLSearchParams();
    if (params.horizonHours) q.set('horizonHours', params.horizonHours);
    if (params.serviceId) q.set('serviceId', params.serviceId);
    if (params.refresh) q.set('refresh', 'true');
    const queryString = q.toString();
    return api.get(`/analytics/${centerId}/forecast${queryString ? `?${queryString}` : ''}`);
  },
  getHistoricalReport: (centerId, params = {}) => {
    const q = new URLSearchParams();
    if (params.timeRange) q.set('timeRange', params.timeRange);
    if (params.startDate) q.set('startDate', params.startDate);
    if (params.endDate) q.set('endDate', params.endDate);
    if (params.serviceId) q.set('serviceId', params.serviceId);
    if (params.counterId) q.set('counterId', params.counterId);
    if (params.targetWaitMinutes) q.set('targetWaitMinutes', params.targetWaitMinutes);
    if (params.page) q.set('page', params.page);
    if (params.limit) q.set('limit', params.limit);
    const queryString = q.toString();
    return api.get(`/analytics/${centerId}/historical${queryString ? `?${queryString}` : ''}`);
  },
  getExportUrl: (centerId, params = {}) => {
    const q = new URLSearchParams();
    if (params.timeRange) q.set('timeRange', params.timeRange);
    if (params.startDate) q.set('startDate', params.startDate);
    if (params.endDate) q.set('endDate', params.endDate);
    if (params.serviceId) q.set('serviceId', params.serviceId);
    if (params.counterId) q.set('counterId', params.counterId);
    const queryString = q.toString();
    return `/api/analytics/${centerId}/historical/export${queryString ? `?${queryString}` : ''}`;
  },
};

export const notificationAPI = {
  getRecent: (centerId) => api.get(`/notifications?centerId=${centerId}`),
  sendBroadcast: (centerId, title, body, userIds = []) =>
    api.post('/notifications/broadcast', { centerId, title, body, userIds }),
};

export const devAPI = {
  simulateCrowd: (centerId, type, count = 1) =>
    api.post('/dev/simulate/crowd', { centerId, type, count }),
  resetCrowd: (centerId) => api.post('/dev/simulate/reset-crowd', { centerId }),
};

export default api;
