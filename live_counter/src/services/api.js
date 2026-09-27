const API_BASE = (import.meta.env.VITE_API_URL || 'http://localhost:5000').replace(/\/$/, '');

/**
 * Fetch authoritative display data for a service center.
 * Endpoint: GET /api/queue/:centerId/display
 * Returns center info, nowServing, nextInQueue, counters, queues, latestCallout, and displayToken.
 */
export async function fetchDisplayData(centerId) {
  if (!centerId) {
    throw new Error('Center ID is required');
  }

  const response = await fetch(`${API_BASE}/api/queue/${centerId}/display`);
  const data = await response.json();

  if (!response.ok || !data.success) {
    const errorMsg = data?.error?.message || data?.message || `HTTP ${response.status} failed to fetch queue display`;
    const err = new Error(errorMsg);
    err.status = response.status;
    throw err;
  }

  return data.data;
}

/**
 * Fetch list of active service centers for initial display configuration.
 * Endpoint: GET /api/service-centers
 */
export async function fetchCenters() {
  const response = await fetch(`${API_BASE}/api/service-centers`);
  const data = await response.json();

  if (!response.ok || !data.success) {
    throw new Error(data?.error?.message || 'Failed to fetch service centers');
  }

  return data.data?.centers || [];
}
