import { useState, useEffect, useCallback } from 'react';
import { swapAPI } from '../services/api';

/**
 * Tier 4 Feature 3: P2P Slot Swapping UI Component
 *
 * Displays only when the customer has a WAITING token.
 * All data comes from real APIs and Socket.IO — no fabricated swap offers.
 * Privacy: only anonymous position/tokenCode is shown; no PII of other customers.
 */
export function SwapPanel({ token, socket, onSwapComplete, isOnline = true }) {
  const [view, setView] = useState('idle'); // idle | offers | create | status
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [eligibleData, setEligibleData] = useState(null);
  const [myOffersData, setMyOffersData] = useState(null);
  const [pendingOffer, setPendingOffer] = useState(null);
  const [selectedPartner, setSelectedPartner] = useState(null);
  const [reason, setReason] = useState('');
  const [actionLoading, setActionLoading] = useState(null); // offerId being acted on

  // Only show for WAITING tokens
  const isSwapEligible = token?.status === 'WAITING';

  const loadOffers = useCallback(async () => {
    if (!token?._id || !isSwapEligible) return;
    try {
      setLoading(true);
      setError(null);
      const res = await swapAPI.getMyOffers(token._id);
      setMyOffersData(res.data);

      // Find our own PENDING offer
      const mine = res.data?.myOffers?.find((o) => o.status === 'PENDING');
      setPendingOffer(mine || null);
    } catch (err) {
      setError(err.message || 'Failed to load swap offers');
    } finally {
      setLoading(false);
    }
  }, [token?._id, isSwapEligible]);

  const loadEligible = useCallback(async () => {
    if (!token?._id || !isSwapEligible) return;
    try {
      setLoading(true);
      setError(null);
      const res = await swapAPI.getEligible(token._id);
      setEligibleData(res.data);
    } catch (err) {
      setError(err.message || 'Failed to load eligible partners');
    } finally {
      setLoading(false);
    }
  }, [token?._id, isSwapEligible]);

  // Load offers on mount and when view changes to 'offers'
  useEffect(() => {
    if (view === 'offers' || view === 'status') {
      loadOffers();
    }
    if (view === 'create') {
      loadEligible();
    }
  }, [view, loadOffers, loadEligible]);

  // Real-time swap updates via Socket.IO
  useEffect(() => {
    if (!socket) return;

    const handleSwapCompleted = (data) => {
      if (onSwapComplete) onSwapComplete(data);
      loadOffers();
    };

    const handleOfferExpired = () => {
      setPendingOffer(null);
      loadOffers();
    };

    const handleOfferReceived = () => {
      if (view === 'offers') loadOffers();
    };

    socket.on('swap.completed', handleSwapCompleted);
    socket.on('swap.offer.expired', handleOfferExpired);
    socket.on('swap.offer.received', handleOfferReceived);
    socket.on('swap.offer.declined', handleOfferExpired);

    return () => {
      socket.off('swap.completed', handleSwapCompleted);
      socket.off('swap.offer.expired', handleOfferExpired);
      socket.off('swap.offer.received', handleOfferReceived);
      socket.off('swap.offer.declined', handleOfferExpired);
    };
  }, [socket, view, loadOffers, onSwapComplete]);

  const handleCreateOffer = async () => {
    if (!token?._id) return;
    if (!isOnline) {
      setError("You're offline. This action requires a live connection.");
      return;
    }
    try {
      setActionLoading('create');
      setError(null);
      const targetTokenId = selectedPartner?.tokenId || null;
      const res = await swapAPI.createOffer(token._id, targetTokenId, reason || null);
      setPendingOffer(res.data?.offer);
      setView('status');
      setReason('');
      setSelectedPartner(null);
    } catch (err) {
      setError(err.message || 'Failed to create swap offer');
    } finally {
      setActionLoading(null);
    }
  };

  const handleAcceptOffer = async (offerId) => {
    if (!token?._id) return;
    if (!isOnline) {
      setError("You're offline. This action requires a live connection.");
      return;
    }
    try {
      setActionLoading(offerId);
      setError(null);
      await swapAPI.acceptOffer(offerId, token._id);
      setView('idle');
      if (onSwapComplete) onSwapComplete({ offerId });
    } catch (err) {
      setError(err.message || 'Failed to accept offer');
      loadOffers();
    } finally {
      setActionLoading(null);
    }
  };

  const handleDeclineOffer = async (offerId) => {
    if (!isOnline) {
      setError("You're offline. This action requires a live connection.");
      return;
    }
    try {
      setActionLoading(offerId);
      setError(null);
      await swapAPI.declineOffer(offerId);
      loadOffers();
    } catch (err) {
      setError(err.message || 'Failed to decline offer');
    } finally {
      setActionLoading(null);
    }
  };

  const handleCancelOffer = async (offerId) => {
    if (!isOnline) {
      setError("You're offline. This action requires a live connection.");
      return;
    }
    try {
      setActionLoading(offerId);
      setError(null);
      await swapAPI.cancelOffer(offerId);
      setPendingOffer(null);
      setView('idle');
      loadOffers();
    } catch (err) {
      setError(err.message || 'Failed to cancel offer');
    } finally {
      setActionLoading(null);
    }
  };

  if (!isSwapEligible) return null;

  // ─── Styles ────────────────────────────────────────────────────────────────

  const cardStyle = {
    background: 'var(--bg-card)',
    border: '1px solid rgba(99,102,241,0.3)',
    borderRadius: '16px',
    padding: '1.25rem',
    marginTop: '1rem',
  };

  const sectionTitle = {
    fontSize: '0.85rem',
    fontWeight: '700',
    color: 'var(--text-muted)',
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    marginBottom: '0.75rem',
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
  };

  const pill = (color) => ({
    display: 'inline-block',
    fontSize: '0.7rem',
    fontWeight: '700',
    padding: '0.2rem 0.5rem',
    borderRadius: '999px',
    background: color,
    color: '#fff',
    marginLeft: '0.5rem',
  });

  // ─── IDLE view: swap button ────────────────────────────────────────────────
  if (view === 'idle') {
    return (
      <div style={cardStyle}>
        <div style={sectionTitle}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
            <path d="M7 16V4m0 0L3 8m4-4l4 4" /><path d="M17 8v12m0 0l4-4m-4 4l-4-4" />
          </svg>
          Position Swap
        </div>
        <p style={{ fontSize: '0.82rem', color: 'var(--text-secondary)', marginBottom: '0.85rem' }}>
          Voluntarily swap your queue position with another waiting customer.
        </p>
        <div style={{ display: 'flex', gap: '0.6rem', flexWrap: 'wrap' }}>
          <button
            id="swap-panel-view-offers-btn"
            type="button"
            onClick={() => setView('offers')}
            style={{
              flex: 1,
              padding: '0.55rem 1rem',
              background: 'rgba(99,102,241,0.15)',
              border: '1px solid rgba(99,102,241,0.4)',
              borderRadius: '10px',
              color: 'var(--color-cyan)',
              fontSize: '0.82rem',
              fontWeight: '600',
              cursor: 'pointer',
            }}
          >
            View Offers
          </button>
          <button
            id="swap-panel-create-offer-btn"
            type="button"
            onClick={() => setView('create')}
            style={{
              flex: 1,
              padding: '0.55rem 1rem',
              background: 'rgba(16,185,129,0.15)',
              border: '1px solid rgba(16,185,129,0.35)',
              borderRadius: '10px',
              color: 'var(--color-success)',
              fontSize: '0.82rem',
              fontWeight: '600',
              cursor: 'pointer',
            }}
          >
            Offer Swap
          </button>
        </div>
      </div>
    );
  }

  // ─── CREATE OFFER view ─────────────────────────────────────────────────────
  if (view === 'create') {
    return (
      <div style={cardStyle}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.85rem' }}>
          <div style={sectionTitle}>Offer Your Position</div>
          <button type="button" onClick={() => { setView('idle'); setError(null); }}
            style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '1.1rem' }}>✕</button>
        </div>

        {error && (
          <div style={{ padding: '0.6rem', background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: '8px', color: 'var(--color-danger)', fontSize: '0.8rem', marginBottom: '0.75rem' }}>
            {error}
          </div>
        )}

        {loading ? (
          <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '1.5rem 0', fontSize: '0.85rem' }}>
            Loading eligible partners…
          </div>
        ) : (
          <>
            {/* Your current position */}
            <div style={{ background: 'rgba(99,102,241,0.08)', borderRadius: '10px', padding: '0.75rem', marginBottom: '0.85rem', fontSize: '0.82rem', color: 'var(--text-secondary)' }}>
              <span style={{ color: 'var(--text-muted)' }}>Your position:</span>{' '}
              <strong style={{ color: 'var(--color-cyan)' }}>#{token.currentPosition}</strong>{' '}
              <span style={{ color: 'var(--text-muted)' }}>· Token</span>{' '}
              <strong style={{ color: 'var(--text-main)' }}>{token.tokenCode}</strong>
            </div>

            {/* Partner list */}
            {!eligibleData?.partners?.length ? (
              <div style={{ textAlign: 'center', color: 'var(--text-secondary)', fontSize: '0.82rem', padding: '1rem 0' }}>
                No other customers are currently waiting in this queue.
              </div>
            ) : (
              <>
                <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginBottom: '0.5rem' }}>
                  Select a target (optional — leave blank for open offer):
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', maxHeight: '180px', overflowY: 'auto', marginBottom: '0.85rem' }}>
                  {eligibleData.partners.map((p) => (
                    <button
                      key={p.tokenId}
                      type="button"
                      id={`swap-partner-${p.tokenId}`}
                      onClick={() => setSelectedPartner(selectedPartner?.tokenId === p.tokenId ? null : p)}
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        padding: '0.5rem 0.75rem',
                        background: selectedPartner?.tokenId === p.tokenId ? 'rgba(99,102,241,0.2)' : 'var(--bg-card-alt)',
                        border: `1px solid ${selectedPartner?.tokenId === p.tokenId ? 'rgba(99,102,241,0.5)' : 'var(--border-subtle)'}`,
                        borderRadius: '8px',
                        cursor: 'pointer',
                        textAlign: 'left',
                      }}
                    >
                      <span style={{ fontSize: '0.8rem', color: 'var(--text-main)', fontWeight: '600' }}>
                        Position #{p.currentPosition}
                      </span>
                      <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                        Token {p.tokenCode}
                      </span>
                    </button>
                  ))}
                </div>
              </>
            )}

            {/* Optional reason */}
            <textarea
              id="swap-reason-input"
              value={reason}
              onChange={(e) => setReason(e.target.value.slice(0, 200))}
              placeholder="Reason (optional, max 200 chars)"
              rows={2}
              style={{
                width: '100%',
                background: 'var(--bg-card-alt)',
                border: '1px solid var(--border-subtle)',
                borderRadius: '8px',
                color: 'var(--text-main)',
                fontSize: '0.8rem',
                padding: '0.5rem 0.75rem',
                resize: 'vertical',
                marginBottom: '0.75rem',
                boxSizing: 'border-box',
              }}
            />

            <div style={{ display: 'flex', gap: '0.6rem' }}>
              <button type="button" onClick={() => setView('idle')}
                style={{ flex: 1, padding: '0.55rem', background: 'var(--bg-card-alt)', border: '1px solid var(--border-subtle)', borderRadius: '10px', color: 'var(--text-secondary)', fontSize: '0.82rem', cursor: 'pointer' }}>
                Cancel
              </button>
              <button
                id="swap-submit-offer-btn"
                type="button"
                onClick={handleCreateOffer}
                disabled={!!actionLoading}
                style={{
                  flex: 2,
                  padding: '0.55rem',
                  background: actionLoading ? 'rgba(16,185,129,0.08)' : 'rgba(16,185,129,0.2)',
                  border: '1px solid rgba(16,185,129,0.4)',
                  borderRadius: '10px',
                  color: 'var(--color-success)',
                  fontSize: '0.82rem',
                  fontWeight: '700',
                  cursor: actionLoading ? 'not-allowed' : 'pointer',
                }}
              >
                {actionLoading === 'create' ? 'Submitting…' : (selectedPartner ? `Offer to Position #${selectedPartner.currentPosition}` : 'Post Open Offer')}
              </button>
            </div>
          </>
        )}
      </div>
    );
  }

  // ─── OFFERS VIEW: list incoming + my offers ────────────────────────────────
  if (view === 'offers' || view === 'status') {
    const incomingOffers = myOffersData?.eligibleOffers || [];
    const myOffers = myOffersData?.myOffers || [];
    const myPending = myOffers.find((o) => o.status === 'PENDING');

    return (
      <div style={cardStyle}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.85rem' }}>
          <div style={sectionTitle}>Swap Offers</div>
          <button type="button" onClick={() => { setView('idle'); setError(null); }}
            style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '1.1rem' }}>✕</button>
        </div>

        {error && (
          <div style={{ padding: '0.6rem', background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: '8px', color: 'var(--color-danger)', fontSize: '0.8rem', marginBottom: '0.75rem' }}>
            {error}
          </div>
        )}

        {loading ? (
          <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '1.5rem 0', fontSize: '0.85rem' }}>Loading…</div>
        ) : (
          <>
            {/* My pending offer status */}
            {myPending && (
              <div style={{ background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.25)', borderRadius: '10px', padding: '0.75rem', marginBottom: '0.85rem' }}>
                <div style={{ fontSize: '0.78rem', color: 'var(--color-warning)', fontWeight: '700', marginBottom: '0.35rem' }}>
                  Your Pending Offer
                  <span style={pill('rgba(245,158,11,0.5)')}>PENDING</span>
                </div>
                <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                  Expires: {new Date(myPending.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </div>
                <button
                  id={`swap-cancel-offer-${myPending._id}`}
                  type="button"
                  onClick={() => handleCancelOffer(myPending._id)}
                  disabled={actionLoading === myPending._id}
                  style={{ marginTop: '0.5rem', padding: '0.4rem 0.75rem', background: 'rgba(239,68,68,0.15)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: '8px', color: 'var(--color-danger)', fontSize: '0.78rem', cursor: 'pointer' }}>
                  {actionLoading === myPending._id ? 'Cancelling…' : 'Cancel Offer'}
                </button>
              </div>
            )}

            {/* Incoming open offers */}
            <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginBottom: '0.4rem', fontWeight: '600' }}>
              Available swap offers ({incomingOffers.length})
            </div>

            {incomingOffers.length === 0 ? (
              <div style={{ textAlign: 'center', color: 'var(--text-secondary)', fontSize: '0.82rem', padding: '1rem 0' }}>
                No open swap offers in your queue right now.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', maxHeight: '220px', overflowY: 'auto' }}>
                {incomingOffers.map((offer) => (
                  <div key={offer.offerId} style={{
                    padding: '0.65rem 0.75rem',
                    background: 'rgba(99,102,241,0.07)',
                    border: '1px solid rgba(99,102,241,0.2)',
                    borderRadius: '10px',
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.35rem' }}>
                      <span style={{ fontSize: '0.82rem', color: 'var(--text-main)', fontWeight: '700' }}>
                        Position #{offer.offeringPosition}
                      </span>
                      <span style={{ fontSize: '0.74rem', color: 'var(--text-muted)' }}>
                        Token {offer.offeringTokenCode}
                      </span>
                    </div>
                    <div style={{ fontSize: '0.74rem', color: 'var(--text-muted)', marginBottom: '0.4rem' }}>
                      Expires {new Date(offer.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </div>
                    <button
                      id={`swap-accept-offer-${offer.offerId}`}
                      type="button"
                      onClick={() => handleAcceptOffer(offer.offerId)}
                      disabled={!!actionLoading}
                      style={{
                        padding: '0.35rem 0.75rem',
                        background: 'rgba(16,185,129,0.18)',
                        border: '1px solid rgba(16,185,129,0.35)',
                        borderRadius: '7px',
                        color: 'var(--color-success)',
                        fontSize: '0.78rem',
                        fontWeight: '600',
                        cursor: actionLoading ? 'not-allowed' : 'pointer',
                      }}>
                      {actionLoading === offer.offerId ? 'Processing…' : 'Accept Swap'}
                    </button>
                    <button
                      id={`swap-decline-offer-${offer.offerId}`}
                      type="button"
                      onClick={() => handleDeclineOffer(offer.offerId)}
                      disabled={!!actionLoading}
                      style={{
                        marginLeft: '0.4rem',
                        padding: '0.35rem 0.75rem',
                        background: 'rgba(239,68,68,0.1)',
                        border: '1px solid rgba(239,68,68,0.25)',
                        borderRadius: '7px',
                        color: 'var(--color-danger)',
                        fontSize: '0.78rem',
                        cursor: actionLoading ? 'not-allowed' : 'pointer',
                      }}>
                      Decline
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Actions */}
            <div style={{ display: 'flex', gap: '0.6rem', marginTop: '0.75rem' }}>
              <button type="button" onClick={loadOffers}
                disabled={loading}
                style={{ flex: 1, padding: '0.45rem', background: 'var(--bg-card-alt)', border: '1px solid var(--border-subtle)', borderRadius: '9px', color: 'var(--text-muted)', fontSize: '0.78rem', cursor: 'pointer' }}>
                Refresh
              </button>
              {!myPending && (
                <button id="swap-go-create-btn" type="button" onClick={() => setView('create')}
                  style={{ flex: 2, padding: '0.45rem', background: 'rgba(16,185,129,0.12)', border: '1px solid rgba(16,185,129,0.3)', borderRadius: '9px', color: 'var(--color-success)', fontSize: '0.78rem', fontWeight: '600', cursor: 'pointer' }}>
                  + Offer Swap
                </button>
              )}
            </div>
          </>
        )}
      </div>
    );
  }

  return null;
}
