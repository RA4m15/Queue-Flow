import React, { useState, useEffect } from 'react';
import { serviceGraphAPI } from '../services/api';
import {
  GitCommit,
  ArrowRight,
  Plus,
  Trash2,
  CheckCircle,
  XCircle,
  RefreshCw,
  AlertTriangle,
  Info,
  Layers,
} from 'lucide-react';

export function ServiceGraphManager({ centerId, isAdmin }) {
  const [graphData, setGraphData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showAddModal, setShowAddModal] = useState(false);
  const [formError, setFormError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const [newEdge, setNewEdge] = useState({
    sourceServiceId: '',
    targetServiceId: '',
    relationshipType: 'REQUIRED',
    order: 0,
    description: '',
  });

  const loadGraph = async () => {
    if (!centerId) return;
    try {
      setLoading(true);
      setError(null);
      const res = await serviceGraphAPI.getByCenter(centerId);
      setGraphData(res.data || null);
    } catch (err) {
      setError(err.message || 'Failed to load service graph');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadGraph();
  }, [centerId]);

  const handleAddEdge = async (e) => {
    e.preventDefault();
    if (!newEdge.sourceServiceId || !newEdge.targetServiceId) {
      setFormError('Please select both source and target services');
      return;
    }
    if (newEdge.sourceServiceId === newEdge.targetServiceId) {
      setFormError('Self-loop relationships are not permitted');
      return;
    }

    try {
      setSubmitting(true);
      setFormError(null);
      await serviceGraphAPI.createEdge({
        centerId,
        sourceServiceId: newEdge.sourceServiceId,
        targetServiceId: newEdge.targetServiceId,
        relationshipType: newEdge.relationshipType,
        order: Number(newEdge.order) || 0,
        description: newEdge.description || undefined,
      });
      setShowAddModal(false);
      setNewEdge({
        sourceServiceId: '',
        targetServiceId: '',
        relationshipType: 'REQUIRED',
        order: 0,
        description: '',
      });
      await loadGraph();
    } catch (err) {
      setFormError(err.message || 'Failed to create workflow edge');
    } finally {
      setSubmitting(false);
    }
  };

  const handleToggleActive = async (edge) => {
    try {
      await serviceGraphAPI.updateEdge(edge._id, { isActive: !edge.isActive });
      await loadGraph();
    } catch (err) {
      alert(err.message || 'Failed to update edge');
    }
  };

  const handleDeleteEdge = async (edgeId) => {
    if (!window.confirm('Delete this workflow relationship?')) return;
    try {
      await serviceGraphAPI.deleteEdge(edgeId);
      await loadGraph();
    } catch (err) {
      alert(err.message || 'Failed to delete edge');
    }
  };

  if (loading) {
    return (
      <div style={{ padding: '40px', textAlign: 'center', color: 'var(--text-muted)' }}>
        <RefreshCw size={24} className="spin" style={{ marginBottom: '8px' }} />
        <div>Loading Service Graph...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ padding: '24px', background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: '12px', color: '#F87171' }}>
        <AlertTriangle size={18} style={{ display: 'inline', marginRight: '6px' }} />
        {error}
        <button onClick={loadGraph} className="btn-secondary" style={{ display: 'block', marginTop: '12px' }}>
          Retry
        </button>
      </div>
    );
  }

  const nodes = graphData?.nodes || [];
  const edges = graphData?.edges || [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      {/* Header bar */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '12px' }}>
        <div>
          <h3 style={{ fontSize: '16px', fontWeight: 700, color: 'var(--text-main)', display: 'flex', alignItems: 'center', gap: '8px', margin: 0 }}>
            <GitCommit size={18} style={{ color: 'var(--color-primary)' }} />
            Service Graph & Multi-Hop Workflows
          </h3>
          <p style={{ fontSize: '12px', color: 'var(--text-secondary)', margin: '4px 0 0 0' }}>
            Configure multi-step customer journeys across services for this center.
          </p>
        </div>

        <div style={{ display: 'flex', gap: '8px' }}>
          <button onClick={loadGraph} className="btn-secondary" style={{ padding: '6px 12px', fontSize: '12px' }} title="Refresh Graph">
            <RefreshCw size={13} style={{ marginRight: '5px' }} />
            Refresh
          </button>
          {isAdmin && (
            <button
              onClick={() => {
                setFormError(null);
                setShowAddModal(true);
              }}
              className="btn-primary"
              style={{ padding: '6px 14px', fontSize: '12px' }}
            >
              <Plus size={14} style={{ marginRight: '5px' }} />
              Add Workflow Edge
            </button>
          )}
        </div>
      </div>

      {/* Nodes Overview Grid */}
      <div style={{ background: 'rgba(15,23,42,0.4)', border: '1px solid var(--border-subtle)', borderRadius: '12px', padding: '16px' }}>
        <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '12px', display: 'flex', alignItems: 'center', gap: '6px' }}>
          <Layers size={13} />
          Services in Workflow ({nodes.length})
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '10px' }}>
          {nodes.map((node) => (
            <div
              key={node._id}
              style={{
                padding: '10px 12px',
                background: 'rgba(8,12,22,0.6)',
                border: '1px solid var(--border-subtle)',
                borderRadius: '8px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span
                  style={{
                    fontFamily: 'monospace',
                    fontWeight: 800,
                    fontSize: '12px',
                    color: 'var(--color-primary)',
                    background: 'rgba(255, 230, 0,0.1)',
                    padding: '2px 6px',
                    borderRadius: '4px',
                  }}
                >
                  {node.tokenPrefix}
                </span>
                <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-main)' }}>
                  {node.name}
                </span>
              </div>
              <span style={{ fontSize: '10px', color: node.isActive ? 'var(--color-primary)' : 'var(--text-muted)' }}>
                {node.isActive ? 'Active' : 'Inactive'}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Edges Table / List */}
      <div style={{ background: 'rgba(15,23,42,0.4)', border: '1px solid var(--border-subtle)', borderRadius: '12px', padding: '16px' }}>
        <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '12px' }}>
          Configured Workflow Relationships ({edges.length})
        </div>

        {edges.length === 0 ? (
          <div style={{ padding: '32px', textAlign: 'center', color: 'var(--text-secondary)', fontSize: '13px' }}>
            <Info size={24} style={{ display: 'block', margin: '0 auto 8px', color: 'var(--text-muted)' }} />
            No workflow relationships configured for this center.
            <div style={{ fontSize: '12px', color: 'var(--text-subtle)', marginTop: '4px' }}>
              Services operate independently until workflow edges are created.
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {edges.map((edge) => (
              <div
                key={edge._id}
                style={{
                  padding: '12px 16px',
                  background: 'rgba(8,12,22,0.7)',
                  border: `1px solid ${edge.isActive ? 'var(--border-subtle)' : 'rgba(239,68,68,0.2)'}`,
                  borderRadius: '10px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  flexWrap: 'wrap',
                  gap: '12px',
                  opacity: edge.isActive ? 1 : 0.6,
                }}
              >
                {/* Source -> Target */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <span style={{ fontFamily: 'monospace', fontWeight: 800, color: 'var(--color-primary)' }}>
                      [{edge.sourceServiceId?.tokenPrefix}]
                    </span>
                    <span style={{ fontWeight: 600, fontSize: '13px', color: 'var(--text-main)' }}>
                      {edge.sourceServiceId?.name}
                    </span>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: '4px', color: 'var(--text-muted)' }}>
                    <ArrowRight size={14} style={{ color: 'var(--color-primary)' }} />
                    <span
                      style={{
                        fontSize: '10px',
                        fontWeight: 700,
                        padding: '2px 6px',
                        borderRadius: '4px',
                        background: 'rgba(255, 241, 118,0.1)',
                        color: '#38BDF8',
                        textTransform: 'uppercase',
                      }}
                    >
                      {edge.relationshipType}
                    </span>
                    <ArrowRight size={14} style={{ color: 'var(--color-primary)' }} />
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <span style={{ fontFamily: 'monospace', fontWeight: 800, color: 'var(--color-primary)' }}>
                      [{edge.targetServiceId?.tokenPrefix}]
                    </span>
                    <span style={{ fontWeight: 600, fontSize: '13px', color: 'var(--text-main)' }}>
                      {edge.targetServiceId?.name}
                    </span>
                  </div>
                </div>

                {/* Actions */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  {isAdmin && (
                    <>
                      <button
                        type="button"
                        onClick={() => handleToggleActive(edge)}
                        className="btn-secondary"
                        style={{ padding: '4px 8px', fontSize: '11px' }}
                        title={edge.isActive ? 'Deactivate Edge' : 'Activate Edge'}
                      >
                        {edge.isActive ? <CheckCircle size={12} color="#FFE600" /> : <XCircle size={12} color="#EF4444" />}
                        <span style={{ marginLeft: '4px' }}>{edge.isActive ? 'Active' : 'Inactive'}</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDeleteEdge(edge._id)}
                        className="btn-danger"
                        style={{ padding: '4px 8px', fontSize: '11px' }}
                        title="Delete Edge"
                      >
                        <Trash2 size={12} />
                      </button>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Add Edge Modal */}
      {showAddModal && (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(10, 11, 5,0.85)',
            backdropFilter: 'blur(8px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '16px',
            zIndex: 100,
          }}
        >
          <div className="qf-card" style={{ maxWidth: '480px', width: '100%', padding: '24px' }}>
            <h3 style={{ fontSize: '16px', fontWeight: 800, color: 'var(--text-main)', marginBottom: '16px' }}>
              Add Workflow Relationship
            </h3>

            {formError && (
              <div style={{ padding: '10px', background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: '8px', color: '#F87171', fontSize: '12px', marginBottom: '16px' }}>
                {formError}
              </div>
            )}

            <form onSubmit={handleAddEdge} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
              <div>
                <label style={{ display: 'block', fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '4px' }}>
                  Source Service (Customer Completes First)
                </label>
                <select
                  value={newEdge.sourceServiceId}
                  onChange={(e) => setNewEdge({ ...newEdge, sourceServiceId: e.target.value })}
                  style={{ width: '100%', padding: '8px 12px', background: 'rgba(8,12,22,0.8)', border: '1px solid var(--border-subtle)', borderRadius: '8px', color: 'var(--text-main)' }}
                  required
                >
                  <option value="">Select source service...</option>
                  {nodes.map((n) => (
                    <option key={n._id} value={n._id}>
                      [{n.tokenPrefix}] {n.name}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '4px' }}>
                  Target Service (Next in Workflow)
                </label>
                <select
                  value={newEdge.targetServiceId}
                  onChange={(e) => setNewEdge({ ...newEdge, targetServiceId: e.target.value })}
                  style={{ width: '100%', padding: '8px 12px', background: 'rgba(8,12,22,0.8)', border: '1px solid var(--border-subtle)', borderRadius: '8px', color: 'var(--text-main)' }}
                  required
                >
                  <option value="">Select target service...</option>
                  {nodes
                    .filter((n) => n._id !== newEdge.sourceServiceId)
                    .map((n) => (
                      <option key={n._id} value={n._id}>
                        [{n.tokenPrefix}] {n.name}
                      </option>
                    ))}
                </select>
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '4px' }}>
                  Relationship Type
                </label>
                <select
                  value={newEdge.relationshipType}
                  onChange={(e) => setNewEdge({ ...newEdge, relationshipType: e.target.value })}
                  style={{ width: '100%', padding: '8px 12px', background: 'rgba(8,12,22,0.8)', border: '1px solid var(--border-subtle)', borderRadius: '8px', color: 'var(--text-main)' }}
                >
                  <option value="REQUIRED">REQUIRED (Mandatory next step)</option>
                  <option value="OPTIONAL">OPTIONAL (Elective continuation)</option>
                  <option value="TRANSFER">TRANSFER (Operator handoff)</option>
                  <option value="RECOMMENDED">RECOMMENDED (Suggested service)</option>
                </select>
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '4px' }}>
                  Description (Optional)
                </label>
                <input
                  type="text"
                  value={newEdge.description}
                  onChange={(e) => setNewEdge({ ...newEdge, description: e.target.value })}
                  placeholder="e.g. Next step for document verification"
                  maxLength={300}
                  style={{ width: '100%', padding: '8px 12px', background: 'rgba(8,12,22,0.8)', border: '1px solid var(--border-subtle)', borderRadius: '8px', color: 'var(--text-main)' }}
                />
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '12px' }}>
                <button
                  type="button"
                  onClick={() => setShowAddModal(false)}
                  className="btn-secondary"
                  disabled={submitting}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn-primary"
                  disabled={submitting}
                >
                  {submitting ? 'Validating Graph...' : 'Create Edge'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
