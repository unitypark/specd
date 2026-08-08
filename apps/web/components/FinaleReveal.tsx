'use client';

import { useEffect, useRef, useState } from 'react';
import styles from './finale-reveal.module.css';

const HOOK = 'M8.48 7.26A8 8 0 1 1 20 16.93';

/**
 * The landing page's closing moment: the mark grows in from a point at its
 * own centre, spinning and opening — its four hooks pulling apart and
 * fading, the way a lid lifts off a box — while the headline beneath it
 * grows in alongside it, not after it stops. On direct instruction
 * ("spinning and opens up and shows text... like a treasure comes out from
 * box", refined further: "logo start from center and bigger than now, text
 * should be coming out from logo while spinning"), replacing the previous
 * static medallion (a dark circle behind a glowing mark) with an unboxed
 * flat mark and this entrance sequence.
 *
 * `animation-timeline: view()` — the mechanism the rest of this page uses
 * for scroll-triggered reveals (see landing-page.module.css's `.rise`) —
 * isn't the right tool here: its progress *is* scroll position, so a
 * multi-beat "grow, spin, open, reveal" story would require scrolling a
 * precise distance to watch play out, rather than playing over time once
 * triggered. This uses IntersectionObserver instead and ordinary
 * time-based `@keyframes` for the actual choreography. The one instance of
 * this pattern on the page; everywhere else, the simpler scroll-linked
 * fade is the right call and this deliberately isn't reused there.
 *
 * Replays every time the section re-enters view, not just once: `play`
 * tracks `entry.isIntersecting` directly rather than latching true and
 * disconnecting. Scrolling away removes the `.play` class, which — because
 * nothing here is hidden *except* through that class (see below) — snaps
 * everything back to its plain resting state instantly, ready to animate
 * in again from the top the next time the section crosses the same
 * threshold, exactly the "scroll away and back replays it" behaviour asked
 * for. No debounce/hysteresis beyond the observer's own threshold: a
 * single `threshold: 0.5` value drives both the enter and exit edge.
 *
 * Without JS (or under `prefers-reduced-motion`), nothing here is ever
 * hidden: the `.play` class — and with it every animation rule below — is
 * the only thing that can pull an element to its keyframe-0% state, so a
 * failed observer or disabled JS just leaves the mark and headline at
 * their normal, fully-visible resting styles. See finale-reveal.module.css.
 */
export function FinaleReveal({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [play, setPlay] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([entry]) => setPlay(entry.isIntersecting), {
      threshold: 0.5,
    });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div ref={ref} className={`${styles.wrap} ${play ? styles.play : ''}`}>
      <svg className={styles.mark} viewBox="0 0 32 32" width="132" height="132" aria-hidden="true">
        <g className={styles.spinner}>
          <g transform="rotate(0 16 16)">
            <path className={styles.hook} d={HOOK} />
          </g>
          <g transform="rotate(90 16 16)">
            <path className={styles.hook} d={HOOK} />
          </g>
          <g transform="rotate(180 16 16)">
            <path className={styles.hook} d={HOOK} />
          </g>
          <g transform="rotate(270 16 16)">
            <path className={styles.hook} d={HOOK} />
          </g>
        </g>
      </svg>
      {children}
    </div>
  );
}
