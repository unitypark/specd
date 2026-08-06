'use client';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          background: '#070e0a',
          color: '#f2f5f1',
          fontFamily: 'system-ui, sans-serif',
          minHeight: '100vh',
          display: 'grid',
          placeItems: 'center',
          margin: 0,
          padding: '2rem',
        }}
      >
        <div style={{ textAlign: 'center', maxWidth: '32rem' }}>
          <h1 style={{ fontSize: '1.4rem', marginBottom: '.6rem' }}>Something broke.</h1>
          <p style={{ color: '#9fb3a6', fontSize: '.86rem', lineHeight: 1.7 }}>
            {error.message || 'An unexpected error occurred.'}
          </p>
          <button
            type="button"
            onClick={reset}
            style={{
              marginTop: '1.4rem',
              background: '#2be26a',
              color: '#06130a',
              border: 'none',
              borderRadius: 6,
              padding: '.6rem 1.1rem',
              font: '650 .8rem/1 system-ui, sans-serif',
              cursor: 'pointer',
            }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
