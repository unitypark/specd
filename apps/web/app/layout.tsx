import type { Metadata } from 'next';
import localFont from 'next/font/local';
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
 * The files are in this repository, and that is the point. `next/font/google`
 * fetches from fonts.gstatic.com *at build time*, which made every production
 * build depend on a third party being reachable — and it twice was not, failing
 * CI on a change that had nothing to do with the web app. A build that can fail
 * for a reason no commit caused is a build people learn to re-run without
 * reading, which is how a real failure gets waved through.
 *
 * These are the variable fonts, latin subset: one axis per file rather than a
 * static file per weight, so five weights and two styles cost three files and
 * about 100 KB. Both families are OFL-1.1 and the licences ship beside them.
 */
const display = localFont({
  src: [
    { path: './fonts/JosefinSans-Variable.woff2', weight: '100 700', style: 'normal' },
    { path: './fonts/JosefinSans-Italic-Variable.woff2', weight: '100 700', style: 'italic' },
  ],
  variable: '--font-display',
  display: 'swap',
  // Josefin's small x-height makes the fallback swap read as a size jump
  // rather than a face change. Matching the metrics to a system face keeps
  // the layout still while the real file loads.
  adjustFontFallback: 'Arial',
  fallback: ['Futura', 'Avenir Next', 'Century Gothic', 'sans-serif'],
});

/*
 * Same family, second variable so `--font-body` and `--font-display` stay
 * separate knobs in the CSS. It costs nothing: both point at the file above,
 * and next/font emits one @font-face per unique source.
 */
const body = localFont({
  src: [
    { path: './fonts/JosefinSans-Variable.woff2', weight: '100 700', style: 'normal' },
    { path: './fonts/JosefinSans-Italic-Variable.woff2', weight: '100 700', style: 'italic' },
  ],
  variable: '--font-body',
  display: 'swap',
  adjustFontFallback: 'Arial',
  fallback: ['Futura', 'Avenir Next', 'Century Gothic', 'sans-serif'],
});

const mono = localFont({
  src: [{ path: './fonts/JetBrainsMono-Variable.woff2', weight: '100 800', style: 'normal' }],
  variable: '--font-mono',
  display: 'swap',
  adjustFontFallback: 'Arial',
  fallback: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
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
