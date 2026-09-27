import React, { useState, useEffect, useCallback } from 'react';
import { documentAPI } from '../services/api';

/**
 * QueueFlow — Tier 4 / Feature 4: Document Checklist Component
 *
 * Real document gate checklist for a selected service.
 * Displays authoritative server-calculated requirements, customer document
 * verification statuses, and allows uploading real files (PDF/Images).
 *
 * Never renders fake progress or mock requirements.
 */
export default function DocumentChecklist({ serviceId, onReadinessChange, isAuthenticated }) {
  const [loading, setLoading] = useState(true);
  const [readiness, setReadiness] = useState(null);
  const [requirements, setRequirements] = useState([]);
  const [uploadingType, setUploadingType] = useState(null);
  const [uploadError, setUploadError] = useState(null);

  const fetchStatus = useCallback(async () => {
    if (!serviceId) return;
    try {
      setLoading(true);
      setUploadError(null);

      if (isAuthenticated) {
        // Authenticated customer: fetch authoritative readiness and checklist
        const res = await documentAPI.getReadiness(serviceId);
        const data = res.data || res;
        setReadiness(data);
        setRequirements(data.checklist || []);
        if (onReadinessChange) {
          onReadinessChange(data);
        }
      } else {
        // Guest user: fetch requirements definition
        const res = await documentAPI.getRequirements(serviceId);
        const reqs = res.data?.requirements || [];
        setRequirements(reqs);
        setReadiness(null);
        if (onReadinessChange) {
          onReadinessChange({ isReady: reqs.length === 0, status: reqs.length === 0 ? 'REQUIREMENTS_NOT_CONFIGURED' : 'AUTH_REQUIRED' });
        }
      }
    } catch (err) {
      console.error('Failed to load document requirements:', err);
    } finally {
      setLoading(false);
    }
  }, [serviceId, isAuthenticated, onReadinessChange]);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  const handleFileUpload = async (documentType, file) => {
    if (!file) return;

    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      setUploadError("You're offline. Document upload requires a live connection.");
      return;
    }

    // Check size limit: 10MB
    if (file.size > 10 * 1024 * 1024) {
      setUploadError('File size exceeds the 10MB limit.');
      return;
    }


    const allowedMimes = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];
    if (!allowedMimes.includes(file.type)) {
      setUploadError('Unsupported file type. Please upload a PDF, JPEG, PNG, or WEBP document.');
      return;
    }

    setUploadingType(documentType);
    setUploadError(null);

    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const base64Data = reader.result;
        await documentAPI.upload({
          documentType,
          fileName: file.name,
          mimeType: file.type,
          fileData: base64Data,
          serviceId,
        });
        await fetchStatus();
      } catch (err) {
        setUploadError(err.message || 'Failed to upload document');
      } finally {
        setUploadingType(null);
      }
    };
    reader.onerror = () => {
      setUploadError('Error reading file. Please try again.');
      setUploadingType(null);
    };
    reader.readAsDataURL(file);
  };

  if (loading) {
    return (
      <div className="qf-card" style={{ padding: '1.25rem', marginTop: '1.5rem', textAlign: 'center' }}>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>Loading service documentation requirements...</p>
      </div>
    );
  }

  // Truthful empty state if no requirements exist
  if (!requirements || requirements.length === 0) {
    return (
      <div className="qf-card" style={{ padding: '1.25rem', marginTop: '1.5rem', borderLeft: '4px solid #10B981' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <span style={{ fontSize: '1.25rem' }}>📋</span>
          <div>
            <h4 style={{ margin: 0, fontSize: '0.95rem', fontWeight: 600 }}>Documentation Requirements</h4>
            <p style={{ margin: '0.25rem 0 0', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
              Requirements not configured. No documents required to join this service.
            </p>
          </div>
        </div>
      </div>
    );
  }

  const getStatusBadge = (status) => {
    switch (status) {
      case 'VERIFIED':
        return <span style={{ background: 'rgba(16, 185, 129, 0.15)', color: '#10B981', padding: '0.2rem 0.6rem', borderRadius: '999px', fontSize: '0.75rem', fontWeight: 600 }}>Verified ✓</span>;
      case 'PENDING':
      case 'UPLOADED':
        return <span style={{ background: 'rgba(245, 158, 11, 0.15)', color: '#F59E0B', padding: '0.2rem 0.6rem', borderRadius: '999px', fontSize: '0.75rem', fontWeight: 600 }}>Pending Review</span>;
      case 'REJECTED':
        return <span style={{ background: 'rgba(239, 68, 68, 0.15)', color: '#EF4444', padding: '0.2rem 0.6rem', borderRadius: '999px', fontSize: '0.75rem', fontWeight: 600 }}>Rejected ✕</span>;
      default:
        return <span style={{ background: 'rgba(156, 163, 175, 0.15)', color: '#9CA3AF', padding: '0.2rem 0.6rem', borderRadius: '999px', fontSize: '0.75rem', fontWeight: 600 }}>Not Uploaded</span>;
    }
  };

  return (
    <div className="qf-card" style={{ padding: '1.5rem', marginTop: '1.5rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem', borderBottom: '1px solid var(--border-color, rgba(255,255,255,0.08))', paddingBottom: '0.75rem' }}>
        <div>
          <h3 style={{ margin: 0, fontSize: '1.05rem', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <span>📄</span> Document-Ready Gate
          </h3>
          <p style={{ margin: '0.25rem 0 0', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
            Service verification requirements must be satisfied before joining the queue.
          </p>
        </div>
        {readiness && (
          <div>
            {readiness.isReady ? (
              <span style={{ background: 'rgba(16, 185, 129, 0.2)', color: '#10B981', border: '1px solid #10B981', padding: '0.35rem 0.75rem', borderRadius: '6px', fontSize: '0.8rem', fontWeight: 700 }}>
                READY TO JOIN
              </span>
            ) : (
              <span style={{ background: 'rgba(239, 68, 68, 0.15)', color: '#EF4444', border: '1px solid #EF4444', padding: '0.35rem 0.75rem', borderRadius: '6px', fontSize: '0.8rem', fontWeight: 700 }}>
                DOCUMENTS REQUIRED
              </span>
            )}
          </div>
        )}
      </div>

      {uploadError && (
        <div style={{ background: 'rgba(239, 68, 68, 0.1)', border: '1px solid #EF4444', borderRadius: '8px', padding: '0.75rem 1rem', marginBottom: '1rem', color: '#EF4444', fontSize: '0.85rem' }}>
          {uploadError}
        </div>
      )}

      {/* Checklist items */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.85rem' }}>
        {requirements.map((req) => {
          const docType = req.documentType;
          const userDoc = req.customerDocument || null;
          const status = req.customerStatus || 'NOT_UPLOADED';
          const isReq = req.isRequired !== false;
          const isUploading = uploadingType === docType;

          return (
            <div
              key={req.requirementId || docType}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '0.85rem 1rem',
                borderRadius: '8px',
                background: 'rgba(255, 255, 255, 0.03)',
                border: '1px solid var(--border-color, rgba(255,255,255,0.06))',
                flexWrap: 'wrap',
                gap: '0.5rem',
              }}
            >
              <div style={{ flex: '1 1 200px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <span style={{ fontWeight: 600, fontSize: '0.9rem' }}>{req.name}</span>
                  {isReq ? (
                    <span style={{ fontSize: '0.7rem', color: '#EF4444', fontWeight: 700, textTransform: 'uppercase' }}>Required</span>
                  ) : (
                    <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>Optional</span>
                  )}
                </div>
                {req.description && (
                  <p style={{ margin: '0.2rem 0 0', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                    {req.description}
                  </p>
                )}
                {userDoc?.rejectionReason && (
                  <p style={{ margin: '0.35rem 0 0', fontSize: '0.75rem', color: '#EF4444' }}>
                    Rejection note: {userDoc.rejectionReason}
                  </p>
                )}
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                {getStatusBadge(status)}

                {isAuthenticated && (
                  <div>
                    <label
                      htmlFor={`file-upload-${docType}`}
                      style={{
                        display: 'inline-block',
                        padding: '0.35rem 0.75rem',
                        fontSize: '0.75rem',
                        fontWeight: 600,
                        borderRadius: '6px',
                        cursor: isUploading ? 'not-allowed' : 'pointer',
                        background: status === 'VERIFIED' ? 'rgba(255,255,255,0.08)' : 'var(--primary-color, #3B82F6)',
                        color: '#fff',
                        transition: 'opacity 0.2s',
                        opacity: isUploading ? 0.6 : 1,
                      }}
                    >
                      {isUploading ? 'Uploading...' : status === 'VERIFIED' ? 'Replace' : 'Upload'}
                    </label>
                    <input
                      id={`file-upload-${docType}`}
                      type="file"
                      accept="application/pdf,image/png,image/jpeg,image/webp"
                      style={{ display: 'none' }}
                      disabled={isUploading}
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) {
                          handleFileUpload(docType, file);
                        }
                      }}
                    />
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {readiness && !readiness.isReady && (
        <div style={{ marginTop: '1rem', padding: '0.75rem 1rem', borderRadius: '8px', background: 'rgba(239, 68, 68, 0.08)', border: '1px solid rgba(239, 68, 68, 0.2)' }}>
          <p style={{ margin: 0, fontSize: '0.85rem', color: '#F87171', fontWeight: 500 }}>
            {readiness.message || 'Complete required documentation to proceed.'}
          </p>
        </div>
      )}
    </div>
  );
}
