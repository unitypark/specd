import type { Metadata } from 'next';
import { Logo, Wordmark, type LogoVariant } from '@/components/Logo';

export const metadata: Metadata = { title: 'specd — brand marks' };

const VARIANTS: { id: LogoVariant; name: string; note: string }[] = [
  { id: 'face', name: 'The witch — black hat, green face, red lips', note: 'The brand mark. Carries its own green field, because a black hat is invisible on a dark page. Needs ~24px to read; pair it with the plain silhouette for favicons.' },
  { id: 'check', name: 'Hat + approval stroke', note: 'The hat is the brand; the check is the product. Reads as a hat first, a stamp second.' },
  { id: 'seal', name: 'Hat in a seal', note: 'Ring implies a stamp without drawing one. Softest of the four; loses detail first when small.' },
  { id: 'spec', name: 'Hat over a spec', note: 'Hat above document lines. Most literal, least distinctive at a glance.' },
  { id: 'plain', name: 'Hat alone', note: 'Cleanest silhouette, survives any size — but says nothing about approval.' },
];

const SIZES = [16, 24, 32, 48, 96];

export default function Brand() {
  return (
    <main style={{ background: 'var(--field)', minHeight: '100vh', padding: '3rem 2rem 6rem' }}>
      <div style={{ maxWidth: '72rem', margin: '0 auto' }}>
        <span className="tag">BRAND</span>
        <h1 style={{ font: '500 2.4rem/1.15 var(--serif)', color: '#fff', margin: '.6rem 0 .6rem' }}>
          Marks to choose from
        </h1>
        <p style={{ color: 'var(--ink-2)', maxWidth: '60ch', lineHeight: 1.75, marginBottom: '3rem' }}>
          A witch’s hat, drawn from scratch rather than traced — the silhouette is what survives a
          favicon. Each is one path set in <code>currentColor</code>, so it inherits whatever colour
          it sits in and works in one ink.
        </p>

        {VARIANTS.map((v) => (
          <section
            key={v.id}
            style={{
              border: '1px solid var(--line)',
              borderRadius: 14,
              padding: '1.8rem',
              marginBottom: '1.2rem',
              background: 'var(--panel)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'baseline', gap: '1rem', flexWrap: 'wrap' }}>
              <h2 style={{ font: '600 1.1rem/1 var(--serif)', color: '#fff', margin: 0 }}>{v.name}</h2>
              <code style={{ font: '500 .68rem/1 var(--mono)', color: 'var(--ink-3)' }}>
                variant=&quot;{v.id}&quot;
              </code>
            </div>
            <p style={{ color: 'var(--ink-2)', fontSize: '.88rem', margin: '.5rem 0 1.5rem', maxWidth: '62ch' }}>
              {v.note}
            </p>

            <div style={{ display: 'flex', gap: '2.4rem', alignItems: 'flex-end', flexWrap: 'wrap' }}>
              {SIZES.map((s) => (
                <div key={s} style={{ textAlign: 'center' }}>
                  <div style={{ color: 'var(--accent)', display: 'flex', alignItems: 'flex-end', height: 96 }}>
                    <Logo variant={v.id} size={s} />
                  </div>
                  <div style={{ font: '500 .6rem/1 var(--mono)', color: 'var(--ink-3)', marginTop: '.7rem' }}>
                    {s}px
                  </div>
                </div>
              ))}

              {/* On paper, and in one ink — a mark that only works in green is not a mark. */}
              <div style={{ textAlign: 'center' }}>
                <div style={{ background: 'var(--paper)', color: '#17211a', padding: '1rem', borderRadius: 10, display: 'flex' }}>
                  <Logo variant={v.id} size={48} />
                </div>
                <div style={{ font: '500 .6rem/1 var(--mono)', color: 'var(--ink-3)', marginTop: '.7rem' }}>
                  on paper
                </div>
              </div>
              <div style={{ textAlign: 'center' }}>
                <div style={{ background: '#000', color: '#fff', padding: '1rem', borderRadius: 10, display: 'flex' }}>
                  <Logo variant={v.id} size={48} />
                </div>
                <div style={{ font: '500 .6rem/1 var(--mono)', color: 'var(--ink-3)', marginTop: '.7rem' }}>
                  one ink
                </div>
              </div>
            </div>

            <div style={{ marginTop: '2rem', paddingTop: '1.4rem', borderTop: '1px solid var(--line)' }}>
              <Wordmark variant={v.id} />
            </div>
          </section>
        ))}
      </div>
    </main>
  );
}
