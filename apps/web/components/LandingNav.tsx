'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { AuthLink } from './AuthLink';
import { Logo } from './Logo';
import styles from '../app/landing.module.css';

/**
 * The landing nav (mockup rev 21–23): APPS · TEMPLATES · PRICING · DOCS ·
 * COMMUNITY, then the sign-in link and the primary CTA.
 *
 * The section links that once lived here (THE SYSTEM / TICKET → SPEC / …) were
 * deliberately removed in rev 23 — a nav of anchors competes with the page's
 * own scroll rather than helping it. These four are destinations.
 */

const APPS = [
  { label: 'WEB', href: '/apps#web' },
  { label: 'CLI', href: '/apps#cli' },
  { label: 'MOBILE', href: '/apps#mobile', badge: 'PREVIEW' },
];

const COMMUNITY = [
  { label: 'DISCORD', href: 'https://discord.gg/specd' },
  { label: 'GITHUB', href: 'https://github.com/specd-dev' },
];

export function LandingNav() {
  const [open, setOpen] = useState<'apps' | 'community' | null>(null);
  const [scrolled, setScrolled] = useState(false);
  const navRef = useRef<HTMLElement>(null);

  // At the very top the bar sits on the hero and needs no edge; once anything
  // scrolls beneath it, the border is what separates the two.
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  // A dropdown that survives a click elsewhere on the page is a dropdown that
  // feels stuck. Escape closes it too — it is a menu, not a dialog.
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (!navRef.current?.contains(e.target as Node)) setOpen(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(null);
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <nav className={styles.nav} ref={navRef}>
      {/* The bar floats inside the sticky wrapper — the wrapper supplies the
          inset, the inner pill carries the glass. */}
      <div className={`${styles.navbar} ${scrolled ? styles.navbarScrolled : ''}`}>
      <Link href="/" className={styles.logo}>
        <Logo size={32} title="specd" glow />
        <span>
          spec<i>d</i>
        </span>
      </Link>

      {/* Centre group. In its own grid column so it centres on the bar, not on
          whatever space the brand and actions happen to leave. */}
      <div className={styles.tabs}>
      <div className={styles.dd}>
        <button
          type="button"
          className={styles.lk}
          aria-expanded={open === 'apps'}
          aria-haspopup="true"
          onClick={() => setOpen(open === 'apps' ? null : 'apps')}
        >
          APPS <span className={styles.caret}>▾</span>
        </button>
        {open === 'apps' && (
          <div className={styles.ddmenu}>
            {APPS.map((a) => (
              <Link key={a.label} href={a.href} onClick={() => setOpen(null)}>
                {a.label}
                {a.badge && <i>{a.badge}</i>}
              </Link>
            ))}
          </div>
        )}
      </div>

      <Link href="/templates" className={styles.lk}>
        TEMPLATES
      </Link>
      <Link href="/pricing" className={styles.lk}>
        PRICING
      </Link>
      <Link href="/docs" className={styles.lk}>
        DOCS
      </Link>

      <div className={styles.dd}>
        <button
          type="button"
          className={styles.lk}
          aria-expanded={open === 'community'}
          aria-haspopup="true"
          onClick={() => setOpen(open === 'community' ? null : 'community')}
        >
          COMMUNITY <span className={styles.caret}>▾</span>
        </button>
        {open === 'community' && (
          <div className={styles.ddmenu}>
            {COMMUNITY.map((c) => (
              <a
                key={c.label}
                href={c.href}
                target="_blank"
                rel="noreferrer noopener"
                onClick={() => setOpen(null)}
              >
                {c.label}
              </a>
            ))}
          </div>
        )}
      </div>

      </div>

      <div className={styles.actions}>
      <span className={styles.rev}>V0.1</span>
      {/* SIGN IN for a visitor; for someone already signed in, the way back
          into the app — the prompt they do not need becomes the link they do. */}
      <AuthLink className={styles.navlink} signInLabel="SIGN IN" dashboardLabel="DASHBOARD" />
      <Link href="/setup" className={styles.cta}>
        Start your setup
      </Link>
      </div>
      </div>
    </nav>
  );
}
