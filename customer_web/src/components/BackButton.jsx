import { useNavigate } from 'react-router-dom';

/**
 * BackButton — Internal Customer Navigation Back Button
 *
 * Behavior:
 * - If browser history has a previous page within the current session, navigate back one page (navigate(-1)).
 * - Else, fallback to the Customer Web home page ('/') or specified fallback route.
 * - Accessible, mobile-friendly touch target with chevron icon.
 */
export function BackButton({ label = 'Back', fallback = '/', style, className }) {
  const navigate = useNavigate();

  const handleBack = () => {
    // Check if session has previous history entries
    const hasHistory =
      (typeof window !== 'undefined' &&
        window.history?.state &&
        typeof window.history.state.idx === 'number' &&
        window.history.state.idx > 0) ||
      (typeof window !== 'undefined' && window.history && window.history.length > 1);

    if (hasHistory) {
      navigate(-1);
    } else {
      navigate(fallback);
    }
  };

  return (
    <button
      type="button"
      onClick={handleBack}
      className={className || 'btn-back'}
      data-testid="back-button"
      aria-label={label}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '0.4rem',
        color: 'var(--text-secondary)',
        fontSize: '0.85rem',
        fontWeight: '600',
        background: 'transparent',
        border: 'none',
        padding: '0.35rem 0',
        cursor: 'pointer',
        marginBottom: '0.75rem',
        ...style,
      }}
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <polyline points="15 18 9 12 15 6" />
      </svg>
      <span>{label}</span>
    </button>
  );
}
