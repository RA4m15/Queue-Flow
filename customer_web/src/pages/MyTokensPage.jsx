import { useState, useEffect, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { tokenAPI } from '../services/api';
import { useAuth } from '../context/AuthContext';
import { StatusBadge } from '../components/StatusBadge';
import { SkeletonLoader } from '../components/SkeletonLoader';
import { ErrorAlert } from '../components/ErrorAlert';

export function MyTokensPage() {
  const { isAuthenticated } = useAuth();
  const navigate = useNavigate();

  const [tokens, setTokens] = useState([]);
  const [filter, setFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchMyTokens = useCallback(async () => {
    if (!isAuthenticated) {
      setLoading(false);
      return;
    }
    try {
      setLoading(true);
      setError(null);
      const res = await tokenAPI.getMyTokens(1, 20);
      const list = res.data?.tokens || res.data || [];
      setTokens(Array.isArray(list) ? list : []);
    } catch (err) {
      setError(err.message || 'Failed to fetch tokens');
    } finally {
      setLoading(false);
    }
  }, [isAuthenticated]);

  useEffect(() => {
    fetchMyTokens();
  }, [fetchMyTokens]);

  if (!isAuthenticated) {
    return (
      <div className="qf-card" style={{ textAlign: 'center', padding: '3rem 1.5rem' }}>
        <h2 style={{ fontSize: '1.3rem', fontWeight: '800', marginBottom: '0.5rem' }}>
          Sign In to View Your Tokens
        </h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginBottom: '1.5rem' }}>
          Please log in to see your active tickets and queue history.
        </p>
        <Link to="/login?returnTo=/my-tokens" className="btn-primary">
          Sign In
        </Link>
      </div>
    );
  }

  const filteredTokens = tokens.filter((t) => {
    if (!filter) return true;
    if (filter === 'ACTIVE') {
      return ['WAITING', 'CALLED', 'SERVING'].includes(t.status);
    }
    return t.status === filter;
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
      <div>
        <h1 style={{ fontSize: '1.8rem', fontWeight: '800', marginBottom: '0.2rem' }}>
          My Tokens
        </h1>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
          Track and manage your digital queue tickets.
        </p>
      </div>

      {/* Filter Tabs */}
      <div style={{ display: 'flex', gap: '0.5rem', overflowX: 'auto', paddingBottom: '0.25rem' }}>
        {[
          { key: '', label: 'All Tickets' },
          { key: 'ACTIVE', label: 'Active' },
          { key: 'COMPLETED', label: 'Completed' },
          { key: 'CANCELLED', label: 'Cancelled' },
        ].map((tab) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => setFilter(tab.key)}
            className="btn-secondary"
            style={{
              padding: '0.4rem 0.85rem',
              fontSize: '0.8rem',
              borderRadius: '9999px',
              background: filter === tab.key ? 'var(--color-primary-subtle)' : undefined,
              borderColor: filter === tab.key ? 'var(--border-accent)' : undefined,
              color: filter === tab.key ? 'var(--color-primary)' : undefined,
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Content */}
      {loading ? (
        <SkeletonLoader count={3} />
      ) : error ? (
        <ErrorAlert message={error} onRetry={fetchMyTokens} />
      ) : filteredTokens.length === 0 ? (
        <div className="qf-card" style={{ textAlign: 'center', padding: '3rem 1.5rem' }}>
          <h3 style={{ fontSize: '1.1rem', fontWeight: '700', marginBottom: '0.25rem' }}>
            No tickets found
          </h3>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginBottom: '1.25rem' }}>
            {filter ? 'No tickets match the selected filter.' : 'You have not joined any queues yet.'}
          </p>
          <Link to="/centers" className="btn-primary">
            Join a Queue
          </Link>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.85rem' }}>
          {filteredTokens.map((t) => {
            const centerName = typeof t.centerId === 'object' && t.centerId?.name
              ? t.centerId.name
              : 'Service Center';
            const serviceName = typeof t.serviceId === 'object' && t.serviceId?.name
              ? t.serviceId.name
              : 'Service';

            return (
              <div
                key={t._id}
                role="button"
                tabIndex={0}
                onClick={() => navigate(`/token/${t._id}`)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    navigate(`/token/${t._id}`);
                  }
                }}
                className="qf-card qf-card-interactive"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: '1rem',
                }}
              >
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.25rem' }}>
                    <span
                      style={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: '1.2rem',
                        fontWeight: '800',
                        color: 'var(--color-primary)',
                      }}
                    >
                      {t.tokenCode}
                    </span>
                    <StatusBadge status={t.status} />
                  </div>

                  <div style={{ fontSize: '0.95rem', fontWeight: '600', color: 'var(--text-main)' }}>
                    {serviceName}
                  </div>
                  <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                    {centerName}
                  </div>
                </div>

                <div style={{ textAlign: 'right', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                  <div>{t.createdAt ? new Date(t.createdAt).toLocaleDateString() : ''}</div>
                  <div>{t.createdAt ? new Date(t.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}</div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
