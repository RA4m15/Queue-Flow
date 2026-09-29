import React, { useState, useEffect, useCallback } from 'react';
import { documentAPI } from '../services/api';
import {
  FileText,
  Plus,
  Trash2,
  CheckCircle2,
  XCircle,
  Clock,
  Download,
  AlertCircle,
  Eye,
  RefreshCw,
  X,
} from 'lucide-react';

export function DocumentRequirementsManager({ service, onClose }) {
  const [activeTab, setActiveTab] = useState('requirements'); // 'requirements' | 'reviews'
  const [requirements, setRequirements] = useState([]);
  const [pendingReviews, setPendingReviews] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [successMsg, setSuccessMsg] = useState(null);

  // New requirement form state
  const [showAddForm, setShowAddForm] = useState(false);
  const [docType, setDocType] = useState('');
  const [docName, setDocName] = useState('');
  const [docDesc, setDocDesc] = useState('');
  const [isRequired, setIsRequired] = useState(true);
  const [verificationRequired, setVerificationRequired] = useState(true);

  // Rejection modal state
  const [rejectingDocId, setRejectingDocId] = useState(null);
  const [rejectionReason, setRejectionReason] = useState('');

  const fetchRequirements = useCallback(async () => {
    if (!service?._id) return;
    try {
      setLoading(true);
      setError(null);
      const res = await documentAPI.getRequirements(service._id);
      setRequirements(res.data?.requirements || []);
    } catch (err) {
      setError(err.message || 'Failed to load requirements');
    } finally {
      setLoading(false);
    }
  }, [service?._id]);

  const fetchPendingReviews = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await documentAPI.getPendingReviews();
      setPendingReviews(res.data?.documents || []);
    } catch (err) {
      setError(err.message || 'Failed to load review queue');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (activeTab === 'requirements') {
      fetchRequirements();
    } else {
      fetchPendingReviews();
    }
  }, [activeTab, fetchRequirements, fetchPendingReviews]);

  const handleCreateRequirement = async (e) => {
    e.preventDefault();
    if (!docType.trim() || !docName.trim()) {
      setError('Document Type and Name are required');
      return;
    }

    try {
      setLoading(true);
      setError(null);
      await documentAPI.createRequirement(service._id, {
        documentType: docType.trim().toUpperCase(),
        name: docName.trim(),
        description: docDesc.trim(),
        isRequired,
        verificationRequired,
        isActive: true,
      });

      setSuccessMsg('Requirement added successfully');
      setTimeout(() => setSuccessMsg(null), 3000);
      setShowAddForm(false);
      setDocType('');
      setDocName('');
      setDocDesc('');
      await fetchRequirements();
    } catch (err) {
      setError(err.message || 'Failed to create requirement');
    } finally {
      setLoading(false);
    }
  };

  const handleToggleRequirement = async (reqId, currentActive) => {
    try {
      await documentAPI.updateRequirement(reqId, { isActive: !currentActive });
      await fetchRequirements();
    } catch (err) {
      setError(err.message || 'Failed to update requirement');
    }
  };

  const handleDeleteRequirement = async (reqId) => {
    if (!window.confirm('Are you sure you want to delete this document requirement?')) return;
    try {
      await documentAPI.deleteRequirement(reqId);
      await fetchRequirements();
    } catch (err) {
      setError(err.message || 'Failed to delete requirement');
    }
  };

  const handleVerify = async (docId, status, reason = '') => {
    try {
      await documentAPI.verifyDocument(docId, status, reason);
      setSuccessMsg(`Document ${status.toLowerCase()} successfully`);
      setTimeout(() => setSuccessMsg(null), 3000);
      setRejectingDocId(null);
      setRejectionReason('');
      await fetchPendingReviews();
    } catch (err) {
      setError(err.message || 'Failed to verify document');
    }
  };

  const handleDownload = async (docId, fileName) => {
    try {
      const res = await documentAPI.downloadDocument(docId);
      const url = window.URL.createObjectURL(new Blob([res]));
      const link = document.createElement('a');
      link.href = url;
      link.setAttribute('download', fileName || 'document');
      document.body.appendChild(link);
      link.click();
      link.remove();
    } catch (err) {
      setError(err.message || 'Failed to download document');
    }
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(0,0,0,0.7)',
        backdropFilter: 'blur(4px)',
        zIndex: 1100,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '20px',
      }}
    >
      <div
        style={{
          background: 'var(--bg-card, var(--bg-card-alt))',
          border: '1px solid var(--border-medium, rgba(255,255,255,0.1))',
          borderRadius: '16px',
          width: '100%',
          maxWidth: '850px',
          maxHeight: '90vh',
          display: 'flex',
          flexDirection: 'column',
          boxShadow: '0 24px 48px rgba(0,0,0,0.5)',
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: '20px 24px',
            borderBottom: '1px solid var(--border-subtle, var(--bg-card-alt))',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <FileText size={20} color="var(--color-primary, var(--color-primary))" />
              <h2 style={{ fontSize: '18px', fontWeight: 700, margin: 0, color: 'var(--text-main)' }}>
                Document Gatekeeper — {service.name} ({service.tokenPrefix})
              </h2>
            </div>
            <p style={{ margin: '4px 0 0', fontSize: '12px', color: 'var(--text-muted)' }}>
              Configure mandatory documents and review customer verification submissions.
            </p>
          </div>
          <button
            onClick={onClose}
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--text-muted)',
              cursor: 'pointer',
              padding: '6px',
            }}
          >
            <X size={20} />
          </button>
        </div>

        {/* Tabs */}
        <div
          style={{
            display: 'flex',
            borderBottom: '1px solid var(--border-subtle, var(--bg-card-alt))',
            padding: '0 24px',
            gap: '16px',
            background: 'rgba(0,0,0,0.15)',
          }}
        >
          <button
            onClick={() => setActiveTab('requirements')}
            style={{
              padding: '12px 4px',
              border: 'none',
              borderBottom: activeTab === 'requirements' ? '2px solid var(--color-primary, var(--color-primary))' : '2px solid transparent',
              background: 'transparent',
              color: activeTab === 'requirements' ? 'var(--color-primary, var(--color-primary))' : 'var(--text-secondary)',
              fontWeight: 600,
              fontSize: '13px',
              cursor: 'pointer',
            }}
          >
            Service Requirements ({requirements.length})
          </button>
          <button
            onClick={() => setActiveTab('reviews')}
            style={{
              padding: '12px 4px',
              border: 'none',
              borderBottom: activeTab === 'reviews' ? '2px solid var(--color-primary, var(--color-primary))' : '2px solid transparent',
              background: 'transparent',
              color: activeTab === 'reviews' ? 'var(--color-primary, var(--color-primary))' : 'var(--text-secondary)',
              fontWeight: 600,
              fontSize: '13px',
              cursor: 'pointer',
            }}
          >
            Verification Review Queue ({pendingReviews.length})
          </button>
        </div>

        {/* Content Body */}
        <div style={{ padding: '20px 24px', overflowY: 'auto', flex: 1 }}>
          {error && (
            <div
              style={{
                background: 'color-mix(in srgb, var(--color-danger) 10%, transparent)',
                border: '1px solid var(--color-danger)',
                color: 'var(--color-danger)',
                padding: '10px 14px',
                borderRadius: '8px',
                fontSize: '12px',
                marginBottom: '16px',
              }}
            >
              {error}
            </div>
          )}

          {successMsg && (
            <div
              style={{
                background: 'color-mix(in srgb, var(--color-success) 10%, transparent)',
                border: '1px solid var(--color-success)',
                color: 'var(--color-success)',
                padding: '10px 14px',
                borderRadius: '8px',
                fontSize: '12px',
                marginBottom: '16px',
              }}
            >
              {successMsg}
            </div>
          )}

          {activeTab === 'requirements' && (
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
                <span style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
                  Configured requirements are authoritatively enforced before token minting.
                </span>
                <button
                  className="btn-primary"
                  onClick={() => setShowAddForm(!showAddForm)}
                  style={{ fontSize: '12px', padding: '6px 12px', display: 'flex', alignItems: 'center', gap: '6px' }}
                >
                  <Plus size={14} />
                  {showAddForm ? 'Cancel' : 'Add Requirement'}
                </button>
              </div>

              {showAddForm && (
                <form
                  onSubmit={handleCreateRequirement}
                  style={{
                    background: 'var(--bg-card-alt)',
                    border: '1px solid var(--border-medium)',
                    borderRadius: '10px',
                    padding: '16px',
                    marginBottom: '20px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '12px',
                  }}
                >
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: '12px' }}>
                    <div>
                      <label style={{ fontSize: '11px', color: 'var(--text-muted)', display: 'block', marginBottom: '4px' }}>
                        DOCUMENT TYPE (ID)
                      </label>
                      <input
                        type="text"
                        placeholder="e.g. GOVT_ID"
                        value={docType}
                        onChange={(e) => setDocType(e.target.value)}
                        style={{ width: '100%', padding: '8px', borderRadius: '6px', background: 'var(--bg-input)', border: '1px solid var(--border-subtle)', color: '#fff', fontSize: '12px' }}
                      />
                    </div>
                    <div>
                      <label style={{ fontSize: '11px', color: 'var(--text-muted)', display: 'block', marginBottom: '4px' }}>
                        DISPLAY NAME
                      </label>
                      <input
                        type="text"
                        placeholder="e.g. Government Photo ID"
                        value={docName}
                        onChange={(e) => setDocName(e.target.value)}
                        style={{ width: '100%', padding: '8px', borderRadius: '6px', background: 'var(--bg-input)', border: '1px solid var(--border-subtle)', color: '#fff', fontSize: '12px' }}
                      />
                    </div>
                  </div>

                  <div>
                    <label style={{ fontSize: '11px', color: 'var(--text-muted)', display: 'block', marginBottom: '4px' }}>
                      DESCRIPTION / INSTRUCTIONS
                    </label>
                    <input
                      type="text"
                      placeholder="e.g. Must be valid, unexpired national ID card or passport."
                      value={docDesc}
                      onChange={(e) => setDocDesc(e.target.value)}
                      style={{ width: '100%', padding: '8px', borderRadius: '6px', background: 'var(--bg-input)', border: '1px solid var(--border-subtle)', color: '#fff', fontSize: '12px' }}
                    />
                  </div>

                  <div style={{ display: 'flex', gap: '20px', alignItems: 'center' }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: 'var(--text-main)', cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={isRequired}
                        onChange={(e) => setIsRequired(e.target.checked)}
                      />
                      Mandatory (Blocks token creation if missing)
                    </label>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: 'var(--text-main)', cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={verificationRequired}
                        onChange={(e) => setVerificationRequired(e.target.checked)}
                      />
                      Requires Staff Verification
                    </label>
                  </div>

                  <button
                    type="submit"
                    className="btn-primary"
                    disabled={loading}
                    style={{ alignSelf: 'flex-start', padding: '6px 16px', fontSize: '12px' }}
                  >
                    Save Requirement
                  </button>
                </form>
              )}

              {/* Requirements Table */}
              {requirements.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '32px 16px', color: 'var(--text-muted)', fontSize: '13px' }}>
                  No documentation requirements configured for this service.
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {requirements.map((req) => (
                    <div
                      key={req._id}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        padding: '12px 16px',
                        background: 'var(--bg-card-alt)',
                        border: '1px solid var(--border-subtle)',
                        borderRadius: '8px',
                      }}
                    >
                      <div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                          <span style={{ fontWeight: 600, fontSize: '13px', color: 'var(--text-main)' }}>{req.name}</span>
                          <span style={{ fontSize: '10px', fontFamily: 'monospace', padding: '1px 6px', background: 'var(--bg-card-alt)', borderRadius: '4px', color: 'var(--text-secondary)' }}>
                            {req.documentType}
                          </span>
                          {req.isRequired ? (
                            <span style={{ fontSize: '10px', fontWeight: 700, color: 'var(--color-danger)' }}>REQUIRED</span>
                          ) : (
                            <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>OPTIONAL</span>
                          )}
                          {req.verificationRequired && (
                            <span style={{ fontSize: '10px', color: 'var(--color-warning)' }}>STAFF APPROVAL REQ</span>
                          )}
                        </div>
                        {req.description && (
                          <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '3px' }}>
                            {req.description}
                          </div>
                        )}
                      </div>

                      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                        <button
                          onClick={() => handleToggleRequirement(req._id, req.isActive)}
                          style={{
                            padding: '4px 8px',
                            borderRadius: '4px',
                            fontSize: '11px',
                            fontWeight: 600,
                            cursor: 'pointer',
                            background: req.isActive ? 'rgba(16,185,129,0.15)' : 'rgba(239,68,68,0.15)',
                            color: req.isActive ? 'var(--color-success)' : 'var(--color-danger)',
                            border: 'none',
                          }}
                        >
                          {req.isActive ? 'Active' : 'Disabled'}
                        </button>
                        <button
                          onClick={() => handleDeleteRequirement(req._id)}
                          style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: '4px' }}
                          title="Delete requirement"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {activeTab === 'reviews' && (
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
                <span style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
                  Customer documents pending review across the center.
                </span>
                <button
                  className="btn-secondary"
                  onClick={fetchPendingReviews}
                  style={{ fontSize: '12px', padding: '4px 10px', display: 'flex', alignItems: 'center', gap: '6px' }}
                >
                  <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
                  Refresh Queue
                </button>
              </div>

              {pendingReviews.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '32px 16px', color: 'var(--text-muted)', fontSize: '13px' }}>
                  No pending customer documents awaiting verification.
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  {pendingReviews.map((doc) => (
                    <div
                      key={doc._id}
                      style={{
                        padding: '12px 16px',
                        background: 'var(--bg-card-alt)',
                        border: '1px solid var(--border-subtle)',
                        borderRadius: '8px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        flexWrap: 'wrap',
                        gap: '10px',
                      }}
                    >
                      <div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                          <span style={{ fontWeight: 600, fontSize: '13px', color: 'var(--text-main)' }}>
                            {doc.userId?.name || 'Customer'}
                          </span>
                          <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                            ({doc.userId?.email || 'N/A'})
                          </span>
                          <span style={{ fontSize: '10px', fontFamily: 'monospace', padding: '2px 6px', background: 'rgba(245,158,11,0.15)', color: 'var(--color-warning)', borderRadius: '4px' }}>
                            {doc.documentType}
                          </span>
                        </div>
                        <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '4px' }}>
                          File: {doc.fileName} ({(doc.fileSizeBytes / 1024).toFixed(1)} KB) · Uploaded: {new Date(doc.uploadedAt).toLocaleTimeString()}
                        </div>
                      </div>

                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <button
                          onClick={() => handleDownload(doc._id, doc.fileName)}
                          className="btn-secondary"
                          style={{ fontSize: '11px', padding: '4px 8px', display: 'flex', alignItems: 'center', gap: '4px' }}
                          title="View / Download customer file"
                        >
                          <Download size={12} />
                          Download
                        </button>
                        <button
                          onClick={() => handleVerify(doc._id, 'VERIFIED')}
                          style={{
                            background: 'color-mix(in srgb, var(--color-success) 20%, transparent)',
                            color: 'var(--color-success)',
                            border: '1px solid var(--color-success)',
                            borderRadius: '6px',
                            padding: '4px 10px',
                            fontSize: '11px',
                            fontWeight: 600,
                            cursor: 'pointer',
                          }}
                        >
                          Approve
                        </button>
                        <button
                          onClick={() => setRejectingDocId(doc._id)}
                          style={{
                            background: 'color-mix(in srgb, var(--color-danger) 20%, transparent)',
                            color: 'var(--color-danger)',
                            border: '1px solid var(--color-danger)',
                            borderRadius: '6px',
                            padding: '4px 10px',
                            fontSize: '11px',
                            fontWeight: 600,
                            cursor: 'pointer',
                          }}
                        >
                          Reject
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Rejection Note Modal */}
              {rejectingDocId && (
                <div
                  style={{
                    marginTop: '16px',
                    padding: '14px',
                    borderRadius: '8px',
                    background: 'rgba(239,68,68,0.08)',
                    border: '1px solid rgba(239,68,68,0.3)',
                  }}
                >
                  <label style={{ fontSize: '11px', color: 'var(--color-danger)', fontWeight: 600, display: 'block', marginBottom: '6px' }}>
                    Reason for Rejection (Customer will see this note)
                  </label>
                  <input
                    type="text"
                    placeholder="e.g. Image blurry, name does not match record, or document expired"
                    value={rejectionReason}
                    onChange={(e) => setRejectionReason(e.target.value)}
                    style={{ width: '100%', padding: '8px', borderRadius: '6px', background: 'var(--bg-input)', border: '1px solid var(--border-subtle)', color: '#fff', fontSize: '12px', marginBottom: '10px' }}
                  />
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <button
                      onClick={() => handleVerify(rejectingDocId, 'REJECTED', rejectionReason)}
                      style={{ background: 'var(--color-danger)', color: '#fff', border: 'none', borderRadius: '6px', padding: '6px 14px', fontSize: '11px', fontWeight: 600, cursor: 'pointer' }}
                    >
                      Confirm Rejection
                    </button>
                    <button
                      onClick={() => { setRejectingDocId(null); setRejectionReason(''); }}
                      className="btn-secondary"
                      style={{ fontSize: '11px', padding: '6px 14px' }}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
