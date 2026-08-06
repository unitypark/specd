'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import styles from './ticket-to-spec.module.css';

/**
 * §02 — FROM TICKET TO SPEC (mockup rev 4/5).
 *
 * Two sentences in Jira on the left, the drafted spec on the right, and the
 * traceability between them made visible rather than asserted: Ⓐ/Ⓑ/Ⓒ mark
 * phrases carried over from the ticket, ⊕ marks requirements the ticket forgot
 * and `knowledge/` supplied, ⚠ marks the open question a human must answer.
 *
 * The animation is the argument. It plays in order — read the ticket, pull
 * knowledge, draft, flag — because the claim is that the agent *derives* the
 * spec, and a spec that simply appeared would not show that.
 */

interface SpecLine {
  text: string;
  marks?: string[];
  cite?: string;
  unverified?: boolean;
}

const TICKET_MARKS = ['A', 'B', 'C'] as const;

const SPEC_LINES: SpecLine[] = [
  { text: 'WHEN export on a filtered list → SHALL stream CSV honouring filters + columns.', marks: ['A', 'B'] },
  { text: 'WHEN >50k rows → SHALL deliver async, signed URL.', marks: ['C'], cite: 'decisions/0003' },
  { text: 'WHILE no export permission → SHALL hide + 403.', marks: ['⊕'], cite: 'conventions.md#authz' },
  { text: 'Reuses list-query builder', cite: 'architecture.md#contacts' },
  { text: 'UTF-8 BOM for Excel', marks: ['⊕'], cite: 'specs/CRM-112' },
  { text: 'Retention 24 h assumed → sales ops', unverified: true },
];

const KNOWLEDGE = ['architecture.md', 'decisions/0003', 'specs/CRM-112'];

export function TicketToSpec() {
  const [phase, setPhase] = useState<'idle' | 'reading' | 'drafting' | 'done'>('idle');
  const [litMarks, setLitMarks] = useState<string[]>([]);
  const [shown, setShown] = useState(0);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  const play = useCallback(() => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
    setPhase('idle');
    setLitMarks([]);
    setShown(0);

    const at = (fn: () => void, t: number) => timers.current.push(setTimeout(fn, t));

    at(() => setPhase('reading'), 400);
    TICKET_MARKS.forEach((m, i) => at(() => setLitMarks((p) => [...p, m]), 800 + i * 380));
    at(() => setPhase('drafting'), 2100);
    SPEC_LINES.forEach((_, i) => at(() => setShown(i + 1), 2400 + i * 420));
    at(() => setPhase('done'), 2400 + SPEC_LINES.length * 420 + 300);
    // Loops with the hero sheet, so the section is never a dead diagram.
    at(play, 2400 + SPEC_LINES.length * 420 + 6500);
  }, []);

  useEffect(() => {
    play();
    return () => timers.current.forEach(clearTimeout);
  }, [play]);

  return (
    <div className={styles.conv}>
      <div className={styles.bar}>
        <span className={styles.state} data-phase={phase}>
          {phase === 'idle' ? 'IDLE' : phase === 'reading' ? 'READING' : phase === 'drafting' ? 'DRAFTING' : 'AWAITING THE STAMP'}
        </span>
        <span className={styles.flex} />
        <button type="button" className={styles.replay} onClick={play}>
          ↺ REPLAY
        </button>
      </div>

      <div className={styles.grid}>
        {/* ── the ticket, as a human wrote it ───────────────────────────── */}
        <div className={`${styles.ticket} ${phase !== 'idle' ? styles.on : ''}`}>
          <div className={styles.tlabel}>JIRA — AS WRITTEN</div>
          <div className={styles.thead}>
            <b>AUR-142</b>
            <span className={styles.tchip}>Story</span>
            <span className={styles.flex} />
            <span className={styles.tstatus}>To Do</span>
          </div>
          <h4>Export contacts to CSV</h4>
          <p>
            Sales ops wants the contact lists in Excel for campaign prep.
            <Mark id="A" lit={litMarks} /> The filters set in the app should apply.
            <Mark id="B" lit={litMarks} />
          </p>
          <p className={styles.comment}>
            “Big lists shouldn’t freeze the browser like the old report.”
            <Mark id="C" lit={litMarks} />
          </p>
          <div className={styles.who}>
            <span className={styles.av}>JF</span> J. Feld · Account Manager
          </div>
        </div>

        {/* ── the agent, and what it reads ──────────────────────────────── */}
        <div className={styles.middle}>
          <div className={`${styles.agent} ${phase === 'drafting' || phase === 'reading' ? styles.work : ''}`}>
            {/* CUSTOM ILLUSTRATION SLOT — rev 14 left this for your own art. */}
            <span className={styles.cursor} />
          </div>
          <div className={styles.kb}>
            <span className={styles.kblabel}>knowledge/</span>
            {KNOWLEDGE.map((k, i) => (
              <span
                key={k}
                className={`${styles.kchip} ${phase !== 'idle' ? styles.fly : ''}`}
                style={{ animationDelay: `${i * 0.28}s` }}
              >
                {k}
              </span>
            ))}
          </div>
        </div>

        {/* ── the spec it drafts ────────────────────────────────────────── */}
        <div className={styles.spec}>
          <div className={styles.tlabel}>SPEC — AWAITING THE STAMP</div>
          <div className={styles.shead}>
            <b>SPEC — AUR-142</b>
            <span className={styles.flex} />
            <span className={styles.draft}>spec::draft</span>
          </div>
          {SPEC_LINES.map((line, i) => (
            <div key={line.text} className={`${styles.sline} ${i < shown ? styles.on : ''}`}>
              {line.text}
              {line.marks?.map((m) => (
                <span key={m} className={styles.mk}>
                  {m}
                </span>
              ))}
              {line.cite && <span className={styles.cite}>{line.cite} ✓</span>}
              {line.unverified && <span className={styles.unv}>⚠ UNVERIFIED</span>}
            </div>
          ))}
          <div className={`${styles.sfoot} ${phase === 'done' ? styles.on : ''}`}>
            [ ] 5 tasks · each ≤ 1 PR · last = as-built → knowledge/specs/
            <br />
            8 citations · 1 UNVERIFIED · 2 m 10 s · €0.21 — a human stamps it before any code
          </div>
        </div>
      </div>

      <p className={styles.legend}>
        <span className={styles.mk}>A</span> traced from the ticket ·{' '}
        <span className={styles.mk}>⊕</span> knowledge/ filled what the ticket forgot ·{' '}
        <span className={styles.unv}>⚠</span> needs a human · <span className={styles.cite}>✓</span>{' '}
        citation — the ticket stays in Jira, status syncs both ways
      </p>
    </div>
  );
}

function Mark({ id, lit }: { id: string; lit: string[] }) {
  return <span className={`${styles.mk} ${lit.includes(id) ? styles.lit : ''}`}>{id}</span>;
}
