import type { Metadata } from 'next';
import { Josefin_Sans, JetBrains_Mono } from 'next/font/google';
import './globals.css';

/*
 * Type — Josefin Sans throughout, JetBrains Mono for data.
 *
 * Josefin is a geometric Art Deco face: circular bowls, high-waisted joins,
 * and a deliberately small x-height. That last property is the whole reason it
 * looks the way it does, and also the thing that has to be compensated for —
 * at a given font-size Josefin renders visually smaller than a workhorse sans
 * like Inter, so body copy is set a step larger than it otherwise would be
 * (see DESIGN.md).
 *
 * Light weights carry the display sizes; body copy uses 400 upward, because
 * 300 at 1rem on a dark background is thin enough to shimmer.
 *
 * Self-hosted by next/font at build time — no runtime request, no layout shift.
 */
const display = Josefin_Sans({
  subsets: ['latin'],
  weight: ['300', '400', '500', '600', '700'],
  style: ['normal', 'italic'],
  variable: '--font-display',
  display: 'swap',
});

const body = Josefin_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  style: ['normal', 'italic'],
  variable: '--font-body',
  display: 'swap',
});

const mono = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '700'],
  variable: '--font-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'specd — software, built to spec',
  description:
    'One setup builds your knowledge base, briefs an agent with your full context, and gates every change behind a human-approved spec.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable} ${mono.variable}`}>
      <body>
        {/*
         * The liquid-glass refraction filter, defined once for the whole
         * document — every `.glass` surface references it by id via
         * `--glass-refract` in globals.css, rather than each one carrying
         * its own copy. `feDisplacementMap` is the actual mechanism: it
         * reads a second image (here, blurred procedural turbulence) and
         * uses its red/green channel values to shift each pixel of the
         * real content horizontally/vertically — the content's own pixels
         * move, nothing is copied or sampled from elsewhere, which is what
         * makes it read as bent glass rather than a blurred photo of what's
         * underneath. `feTurbulence` generates the displacement pattern
         * procedurally in the browser, so this needs no build step and no
         * per-element JS to size a map — the tradeoff for that simplicity
         * is that it can't shape the distortion to a specific lens
         * geometry the way a purpose-generated map could.
         *
         * Confirmed working in this session's own testing (headless
         * Chrome) only — Chromium is the only engine available to verify
         * against here. Not independently confirmed in Safari/Firefox.
         * `.glass` does not depend on this rendering for its base
         * look — background/border/box-shadow/backdrop-blur all come from
         * plain CSS custom properties, so a browser that fails to apply
         * this filter (or ignores an unrecognized `url()` in a
         * `backdrop-filter` list, which is the spec-compliant behaviour
         * for an unsupported filter function) still shows a complete,
         * intentional glass surface — just without the pixel-bending on
         * top.
         */}
        <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true">
          <filter id="liquid-glass" x="-20%" y="-20%" width="140%" height="140%">
            <feTurbulence
              type="fractalNoise"
              baseFrequency="0.010 0.014"
              numOctaves="2"
              seed="7"
              result="noise"
            />
            <feGaussianBlur in="noise" stdDeviation="3" result="softNoise" />
            <feDisplacementMap
              in="SourceGraphic"
              in2="softNoise"
              scale="16"
              xChannelSelector="R"
              yChannelSelector="G"
            />
          </filter>
        </svg>
        {children}
      </body>
    </html>
  );
}
