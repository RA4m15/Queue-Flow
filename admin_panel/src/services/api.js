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
  /**
   * List service centers.
   *
   * The backend owns what "available" means, so this never filters locally or
   * hardcodes a center list. Pass `{ isOpen: true }` for the operational
   * facility picker so it shows only centers customers can actually queue at.
   * Omitting the option keeps the full list, which management/history views
   * need in order to inspect deactivated facilities and their past data.
   */
  list: ({ isOpen } = {}) =>
    api.get(`/service-centers${isOpen === undefined ? '' : `?isOpen=${isOpen}`}`),
  getById: (id) => api.get(`/service-centers/${id}`),
  update: (id, payload) => api.patch(`/service-centers/${id}`, payload),
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

  /**
   * Operator panel state for ONE counter.
   *
   * `centerId` is the ACTIVE FACILITY and `counterId` the counter chosen from
   * the "CHOOSE COUNTER" list. Both are sent whenever known so the backend can
   * reject any request that pairs a counter with a facility it does not belong
   * to — that pairing is what previously let one screen show two different
   * service centers at once.
   */
  getOperatorCounter: (centerId, counterId) => {
    const params = new URLSearchParams();
    if (centerId) params.set('centerId', centerId);
    if (counterId) params.set('counterId', counterId);
    const qs = params.toString();
    return api.get(`/counters/operator/me${qs ? `?${qs}` : ''}`);
  },

  /**
   * Real counters the operator may consider running, for the currently selected
   * facility. Always fetched from the backend — the counter list is never
   * hardcoded in the client.
   */
  getOperableCounters: (centerId) =>
    api.get(`/counters/operable${centerId ? `?centerId=${centerId}` : ''}`),

  updateStatus: (id, status, centerId) =>
    api.patch(`/counters/${id}/status`, { status, centerId }),
  assignService: (id, serviceId) => api.patch(`/counters/${id}/assign`, { serviceId }),
  morph: (id, serviceId, reason) => api.patch(`/counters/${id}/morph`, { serviceId, reason }),
  getOperators: (centerId) => api.get(`/counters/operators${centerId ? `?centerId=${centerId}` : ''}`),
  assignStaff: (id, staffId) => api.patch(`/counters/${id}/assign-staff`, { staffId }),
  callNext: (id, centerId) => api.post(`/counters/${id}/call-next`, { centerId }),
  recall: (id, centerId) => api.post(`/counters/${id}/recall`, { centerId }),
  startServing: (id, centerId) => api.post(`/counters/${id}/start-serving`, { centerId }),
  complete: (id, centerId) => api.post(`/counters/${id}/complete`, { centerId }),
  skip: (id, tokenId, centerId) => api.post(`/counters/${id}/skip`, { tokenId, centerId }),
  // Centralized resource allocation: authoritative per-center snapshot read
  // straight from the backend allocator. No client-side derivation.
  getAllocationOverview: (centerId) =>
    api.get(`/counters/allocation/overview${centerId ? `?centerId=${centerId}` : ''}`),
  runAllocation: (centerId) => api.post('/counters/allocation/trigger', { centerId }),
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

export const serviceGraphAPI = {
  getByCenter: (centerId) => api.get(`/service-graph/${centerId}`),
  createEdge: (data) => api.post('/service-graph/edges', data),
  updateEdge: (id, data) => api.patch(`/service-graph/edges/${id}`, data),
  deleteEdge: (id) => api.delete(`/service-graph/edges/${id}`),
};

// ─── Tier 4 Feature 4: Document Requirement & Review API ───────────────────
export const documentAPI = {
  getRequirements: (serviceId) => api.get(`/documents/services/${serviceId}/requirements`),
  createRequirement: (serviceId, data) => api.post(`/documents/services/${serviceId}/requirements`, data),
  updateRequirement: (id, data) => api.patch(`/documents/requirements/${id}`, data),
  deleteRequirement: (id) => api.delete(`/documents/requirements/${id}`),
  getPendingReviews: (page = 1, limit = 20) => api.get(`/documents/pending?page=${page}&limit=${limit}`),
  verifyDocument: (id, status, rejectionReason = '') =>
    api.patch(`/documents/${id}/verify`, { status, rejectionReason }),
  downloadDocument: (id) => api.get(`/documents/${id}/download`, { responseType: 'blob' }),
};

// ─── Tier 4 Feature 5: Cognitive Load / Workload Balancer API ────────────────
export const workloadAPI = {
  getCenterWorkload: (centerId) => api.get(`/analytics/${centerId}/workload`),
  getOperatorWorkloads: (centerId, serviceId) =>
    api.get(`/analytics/${centerId}/workload/operators${serviceId ? `?serviceId=${serviceId}` : ''}`),
  getMyWorkload: (centerId) => api.get(`/analytics/${centerId}/workload/me`),
  getRecommendations: (centerId) => api.get(`/analytics/${centerId}/workload/recommendations`),
};

export default api;
