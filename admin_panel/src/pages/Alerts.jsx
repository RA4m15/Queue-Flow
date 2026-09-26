import React, { useState } from 'react';
import { useSocket } from '../context/SocketContext';
import { useAnalytics } from '../hooks/useAnalytics';
import { notificationAPI } from '../services/api';
import LoadingSpinner from '../components/common/LoadingSpinner';
import ErrorMessage from '../components/common/ErrorMessage';
import EmptyState from '../components/common/EmptyState';
import { AlertTriangle, Info, CheckCircle2, Send, Check, Radio } from 'lucide-react';

export default function Alerts() {
  const { activeCenterId } = useSocket();
  const { analytics, loading, error, refreshAnalytics } = useAnalytics(activeCenterId);
  const recommendations = analytics?.recommendations || [];

  const [broadcastTitle, setBroadcastTitle] = useState('');
  const [broadcastBody, setBroadcastBody] = useState('');
  const [sending, setSending] = useState(false);
  const [sendSuccess, setSendSuccess] = useState(false);

  const handleSendBroadcast = async (e) => {
    e.preventDefault();
    if (!broadcastTitle || !broadcastBody) return;

    setSending(true);
    setSendSuccess(false);
    try {
      await notificationAPI.sendBroadcast(activeCenterId, broadcastTitle, broadcastBody);
      setSendSuccess(true);
      setBroadcastTitle('');
      setBroadcastBody('');
      setTimeout(() => setSendSuccess(false), 4000);
    } catch (err) {
      alert(err.message || 'Failed to send broadcast');
    } finally {
      setSending(false);
    }
  };

  return (
    <div style={{ padding: '24px 28px', maxWidth: '1000px', margin: '0 auto' }}>
      {/* Header */}
      <div style={{ marginBottom: '24px' }}>
        <h1 style={{ fontSize: '22px', fontWeight: 800, color: '#F8FAFC', letterSpacing: '-0.02em' }}>
          Operational Alerts & Dispatch
        </h1>
        <p style={{ fontSize: '13px', color: '#94A3B8', marginTop: '3px' }}>
          Real-time algorithmic recommendations based on active queue loads and IoT crowd telemetry
        </p>
      </div>

      {error && <ErrorMessage message={error} onRetry={refreshAnalytics} />}

      {loading ? (
        <LoadingSpinner message="Evaluating operational parameters..." />
      ) : (
        <>
          {/* Action item header pill */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '12px',
              padding: '14px 20px',
              borderRadius: '16px',
              marginBottom: '28px',
              background: recommendations.length > 0 ? 'rgba(245, 158, 11, 0.1)' : 'rgba(0, 229, 168, 0.1)',
              border: recommendations.length > 0 ? '1px solid rgba(245, 158, 11, 0.3)' : '1px solid rgba(0, 229, 168, 0.3)',
            }}
          >
            {recommendations.length > 0 ? (
              <AlertTriangle size={20} color="#F59E0B" />
            ) : (
              <CheckCircle2 size={20} color="#00E5A8" />
            )}
            <p
              style={{
                fontSize: '13px',
                fontWeight: 700,
                color: recommendations.length > 0 ? '#FBBF24' : '#00E5A8',
              }}
            >
              {recommendations.length > 0
                ? `${recommendations.length} operational recommendation${recommendations.length > 1 ? 's' : ''} require attention`
                : 'All queues and counter operations are currently running within optimal parameters'}
            </p>
          </div>

          {/* Recommendations List */}
          <div style={{ marginBottom: '36px' }}>
            <p className="mono" style={{ fontSize: '10px', letterSpacing: '0.1em', color: '#64748B', marginBottom: '12px', textTransform: 'uppercase' }}>
              DATA-DRIVEN RECOMMENDATIONS
            </p>

            {recommendations.length === 0 ? (
              <EmptyState
                title="No active alerts"
                description="When queue loads spike or counter capacities reach threshold, operational suggestions will appear here."
              />
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                {recommendations.map((rec, i) => {
                  const isWarn = rec.type === 'WARN';
                  const isSuggest = rec.type === 'SUGGEST';
                  const borderColor = isWarn ? 'rgba(245,158,11,0.35)' : isSuggest ? 'rgba(0,229,168,0.35)' : 'rgba(0,210,255,0.35)';
                  const tagBg = isWarn ? 'rgba(245,158,11,0.12)' : isSuggest ? 'rgba(0,229,168,0.12)' : 'rgba(0,210,255,0.12)';
                  const tagColor = isWarn ? '#FBBF24' : isSuggest ? '#00E5A8' : '#00D2FF';

                  return (
                    <div
                      key={i}
                      className="q-card"
                      style={{
                        padding: '20px 22px',
                        border: `1px solid ${borderColor}`,
                        background: 'rgba(13, 20, 34, 0.75)',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' }}>
                        <span
                          className="mono"
                          style={{
                            fontSize: '9px',
                            fontWeight: 700,
                            padding: '3px 8px',
                            borderRadius: '6px',
                            background: tagBg,
                            color: tagColor,
                            border: `1px solid ${borderColor}`,
                          }}
                        >
                          {rec.type || 'INFO'}
                        </span>
                        {isWarn ? <AlertTriangle size={16} color={tagColor} /> : <Info size={16} color={tagColor} />}
                      </div>

                      <h3 style={{ fontSize: '15px', fontWeight: 700, color: '#F8FAFC', marginBottom: '6px' }}>
                        {rec.title}
                      </h3>

                      <p style={{ fontSize: '13px', color: '#94A3B8', lineHeight: 1.5, marginBottom: '14px' }}>
                        {rec.desc}
                      </p>

                      {rec.action && (
                        <div style={{ display: 'inline-flex' }}>
                          <span
                            className="mono"
                            style={{
                              fontSize: '11px',
                              fontWeight: 600,
                              padding: '6px 12px',
                              borderRadius: '8px',
                              background: tagBg,
                              color: tagColor,
                              border: `1px solid ${borderColor}`,
                            }}
                          >
                            Suggested: {rec.action}
                          </span>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Broadcast Notification Form */}
          <div>
            <p className="mono" style={{ fontSize: '10px', letterSpacing: '0.1em', color: '#64748B', marginBottom: '12px', textTransform: 'uppercase' }}>
              BROADCAST ANNOUNCEMENT DISPATCH
            </p>

            <div className="q-card" style={{ padding: '26px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
                <Radio size={16} color="#00E5A8" />
                <h3 style={{ fontSize: '15px', fontWeight: 700, color: '#F8FAFC' }}>
                  Facility-Wide Broadcast
                </h3>
              </div>
              <p style={{ fontSize: '13px', color: '#94A3B8', marginBottom: '18px' }}>
                Transmit an immediate real-time announcement to all queued visitors at this facility via Socket.IO.
              </p>

              {sendSuccess && (
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '10px',
                    padding: '12px 16px',
                    borderRadius: '12px',
                    background: 'rgba(0,229,168,0.12)',
                    border: '1px solid rgba(0,229,168,0.3)',
                    color: '#00E5A8',
                    fontSize: '13px',
                    fontWeight: 600,
                    marginBottom: '18px',
                  }}
                >
                  <Check size={16} />
                  <span>Announcement successfully broadcast to all active queued visitors!</span>
                </div>
              )}

              <form onSubmit={handleSendBroadcast}>
                <div style={{ marginBottom: '16px' }}>
                  <label
                    style={{
                      display: 'block',
                      fontSize: '12px',
                      fontWeight: 600,
                      color: '#94A3B8',
                      marginBottom: '6px',
                      textTransform: 'uppercase',
                      letterSpacing: '0.04em',
                    }}
                  >
                    Broadcast Headline
                  </label>
                  <input
                    type="text"
                    required
                    value={broadcastTitle}
                    onChange={(e) => setBroadcastTitle(e.target.value)}
                    placeholder="Announcement Title"
                    style={{
                      width: '100%',
                      padding: '12px 14px',
                      borderRadius: '12px',
                      fontSize: '14px',
                    }}
                  />
                </div>

                <div style={{ marginBottom: '20px' }}>
                  <label
                    style={{
                      display: 'block',
                      fontSize: '12px',
                      fontWeight: 600,
                      color: '#94A3B8',
                      marginBottom: '6px',
                      textTransform: 'uppercase',
                      letterSpacing: '0.04em',
                    }}
                  >
                    Announcement Message
                  </label>
                  <textarea
                    rows={3}
                    required
                    value={broadcastBody}
                    onChange={(e) => setBroadcastBody(e.target.value)}
                    placeholder="Type your message here for all queued visitors..."
                    style={{
                      width: '100%',
                      padding: '12px 14px',
                      borderRadius: '12px',
                      fontSize: '14px',
                      resize: 'none',
                    }}
                  />
                </div>

                <button
                  type="submit"
                  disabled={sending || !broadcastTitle || !broadcastBody}
                  className="btn-primary"
                  style={{ width: '100%', padding: '13px', fontSize: '13px', gap: '8px' }}
                >
                  <Send size={15} />
                  <span>{sending ? 'Broadcasting to Queue...' : 'Transmit Broadcast to Queued Visitors'}</span>
                </button>
              </form>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
