import Link from 'next/link';

export default function NotFound() {
  return (
    <main
      style={{
        minHeight: '100vh',
        display: 'grid',
        placeItems: 'center',
        padding: '2rem',
        textAlign: 'center',
      }}
    >
      <div>
        <p style={{ font: '700 .6rem/1 var(--mono)', letterSpacing: '.24em', color: 'var(--accent)' }}>
          404
        </p>
        <h1 style={{ font: '600 1.6rem/1.2 var(--serif)', margin: '.6rem 0 .5rem' }}>
          Nothing specified here.
        </h1>
        <p style={{ color: 'var(--ink-3)', fontSize: '.85rem', margin: '0 0 1.4rem' }}>
          That page does not exist.
        </p>
        <Link href="/projects" className="btn primary">
          Back to projects
        </Link>
      </div>
    </main>
  );
}
