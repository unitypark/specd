'use client';

import { useState } from 'react';

/**
 * The six-station line (D11). It is fixed on purpose: stations cannot be
 * added, skipped or removed, and the human gate is structural. This component
 * is therefore a *view*, never an editor — that constraint is the product, so
 * the UI must not imply otherwise.
 */

export interface Station {
  no: string;
  title: string;
  blurb: string;
  gate?: boolean;
  detail: string;
}

export const STATIONS: Station[] = [
  {
    no: '01',
    title: 'Connect',
    blurb: 'repos · AI · tracker',
    detail:
      'Installs the project’s connections: your code (GitHub, GitLab or fully local), an AI credential, and where tickets live. This is the only station that takes configuration.',
  },
  {
    no: '02',
    title: 'Ground',
    blurb: 'knowledge/ + AGENTS.md',
    detail:
      'The onboarding agent scans each repo read-only and drafts knowledge/ plus the working agreements, as a setup PR you review. Merging is adopting.',
  },
  {
    no: '03',
    title: 'Spec',
    blurb: 'ticket → Req / Design / Tasks',
    detail:
      'SpecAgent retrieves from your knowledge base and drafts EARS requirements, a cited design, and tasks of at most one PR each. What it cannot ground, it marks UNVERIFIED.',
  },
  {
    no: '04',
    title: 'Approve',
    blurb: 'a person stamps it',
    gate: true,
    detail:
      'A named human approves — recorded with who, when and which version. Agents never approve their own input. This station cannot be skipped, automated, or configured away.',
  },
  {
    no: '05',
    title: 'Build',
    blurb: 'any coding agent → PR',
    detail:
      'Hosted runner, your own agent via `specd spec pull`, or a human. All three end in a PR that references the spec. Only approved specs can be pulled.',
  },
  {
    no: '06',
    title: 'Learn',
    blurb: 'merge → knowledge base',
    detail:
      'The merged work files its as-built spec into knowledge/specs/ and re-indexes. The next spec is grounded in this one — context compounds instead of evaporating.',
  },
];

export function Pipeline({ light = false }: { light?: boolean }) {
  const [selected, setSelected] = useState(0);
  const station = STATIONS[selected]!;

  return (
    <div className={`pipeline ${light ? 'light' : ''}`}>
      <div className="pbar">
        <span className="ptitle">PROJECT SETUP — THE LINE</span>
        <span className="pflex" />
        <span className="pfixed">fixed · stations can’t be skipped or removed</span>
      </div>

      <div className="prow">
        {STATIONS.map((s, i) => (
          <button
            key={s.no}
            type="button"
            className={`stn ${s.gate ? 'gate' : ''} ${i === selected ? 'sel' : ''}`}
            onClick={() => setSelected(i)}
            aria-pressed={i === selected}
          >
            {s.gate && <span className="hu">HUMAN</span>}
            <span className="no">{s.no}</span>
            <b>{s.title}</b>
            <span className="d">{s.blurb}</span>
          </button>
        ))}
      </div>

      <p className="loopback">as-built specs feed station 02 — context compounds</p>

      <div className="pinfo">
        <b>
          {station.no} {station.title}
        </b>{' '}
        {station.detail}
      </div>

      <style jsx>{`
        .pipeline {
          border: 1px solid var(--line);
          border-radius: 10px;
          background: var(--panel);
          padding: 0.85rem 0.95rem 0.75rem;
        }
        .pipeline.light {
          background: var(--paper);
          border-color: rgba(26, 36, 29, 0.15);
        }
        .pbar {
          display: flex;
          align-items: center;
          gap: 0.6rem;
          padding-bottom: 0.6rem;
        }
        .ptitle,
        .pfixed {
          font: 700 0.57rem/1 var(--mono);
          letter-spacing: 0.16em;
          color: var(--ink-3);
        }
        .light .ptitle,
        .light .pfixed {
          color: rgba(26, 36, 29, 0.55);
        }
        .pfixed {
          letter-spacing: 0.08em;
          text-transform: none;
        }
        .pflex {
          flex: 1;
        }
        .prow {
          display: flex;
          gap: 0.5rem;
        }
        .stn {
          position: relative;
          flex: 1;
          min-width: 0;
          text-align: left;
          border: 1.5px solid var(--line-2);
          border-radius: 7px;
          padding: 0.55rem 0.5rem 0.5rem;
          cursor: pointer;
          background: var(--panel-2);
          color: inherit;
        }
        .light .stn {
          background: rgba(26, 36, 29, 0.03);
          border-color: rgba(26, 36, 29, 0.2);
        }
        .stn:hover,
        .stn.sel {
          border-color: var(--accent);
        }
        .stn.sel {
          box-shadow: 0 0 0 3px rgba(43, 226, 106, 0.13);
        }
        .stn .no {
          display: block;
          font: 700 0.52rem/1 var(--mono);
          letter-spacing: 0.18em;
          color: var(--accent);
          margin-bottom: 0.3rem;
        }
        .stn b {
          display: block;
          font: 600 0.82rem/1.15 var(--serif);
          color: var(--ink);
          margin-bottom: 0.2rem;
        }
        .light .stn b {
          color: var(--paper-ink);
        }
        .stn .d {
          display: block;
          font: 500 0.55rem/1.45 var(--mono);
          color: var(--ink-3);
        }
        .light .stn .d {
          color: rgba(26, 36, 29, 0.6);
        }
        /* The gate wears the accent permanently — it is the one station whose
           meaning is "a human acts here". */
        .stn.gate {
          border-color: var(--accent);
          background: var(--accent-soft);
        }
        .stn .hu {
          position: absolute;
          top: 0.4rem;
          right: 0.4rem;
          font: 800 0.46rem/1 var(--mono);
          letter-spacing: 0.12em;
          color: var(--accent);
          border: 1px solid var(--accent-dim);
          border-radius: 3px;
          padding: 0.16em 0.3em;
        }
        .loopback {
          margin: 0.6rem 0 0;
          text-align: center;
          font: 600 0.54rem/1 var(--mono);
          letter-spacing: 0.08em;
          color: var(--ink-3);
        }
        .light .loopback {
          color: rgba(26, 36, 29, 0.5);
        }
        .pinfo {
          border-top: 1px dashed var(--line);
          margin-top: 0.65rem;
          padding-top: 0.65rem;
          font-size: 0.78rem;
          line-height: 1.65;
          color: var(--ink-2);
          min-height: 3.4rem;
        }
        .light .pinfo {
          color: rgba(26, 36, 29, 0.75);
          border-color: rgba(26, 36, 29, 0.15);
        }
        .pinfo b {
          font-family: var(--serif);
          font-weight: 600;
          color: var(--ink);
        }
        .light .pinfo b {
          color: var(--paper-ink);
        }
        @media (max-width: 820px) {
          .prow {
            flex-wrap: wrap;
          }
          .stn {
            flex: 1 1 30%;
          }
        }
      `}</style>
    </div>
  );
}
