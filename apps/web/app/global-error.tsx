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
          background: '#f4f4f4',
          color: '#0f0f0f',
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
          <p style={{ color: '#525252', fontSize: '.86rem', lineHeight: 1.7 }}>
            {error.message || 'An unexpected error occurred.'}
          </p>
          <button
            type="button"
            onClick={reset}
            style={{
              marginTop: '1.4rem',
              // Hardcoded, not var(--emphasis): this page renders its own
              // <html>/<body> as Next.js's root error boundary, bypassing
              // the normal layout tree that loads globals.css, so no custom
              // properties are guaranteed to exist here. Same gradient
              // literal as --emphasis, copied by value.
              background: 'linear-gradient(160deg, #2e2e2e 0%, #000 100%)',
              color: '#fff',
              border: 'none',
              borderRadius: 6,
              padding: '.6rem 1.1rem',
              font: '650 .8rem/1 system-ui, sans-serif',
              cursor: 'pointer',
              boxShadow: '0 1px 2px rgba(0,0,0,.15), 0 8px 20px -6px rgba(0,0,0,.35)',
            }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
