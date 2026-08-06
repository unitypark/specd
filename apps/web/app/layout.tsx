import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'specd — software, built to spec',
  description:
    'One setup builds your knowledge base, briefs an agent with your full context, and gates every change behind a human-approved spec.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
