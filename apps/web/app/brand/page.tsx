import type { Metadata } from 'next';
import { Logo, Wordmark } from '@/components/Logo';

export const metadata: Metadata = { title: 'specd — brand mark' };

const SIZES = [16, 24, 32, 48, 96, 160];

export default function Brand() {
  return (
    <main style={{ background: 'var(--field)', minHeight: '100vh', padding: '3rem 2rem 6rem' }}>
      <div style={{ maxWidth: '72rem', margin: '0 auto' }}>
        <span className="tag">BRAND</span>
        <h1 style={{ font: '500 2.4rem/1.15 var(--serif)', color: 'var(--ink)', margin: '.6rem 0 .6rem' }}>
          The mark
        </h1>
        <p style={{ color: 'var(--ink-2)', maxWidth: '60ch', lineHeight: 1.75, marginBottom: '1rem' }}>
          Four identical hooks — the same circular arc, each centered off the mark&apos;s own middle
          and swept 220°, rotated 90° apart. Each hook&apos;s opening sits 40° off its own outward
          direction rather than centered on it, which is what makes the four of them chase each
          other into a woven pinwheel instead of reading as a static four-petal flower.
        </p>
        <p style={{ color: 'var(--ink-2)', maxWidth: '60ch', lineHeight: 1.75, marginBottom: '3rem' }}>
          One path set in <code>currentColor</code> — no embedded fill, no tile. It inherits whatever
          colour it sits in and reads the same in one ink, on paper, or on black. Legible to 16px;
          see <code>knowledge/decisions/0007-rebrand-golden-spiral.md</code> for how that was tested.
        </p>

        <section
          style={{
            border: '1px solid var(--line)',
            borderRadius: 14,
            padding: '1.8rem',
            marginBottom: '1.2rem',
            background: 'var(--panel)',
          }}
        >
          <h2 style={{ font: '600 1.1rem/1 var(--serif)', color: 'var(--ink)', margin: '0 0 .5rem' }}>
            Size
          </h2>
          <p style={{ color: 'var(--ink-2)', fontSize: '.88rem', margin: '0 0 1.5rem', maxWidth: '62ch' }}>
            Every size below is the same path, only scaled — nothing is redrawn or simplified for
            small sizes.
          </p>

          <div style={{ display: 'flex', gap: '2.4rem', alignItems: 'flex-end', flexWrap: 'wrap' }}>
            {SIZES.map((s) => (
              <div key={s} style={{ textAlign: 'center' }}>
                <div style={{ color: 'var(--accent)', display: 'flex', alignItems: 'flex-end', height: 96 }}>
                  <Logo size={s} />
                </div>
                <div style={{ font: '500 .6rem/1 var(--mono)', color: 'var(--ink-3)', marginTop: '.7rem' }}>
                  {s}px
                </div>
              </div>
            ))}

            {/* On paper, and in one ink — a mark that only works in one colour is not a mark. */}
            <div style={{ textAlign: 'center' }}>
              <div style={{ background: 'var(--paper)', color: 'var(--paper-ink)', padding: '1rem', borderRadius: 10, display: 'flex' }}>
                <Logo size={48} />
              </div>
              <div style={{ font: '500 .6rem/1 var(--mono)', color: 'var(--ink-3)', marginTop: '.7rem' }}>
                on paper
              </div>
            </div>
            <div style={{ textAlign: 'center' }}>
              <div style={{ background: '#000', color: '#fff', padding: '1rem', borderRadius: 10, display: 'flex' }}>
                <Logo size={48} />
              </div>
              <div style={{ font: '500 .6rem/1 var(--mono)', color: 'var(--ink-3)', marginTop: '.7rem' }}>
                one ink
              </div>
            </div>
          </div>

          <div style={{ marginTop: '2rem', paddingTop: '1.4rem', borderTop: '1px solid var(--line)' }}>
            <Wordmark />
          </div>
        </section>

        <section
          style={{
            border: '1px solid var(--line)',
            borderRadius: 14,
            padding: '1.8rem',
            background: 'var(--panel)',
          }}
        >
          <h2 style={{ font: '600 1.1rem/1 var(--serif)', color: 'var(--ink)', margin: '0 0 .5rem' }}>
            Glow
          </h2>
          <p style={{ color: 'var(--ink-2)', fontSize: '.88rem', margin: '0 0 2.5rem', maxWidth: '62ch' }}>
            An explicit opt-in (<code>{'<Logo glow />'}</code>), not the default: a bolder white line
            plus a soft white blur bloom behind it, in place of the flat, thinner{' '}
            <code>currentColor</code> line — no colour, brightness and weight carry the whole effect.
            Reserved for nav and hero sizes — the same reason the flat mark drops detail below ~24px,
            blur softens the silhouette at small sizes rather than reading as polish.
          </p>

          {/* The blur bloom isn't clipped by its box (that's what makes it a glow, not a
              vignette) — so unlike the Size row above, each swatch needs padding that scales
              with the mark itself, or a big enough mark bleeds past a flat padding value into
              whatever sits above it. */}
          <div style={{ display: 'flex', gap: '2.4rem', alignItems: 'flex-end', flexWrap: 'wrap' }}>
            {[32, 48, 96, 160].map((s) => {
              const pad = Math.round(s * 0.3);
              return (
                <div key={s} style={{ textAlign: 'center' }}>
                  <div style={{ background: '#000', display: 'flex', alignItems: 'center', justifyContent: 'center', width: s + pad * 2, height: s + pad * 2, borderRadius: 10 }}>
                    <Logo size={s} glow />
                  </div>
                  <div style={{ font: '500 .6rem/1 var(--mono)', color: 'var(--ink-3)', marginTop: '.7rem' }}>
                    {s}px
                  </div>
                </div>
              );
            })}
          </div>

          <div style={{ marginTop: '2rem', paddingTop: '1.4rem', borderTop: '1px solid var(--line)' }}>
            <Wordmark glow />
          </div>
        </section>
      </div>
    </main>
  );
}
