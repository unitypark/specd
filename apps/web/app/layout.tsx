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
      <body>{children}</body>
    </html>
  );
}
