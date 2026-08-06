'use client';

import { useCallback, useEffect, useState } from 'react';
import { get, patch } from '@/lib/api';
import type { ProjectSummary } from '@/lib/types';

interface Connection {
  id: string;
  kind: string;
  provider: string;
  label: string | null;
  status: string;
  hasSecret: boolean;
  lastValidatedAt: string | null;
}

const KIND_LABEL: Record<string, { icon: string; title: string }> = {
  vcs: { icon: '🐙', title: 'Code' },
  ai: { icon: '🔑', title: 'AI provider' },
  tracker: { icon: '📋', title: 'Tracker' },
};

export function SettingsView({
  slug,
  project,
  onChange,
}: {
  slug: string;
  project: ProjectSummary;
  onChange: () => void;
}) {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [cap, setCap] = useState((project.spendCapCents / 100).toFixed(0));
  const [paused, setPaused] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    get<Connection[]>(`/projects/${slug}/connections`).then(setConnections).catch(() => undefined);
  }, [slug]);

  useEffect(load, [load]);

  async function save(body: Record<string, unknown>) {
    setError(null);
    try {
      await patch(`/projects/${slug}`, body);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      onChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    }
  }

  return (
    <div className="wrap">
      {error && <div className="err">{error}</div>}

      {connections.map((c) => {
        const meta = KIND_LABEL[c.kind] ?? { icon: '🔌', title: c.kind };
        return (
          <div key={c.id} className="card row">
            <span className="ic">{meta.icon}</span>
            <div>
              <h5>{meta.title}</h5>
              <p>
                {c.provider}
                {c.label ? ` · ${c.label}` : ''}
                {c.hasSecret ? ' · credential stored (encrypted)' : ''}
              </p>
            </div>
            <span className="flex" />
            <span className="pill on">{c.status}</span>
          </div>
        );
      })}

      <div className="card">
        <h5>Spend cap</h5>
        <p className="sub">
          Enforced before every agent run. A run that would start over budget is refused rather than
          truncated.
        </p>
        <div className="inline">
          <span className="pfx">€</span>
          <input value={cap} onChange={(e) => setCap(e.target.value)} inputMode="numeric" />
          <span className="sfx">/ month</span>
          <button
            type="button"
            className="btn sm"
            onClick={() => save({ spendCapCents: Math.round(Number(cap || '0') * 100) })}
          >
            Save
          </button>
          {saved && <span className="ok">saved ✓</span>}
        </div>
      </div>

      <div className="card">
        <h5>Kill switch</h5>
        <p className="sub">
          Stops every agent run in this project immediately. Existing specs and knowledge are
          untouched.
        </p>
        <button
          type="button"
          className={paused ? 'btn' : 'btn danger'}
          onClick={() => {
            const next = !paused;
            setPaused(next);
            save({ agentsPaused: next });
          }}
        >
          {paused ? 'Resume agent runs' : 'Pause all agent runs'}
        </button>
      </div>

      <div className="card">
        <h5>Leaving is free</h5>
        <p className="sub">
          Git is the only source of truth for knowledge. specd holds a derived index — embeddings,
          metadata and run history. Delete this project and everything that matters stays in your
          repositories, exactly where it already is.
        </p>
      </div>

      <style jsx>{`
        .wrap {
          max-width: 40rem;
          display: flex;
          flex-direction: column;
          gap: 0.8rem;
        }
        .row {
          display: flex;
          align-items: center;
          gap: 0.9rem;
        }
        .ic {
          font-size: 1.2rem;
        }
        .flex {
          flex: 1;
        }
        h5 {
          font: 600 0.92rem/1.2 var(--sans);
          margin: 0 0 0.2rem;
        }
        p {
          font-size: 0.78rem;
          color: var(--ink-3);
          margin: 0;
          line-height: 1.6;
        }
        .sub {
          margin-bottom: 0.9rem;
        }
        .inline {
          display: flex;
          align-items: center;
          gap: 0.5rem;
        }
        .inline input {
          width: 5rem;
          font: 400 0.86rem/1 var(--sans);
          padding: 0.45rem 0.6rem;
          border-radius: 6px;
          border: 1px solid var(--line-2);
          background: var(--bg-2);
          color: var(--ink);
        }
        .pfx,
        .sfx {
          font: 500 0.8rem/1 var(--mono);
          color: var(--ink-3);
        }
        .ok {
          color: var(--accent);
          font: 600 0.74rem/1 var(--mono);
        }
      `}</style>
    </div>
  );
}
