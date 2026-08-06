'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import styles from './compounding-loop.module.css';

/**
 * The hero visual: the loop that compounds.
 *
 * The pipeline diagram states this as a dashed line labelled "as-built specs
 * feed station 02 — context compounds". True, and unreadable to anyone who is
 * not already sold. This says the same thing by *showing* it: a marker goes
 * round, and every lap the stack in the middle gets one taller.
 *
 * That is the whole argument. Most coding agents start every session from
 * nothing; this one starts from everything it has already shipped. The proof
 * is not a label — it is that the pile visibly grows while you watch.
 *
 * Deliberately not technical. No station numbers, no EARS, no file paths —
 * four plain sentences and a counter.
 */

const STEPS = [
  { title: 'You approve a spec', note: 'nothing is built without your stamp' },
  { title: 'The agent builds it', note: 'one commit per task, then a pull request' },
  { title: 'It writes down what it built', note: 'filed back into your knowledge base' },
  { title: 'The next spec starts smarter', note: 'it has read everything before it' },
] as const;

/** Where each step sits on the ring, in degrees clockwise from the top. */
const ANGLE = [0, 90, 180, 270];
const R = 118;
const CX = 160;
const CY = 160;

function point(deg: number) {
  const rad = ((deg - 90) * Math.PI) / 180;
  return { x: CX + R * Math.cos(rad), y: CY + R * Math.sin(rad) };
}

export function CompoundingLoop() {
  const [step, setStep] = useState(0);
  const [docs, setDocs] = useState(3);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const tick = useCallback(() => {
    setStep((s) => {
      const next = (s + 1) % STEPS.length;
      // A completed lap files one more spec into the knowledge base.
      if (next === 0) setDocs((d) => (d >= 9 ? 3 : d + 1));
      return next;
    });
  }, []);

  useEffect(() => {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (reduced.matches) return;
    timer.current = setInterval(tick, 2600);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [tick]);

  const marker = point(ANGLE[step]!);

  return (
    <div className={styles.wrap}>
      <div className={styles.stage}>
        <svg viewBox="0 0 320 320" className={styles.ring} aria-hidden="true">
          <circle cx={CX} cy={CY} r={R} className={styles.track} />
          {/* The travelling arc — one quarter, rotated to the current step. */}
          <circle
            cx={CX}
            cy={CY}
            r={R}
            className={styles.progress}
            style={{ transform: `rotate(${ANGLE[step]! - 90}deg)` }}
          />
          {ANGLE.map((a, i) => {
            const p = point(a);
            return (
              <circle
                key={a}
                cx={p.x}
                cy={p.y}
                r={i === step ? 7 : 4.5}
                className={`${styles.node} ${i === step ? styles.nodeOn : ''}`}
              />
            );
          })}
          <circle cx={marker.x} cy={marker.y} r="11" className={styles.marker} />
        </svg>

        {/* The knowledge base, growing a layer per lap. */}
        <div className={styles.core}>
          <div className={styles.stack}>
            {Array.from({ length: docs }, (_, i) => (
              <span
                key={i}
                className={styles.doc}
                style={{ bottom: `${i * 7}px`, opacity: 0.35 + i * 0.075 }}
              />
            ))}
          </div>
          <div className={styles.count}>
            <b>{docs}</b>
            <span>specs your agent has read</span>
          </div>
        </div>
      </div>

      <ol className={styles.steps}>
        {STEPS.map((s, i) => (
          <li key={s.title} className={i === step ? styles.on : ''}>
            <b>{s.title}</b>
            <span>{s.note}</span>
          </li>
        ))}
      </ol>

      <p className={styles.foot}>
        Every finished job teaches the next one. Most agents start each session from nothing.
      </p>
    </div>
  );
}
