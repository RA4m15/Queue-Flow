import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { serviceCenterAPI } from '../services/api';
import { SkeletonLoader } from '../components/SkeletonLoader';
import { ErrorAlert } from '../components/ErrorAlert';

export function CentersPage() {
  const [centers, setCenters] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState('');

  const fetchCenters = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await serviceCenterAPI.list();
      // Handle array or wrapped object from backend sendSuccess({ data: { centers } }) or { data: [...] }
      const list = res.data?.centers || res.data || [];
      setCenters(Array.isArray(list) ? list : []);
    } catch (err) {
      setError(err.message || 'Failed to fetch service centers');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchCenters();
  }, [fetchCenters]);

  const filteredCenters = centers.filter((c) => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    const name = (c.name || '').toLowerCase();
    const type = (c.type || '').toLowerCase();
    const address = typeof c.address === 'string'
      ? c.address.toLowerCase()
      : `${c.address?.street || ''} ${c.address?.city || ''}`.toLowerCase();
    return name.includes(q) || type.includes(q) || address.includes(q);
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
      <div>
        <h1 style={{ fontSize: '1.8rem', fontWeight: '800', marginBottom: '0.25rem' }}>
          Select Service Center
        </h1>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
          Choose a location to view available services and live queues.
        </p>
      </div>

      {/* Search Input */}
      <div>
        <label htmlFor="center-search" className="sr-only" style={{ display: 'none' }}>
          Search service centers
        </label>
        <input
          id="center-search"
          type="search"
          className="form-input"
          placeholder="Search by center name, city, or type..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Search service centers"
        />
      </div>

      {/* Content States */}
      {loading ? (
        <SkeletonLoader count={4} />
      ) : error ? (
        <ErrorAlert message={error} onRetry={fetchCenters} />
      ) : filteredCenters.length === 0 ? (
        <div
          className="qf-card"
          style={{
            textAlign: 'center',
            padding: '3rem 1.5rem',
            color: 'var(--text-secondary)',
          }}
        >
          <svg
            width="48"
            height="48"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ margin: '0 auto 1rem auto', color: 'var(--text-muted)' }}
            aria-hidden="true"
          >
            <rect x="2" y="7" width="20" height="14" rx="2" ry="2" />
            <path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16" />
          </svg>
          <h3 style={{ fontSize: '1.1rem', fontWeight: '700', color: 'var(--text-main)', marginBottom: '0.25rem' }}>
            No service centers available
          </h3>
          <p style={{ fontSize: '0.85rem' }}>
            {search ? 'Try adjusting your search criteria.' : 'Check back later or contact support.'}
          </p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.85rem' }}>
          {filteredCenters.map((center) => {
            const formattedAddress = typeof center.address === 'string'
              ? center.address
              : center.address
                ? `${center.address.street || ''}${center.address.city ? `, ${center.address.city}` : ''}`
                : '';

            return (
              <Link
                key={center._id}
                to={`/center/${center._id}`}
                className="qf-card qf-card-interactive"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: '1rem',
                  textDecoration: 'none',
                }}
              >
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.25rem' }}>
                    <h2 style={{ fontSize: '1.15rem', fontWeight: '700', color: 'var(--text-main)' }}>
                      {center.name}
                    </h2>
                    {center.type && (
                      <span
                        style={{
                          fontSize: '0.7rem',
                          fontWeight: '700',
                          padding: '0.15rem 0.45rem',
                          borderRadius: '4px',
                          background: 'rgba(255, 255, 255, 0.08)',
                          color: 'var(--text-secondary)',
                          textTransform: 'uppercase',
                        }}
                      >
                        {center.type}
                      </span>
                    )}
                  </div>

                  {formattedAddress && (
                    <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
                        <circle cx="12" cy="10" r="3" />
                      </svg>
                      {formattedAddress}
                    </p>
                  )}
                </div>

                <div
                  style={{
                    color: 'var(--color-primary)',
                    display: 'flex',
                    alignItems: 'center',
                  }}
                  aria-hidden="true"
                >
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="9 18 15 12 9 6" />
                  </svg>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
