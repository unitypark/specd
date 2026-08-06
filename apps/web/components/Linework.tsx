'use client';

/**
 * Hairline graphics — the line layer.
 *
 * Thin curves that draw themselves as they scroll into view, in the register of
 * a type-specimen sheet: a swash pointing at a word, a rule that runs off the
 * edge, an outlined counterform.
 *
 * Two rules keep it from becoming clutter:
 *   - It never sits on top of text. Every instance is behind content and
 *     `pointer-events: none`.
 *   - It draws once, on entry, and then holds. A line that keeps looping is a
 *     loading spinner, not a graphic.
 *
 * The draw uses `stroke-dasharray` with a scroll-driven timeline, so it costs
 * no JavaScript and disappears entirely under `prefers-reduced-motion`.
 */

import styles from './linework.module.css';

export type LineworkVariant = 'swash' | 'arc' | 'corner' | 'underline';

export function Linework({
  variant = 'swash',
  className = '',
  label,
}: {
  variant?: LineworkVariant;
  className?: string;
  /** Optional text set along the curve, specimen-sheet style. */
  label?: string;
}) {
  const id = `lw-${variant}`;

  if (variant === 'underline') {
    return (
      <svg className={`${styles.line} ${className}`} viewBox="0 0 420 24" fill="none" aria-hidden="true">
        <path
          className={styles.draw}
          d="M4 16c70 8 200 8 280-2 40-5 90-9 132-2"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </svg>
    );
  }

  if (variant === 'corner') {
    // An outlined counterform — the reference's hollow Z, in our register.
    return (
      <svg className={`${styles.line} ${className}`} viewBox="0 0 160 160" fill="none" aria-hidden="true">
        <path
          className={styles.draw}
          d="M28 26h104L44 134h104"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  if (variant === 'arc') {
    return (
      <svg className={`${styles.line} ${className}`} viewBox="0 0 600 300" fill="none" aria-hidden="true">
        <path
          className={styles.draw}
          d="M-20 250C120 250 200 60 340 60s180 90 300 70"
          stroke="currentColor"
          strokeWidth="1.2"
          strokeLinecap="round"
        />
      </svg>
    );
  }

  // swash — a curve with an arrowhead, and optionally text riding it.
  return (
    <svg className={`${styles.line} ${className}`} viewBox="0 0 620 160" fill="none" aria-hidden="true">
      <defs>
        <path id={id} d="M20 132C150 150 330 120 420 66 480 30 540 24 600 30" />
      </defs>
      <use
        href={`#${id}`}
        className={styles.draw}
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
      <path
        className={styles.tip}
        d="M592 20l14 10-14 10"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {label && (
        <text className={styles.pathlabel} dy="-8">
          <textPath href={`#${id}`} startOffset="32%">
            {label}
          </textPath>
        </text>
      )}
    </svg>
  );
}
