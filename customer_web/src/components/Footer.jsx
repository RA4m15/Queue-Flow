export function Footer() {
  return (
    <footer
      style={{
        padding: '2rem 1rem',
        borderTop: '1px solid var(--border-subtle)',
        textAlign: 'center',
        color: 'var(--text-muted)',
        fontSize: '0.8rem',
        marginTop: 'auto',
      }}
    >
      <div style={{ maxWidth: '768px', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
        <p>
          <strong style={{ color: 'var(--text-secondary)' }}>QueueFlow</strong> — Zero-Install Customer PWA
        </p>
        <p>
          Authoritative tokens generated server-side. Real-time updates via WebSockets.
        </p>
      </div>
    </footer>
  );
}
