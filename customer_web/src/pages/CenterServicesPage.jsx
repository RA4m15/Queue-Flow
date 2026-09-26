import { useState, useEffect, useCallback } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { serviceCenterAPI, serviceAPI } from '../services/api';
import { SkeletonLoader } from '../components/SkeletonLoader';
import { ErrorAlert } from '../components/ErrorAlert';

export function CenterServicesPage() {
  const { id: centerId } = useParams();
  const navigate = useNavigate();

  const [center, setCenter] = useState(null);
  const [services, setServices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchData = useCallback(async () => {
    if (!centerId) return;
    try {
      setLoading(true);
      setError(null);

      // Fetch center detail and services in parallel
      const [centerRes, servicesRes] = await Promise.all([
        serviceCenterAPI.getById(centerId),
        serviceAPI.listByCenter(centerId),
      ]);

      setCenter(centerRes.data?.serviceCenter || centerRes.data || null);
      const sList = servicesRes.data?.services || servicesRes.data || [];
      setServices(Array.isArray(sList) ? sList : []);
    } catch (err) {
      setError(err.message || 'Failed to load center services');
    } finally {
      setLoading(false);
    }
  }, [centerId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
      {/* Back button & Breadcrumb */}
      <div>
        <Link
          to="/centers"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '0.4rem',
            color: 'var(--text-secondary)',
            fontSize: '0.85rem',
            marginBottom: '0.75rem',
          }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polyline points="15 18 9 12 15 6" />
          </svg>
          Back to Service Centers
        </Link>

        {center && (
          <div>
            <h1 style={{ fontSize: '1.8rem', fontWeight: '800', marginBottom: '0.2rem' }}>
              {center.name}
            </h1>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
              Select a service below to view queue status and join.
            </p>
          </div>
        )}
      </div>

      {/* Content States */}
      {loading ? (
        <SkeletonLoader count={3} />
      ) : error ? (
        <ErrorAlert message={error} onRetry={fetchData} />
      ) : services.length === 0 ? (
        <div
          className="qf-card"
          style={{
            textAlign: 'center',
            padding: '3rem 1.5rem',
            color: 'var(--text-secondary)',
          }}
        >
          <h3 style={{ fontSize: '1.1rem', fontWeight: '700', color: 'var(--text-main)', marginBottom: '0.25rem' }}>
            No services available
          </h3>
          <p style={{ fontSize: '0.85rem' }}>
            This service center currently has no active services listed.
          </p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.85rem' }}>
          {services.map((service) => {
            const isActive = service.isActive !== false;

            return (
              <div
                key={service._id}
                role="button"
                tabIndex={isActive ? 0 : -1}
                aria-disabled={!isActive}
                onClick={() => {
                  if (isActive) {
                    navigate(`/queue/preview?centerId=${centerId}&serviceId=${service._id}`);
                  }
                }}
                onKeyDown={(e) => {
                  if (isActive && (e.key === 'Enter' || e.key === ' ')) {
                    e.preventDefault();
                    navigate(`/queue/preview?centerId=${centerId}&serviceId=${service._id}`);
                  }
                }}
                className={`qf-card ${isActive ? 'qf-card-interactive' : ''}`}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: '1rem',
                  opacity: isActive ? 1 : 0.5,
                  cursor: isActive ? 'pointer' : 'not-allowed',
                }}
              >
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.25rem' }}>
                    <h2 style={{ fontSize: '1.1rem', fontWeight: '700', color: 'var(--text-main)' }}>
                      {service.name}
                    </h2>
                    {service.tokenPrefix && (
                      <span
                        style={{
                          fontSize: '0.7rem',
                          fontFamily: 'var(--font-mono)',
                          fontWeight: '700',
                          padding: '0.15rem 0.45rem',
                          borderRadius: '4px',
                          background: 'rgba(0, 229, 168, 0.12)',
                          color: 'var(--color-primary)',
                        }}
                      >
                        {service.tokenPrefix}
                      </span>
                    )}
                    {!isActive && (
                      <span
                        style={{
                          fontSize: '0.7rem',
                          fontWeight: '700',
                          padding: '0.15rem 0.45rem',
                          borderRadius: '4px',
                          background: 'rgba(239, 68, 68, 0.15)',
                          color: '#F87171',
                          textTransform: 'uppercase',
                        }}
                      >
                        Unavailable
                      </span>
                    )}
                  </div>

                  {service.description && (
                    <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '0.4rem' }}>
                      {service.description}
                    </p>
                  )}

                  <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                    {service.avgServiceTimeMinutes !== undefined && service.avgServiceTimeMinutes !== null && (
                      <span>Avg. ~{service.avgServiceTimeMinutes} mins</span>
                    )}
                  </div>
                </div>

                <div style={{ color: isActive ? 'var(--color-primary)' : 'var(--text-muted)' }} aria-hidden="true">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="9 18 15 12 9 6" />
                  </svg>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
