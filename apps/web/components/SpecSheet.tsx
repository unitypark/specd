'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * The hero: a spec sheet drafting itself, then taking the stamp.
 *
 * It is not decoration — it is the product's one-sentence argument made
 * visible. Lines appear in order (EARS criteria, then cited design, then
 * sized tasks), the APPROVED stamp lands last, and only then does the build
 * footer appear. The sequence *is* the gate.
 */

const LINES = [
  { kind: 'h', text: 'REQUIREMENTS · EARS' },
  {
    kind: 'ears',
    prefix: 'WHEN',
    body: 'a user of an SSO-enforced workspace signs in,',
    verb: 'THE SYSTEM SHALL',
    tail: 'redirect to Okta with PKCE.',
  },
  {
    kind: 'ears',
    prefix: 'WHILE',
    body: 'enforcement is on,',
    verb: 'THE SYSTEM SHALL',
    tail: 'reject password grants with 403 SSO_REQUIRED.',
  },
  { kind: 'h', text: 'DESIGN · GROUNDED IN YOUR KNOWLEDGE BASE' },
  {
    kind: 'cite',
    body: 'OidcStrategy beside the local strategy, behind the auth facade',
    cite: 'knowledge/architecture.md#auth ✓',
  },
  {
    kind: 'cite',
    body: 'Token refresh mirrors the shipped pattern',
    cite: 'specs/CRM-097-auth-refresh.md ✓',
    unverified: 'UNVERIFIED — ask Okta admin',
  },
  { kind: 'h', text: 'TASKS · EACH ≤ ONE PR' },
  { kind: 'task', id: 'T1', body: 'IdP config + admin toggle', size: 'M' },
  { kind: 'task', id: 'T2', body: 'OIDC flow + callback + JIT provisioning', size: 'M' },
  { kind: 'task', id: 'T5', body: 'file as-built spec → knowledge/specs/', size: 'S · always last' },
] as const;

export function SpecSheet() {
  const [shown, setShown] = useState(0);
  const [stamped, setStamped] = useState(false);
  const [delivered, setDelivered] = useState(false);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  const play = useCallback(() => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
    setShown(0);
    setStamped(false);
    setDelivered(false);

    LINES.forEach((_, i) => {
      timers.current.push(setTimeout(() => setShown(i + 1), 380 + i * 330));
    });
    const after = 380 + LINES.length * 330;
    timers.current.push(setTimeout(() => setStamped(true), after + 500));
    timers.current.push(setTimeout(() => setDelivered(true), after + 1400));
  }, []);

  useEffect(() => {
    play();
    return () => timers.current.forEach(clearTimeout);
  }, [play]);

  return (
    <div className="host">
      <div className="bar">
        <span>
          SPECAGENT — DRAFTING <span className="live">● LIVE</span>
        </span>
        <button type="button" className="replay" onClick={play}>
          ↺ REPLAY
        </button>
      </div>

      <div className="sheet">
        <div className="shead">
          <b>SPEC — CRM-131 · Single sign-on via Okta (OIDC)</b>
          <span className="rv">v2 · aurora-crm</span>
        </div>

        {LINES.map((line, i) => {
          const on = i < shown;
          if (line.kind === 'h') {
            return (
              <h6 key={i} className={on ? 'on' : ''}>
                {line.text}
              </h6>
            );
          }
          if (line.kind === 'ears') {
            return (
              <p key={i} className={`ln ${on ? 'on' : ''}`}>
                <span className="ears">{line.prefix}</span> {line.body}{' '}
                <span className="ears">{line.verb}</span> {line.tail}
              </p>
            );
          }
          if (line.kind === 'cite') {
            return (
              <p key={i} className={`ln ${on ? 'on' : ''}`}>
                {line.body} <span className="cite">{line.cite}</span>
                {'unverified' in line && line.unverified ? (
                  <span className="cite unv">{line.unverified}</span>
                ) : null}
              </p>
            );
          }
          return (
            <p key={i} className={`ln task ${on ? 'on' : ''}`}>
              <span className="cb">[ ]</span>
              <span>
                <b>{line.id}</b> {line.body}
              </span>
              <span className="sz">{line.size}</span>
            </p>
          );
        })}

        <div className={`stamp ${stamped ? 'on' : ''}`}>
          APPROVED
          <small>DANA K. · V2 · 2026-08-05</small>
        </div>

        <div className={`foot ${delivered ? 'on' : ''}`}>
          BUILD → PR #218 <span className="ok">merged ✓</span> — as-built filed to
          knowledge/specs/CRM-131-okta-sso.md → re-indexed, <b>grounds the next spec</b>
        </div>
      </div>

      <style jsx>{`
        .host {
          width: 100%;
        }
        .bar {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 0.45rem;
          font: 700 0.57rem/1 var(--mono);
          letter-spacing: 0.14em;
          color: var(--ink-3);
        }
        .live {
          color: var(--accent);
        }
        .replay {
          cursor: pointer;
          color: var(--accent);
          background: none;
          border: 1px solid var(--line-2);
          border-radius: 6px;
          padding: 0.32rem 0.6rem;
          font: 600 0.59rem/1 var(--mono);
          letter-spacing: 0.08em;
        }
        .replay:hover {
          border-color: var(--accent);
        }
        .sheet {
          position: relative;
          background: var(--paper);
          color: var(--paper-ink);
          border-radius: 6px;
          padding: 0.9rem 1.05rem 0.85rem;
          font-size: 0.72rem;
          box-shadow: 0 26px 60px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(0, 0, 0, 0.25);
          min-height: 400px;
        }
        .shead {
          display: flex;
          justify-content: space-between;
          gap: 0.8rem;
          border-bottom: 2px solid var(--paper-ink);
          padding-bottom: 0.45rem;
          margin-bottom: 0.5rem;
          font-family: var(--mono);
        }
        .shead b {
          font: 700 0.67rem/1.4 var(--mono);
        }
        .rv {
          color: #8a8578;
          font-size: 0.61rem;
          white-space: nowrap;
        }
        h6 {
          font: 700 0.55rem/1 var(--mono);
          letter-spacing: 0.18em;
          color: #8a8578;
          margin: 0.75rem 0 0.3rem;
          opacity: 0;
          transition: opacity 0.3s;
        }
        h6:first-of-type {
          margin-top: 0;
        }
        h6.on {
          opacity: 1;
        }
        .ln {
          opacity: 0;
          transform: translateY(3px);
          transition: opacity 0.3s, transform 0.3s;
          font-size: 0.7rem;
          line-height: 1.55;
          margin: 0.24rem 0;
        }
        .ln.on {
          opacity: 1;
          transform: none;
        }
        .ears {
          font: 700 0.58rem/1 var(--mono);
          color: #1f7a45;
        }
        .cite {
          display: inline-block;
          font: 600 0.54rem/1 var(--mono);
          background: #e9f0e9;
          color: #1f7a45;
          border: 1px solid #cfdccf;
          border-radius: 4px;
          padding: 0.14em 0.35em;
          margin-left: 0.25em;
          white-space: nowrap;
        }
        /* An unverified claim must not look like a citation. Same shape, but
           it reads as a question, not an answer. */
        .cite.unv {
          background: #fbf3e2;
          color: #8a6d1f;
          border-color: #e3d3a8;
        }
        .task {
          display: flex;
          gap: 0.45em;
          align-items: baseline;
        }
        .cb {
          font-family: var(--mono);
          color: #8a8578;
          flex: none;
          font-size: 0.62rem;
        }
        .sz {
          margin-left: auto;
          font: 500 0.56rem/1 var(--mono);
          color: #8a8578;
          flex: none;
        }
        .stamp {
          position: absolute;
          right: 1.1rem;
          top: 40%;
          transform: rotate(-8deg) scale(1.7);
          opacity: 0;
          border: 3px double var(--accent-dim);
          color: var(--accent-dim);
          font: 800 0.74rem/1.35 var(--mono);
          letter-spacing: 0.16em;
          padding: 0.5rem 0.85rem;
          border-radius: 6px;
          text-align: center;
          background: rgba(43, 226, 106, 0.1);
          transition: opacity 0.26s, transform 0.26s cubic-bezier(0.2, 1.5, 0.4, 1);
          pointer-events: none;
        }
        .stamp.on {
          opacity: 1;
          transform: rotate(-8deg) scale(1);
        }
        .stamp small {
          display: block;
          font: 700 0.5rem/1.5 var(--mono);
          letter-spacing: 0.1em;
        }
        .foot {
          border-top: 1px dashed #b9b29e;
          margin-top: 0.7rem;
          padding-top: 0.5rem;
          font: 600 0.58rem/1.7 var(--mono);
          color: #4c5560;
          opacity: 0;
          transition: opacity 0.4s;
        }
        .foot.on {
          opacity: 1;
        }
        .ok {
          color: #1f7a45;
        }
      `}</style>
    </div>
  );
}
