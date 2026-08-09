'use client';

import { useCallback, useEffect, useState } from 'react';
import { API_BASE, del, get, patch, post } from '@/lib/api';
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

interface RunnerSummary {
  id: string;
  name: string;
  paired: boolean;
  pending: boolean;
  pairedAt: string | null;
  lastSeenAt: string | null;
}

const KIND_LABEL: Record<string, { icon: string; title: string }> = {
  vcs: { icon: '🐙', title: 'Code' },
  ai: { icon: '🔑', title: 'AI provider' },
  tracker: { icon: '📋', title: 'Tracker' },
};

function relativeTime(iso: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

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
  const [model, setModel] = useState(project.defaultModel);
  const [paused, setPaused] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [runnerList, setRunnerList] = useState<RunnerSummary[]>([]);
  const [runnerName, setRunnerName] = useState('');
  const [justPaired, setJustPaired] = useState<{ name: string; pairCode: string } | null>(null);
  const [runnerBusy, setRunnerBusy] = useState(false);
  const [runnerError, setRunnerError] = useState<string | null>(null);

  const load = useCallback(() => {
    get<Connection[]>(`/projects/${slug}/connections`).then(setConnections).catch(() => undefined);
  }, [slug]);

  useEffect(load, [load]);

  const loadRunners = useCallback(() => {
    get<RunnerSummary[]>(`/projects/${slug}/runners`).then(setRunnerList).catch(() => undefined);
  }, [slug]);

  useEffect(loadRunners, [loadRunners]);

  // While a runner is still awaiting its first pairing, poll for it — the
  // moment `docker run specd/runner --pair <code>` completes the handshake
  // server-side, this tab should notice without a manual refresh.
  useEffect(() => {
    if (!runnerList.some((r) => r.pending)) return;
    const id = setInterval(loadRunners, 4000);
    return () => clearInterval(id);
  }, [runnerList, loadRunners]);

  async function createRunnerPairing() {
    if (!runnerName.trim()) return;
    setRunnerBusy(true);
    setRunnerError(null);
    try {
      const created = await post<{ id: string; name: string; pairCode: string }>(
        `/projects/${slug}/runners`,
        { name: runnerName.trim() },
      );
      setJustPaired({ name: created.name, pairCode: created.pairCode });
      setRunnerName('');
      loadRunners();
    } catch (err) {
      setRunnerError(err instanceof Error ? err.message : 'Failed to create pairing code');
    } finally {
      setRunnerBusy(false);
    }
  }

  async function removeRunner(id: string) {
    setRunnerBusy(true);
    setRunnerError(null);
    try {
      await del(`/projects/${slug}/runners/${id}`);
      loadRunners();
    } catch (err) {
      setRunnerError(err instanceof Error ? err.message : 'Failed to remove runner');
    } finally {
      setRunnerBusy(false);
    }
  }

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
        <h5>Self-hosted runners</h5>
        <p className="sub">
          Pair a machine you control to drive builds and specs with its own Claude Code subscription.
          specd never sees or stores that credential — only the runner does.
        </p>

        {runnerError && <div className="err">{runnerError}</div>}

        {runnerList.length > 0 && (
          <ul className="runnerList">
            {runnerList.map((r) => (
              <li key={r.id}>
                <span className={r.paired ? 'pill on' : 'pill warn'}>
                  {r.paired ? 'paired' : 'awaiting pairing'}
                </span>
                <span className="mono">{r.name}</span>
                <span className="flex" />
                <span className="ink3">
                  {r.lastSeenAt ? `last seen ${relativeTime(r.lastSeenAt)}` : 'never connected'}
                </span>
                <button
                  type="button"
                  className="btn sm"
                  disabled={runnerBusy}
                  onClick={() => removeRunner(r.id)}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}

        {justPaired && (
          <div className="pairBox">
            <p className="pairLabel">
              Pairing code for <b>{justPaired.name}</b> — shown once, copy it now:
            </p>
            <code className="pairCode">{justPaired.pairCode}</code>
            <p className="pairLabel">Run this on the machine you want to pair:</p>
            <pre>{`specd runner pair ${justPaired.pairCode} --api ${API_BASE}`}</pre>
            <p className="hint">
              Pairing proves the machine and stores its credential. To run work on it, start the
              daemon there too: <code>SPECD_RUNNER_TOKEN=$(specd runner token) pnpm --filter
              @specd/runner start</code>. It executes spec and onboarding jobs; builds still run
              here.
            </p>
            <button type="button" className="btn sm" onClick={() => setJustPaired(null)}>
              Done
            </button>
          </div>
        )}

        {!justPaired && (
          <div className="inline">
            <input
              value={runnerName}
              onChange={(e) => setRunnerName(e.target.value)}
              placeholder="e.g. alice-macbook"
            />
            <button
              type="button"
              className="btn sm"
              disabled={runnerBusy || !runnerName.trim()}
              onClick={createRunnerPairing}
            >
              + Generate pairing code
            </button>
          </div>
        )}
      </div>

      <div className="card">
        <h5>Default model</h5>
        <p className="sub">
          Used by every agent run in this project. Changing it takes effect on the next run.
        </p>
        <div className="inline">
          <select
            value={model}
            onChange={(e) => {
              setModel(e.target.value);
              save({ defaultModel: e.target.value });
            }}
          >
            <option value="claude-opus-5">claude-opus-5 · deepest specs</option>
            <option value="claude-sonnet-5">claude-sonnet-5 · balanced</option>
            <option value="claude-haiku-4-5">claude-haiku-4-5 · drafts &amp; indexing</option>
          </select>
          {saved && <span className="ok">saved ✓</span>}
        </div>
      </div>

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
          font: 600 1.058rem/1.2 var(--sans);
          margin: 0 0 0.2rem;
        }
        p {
          font-size: 0.943rem;
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
        .inline select {
          font: 400 0.978rem/1 var(--sans);
          padding: 0.45rem 0.6rem;
          border-radius: 6px;
          border: 1px solid var(--line-2);
          background: var(--bg-2);
          color: var(--ink);
        }
        .inline input {
          width: 5rem;
          font: 400 0.998rem/1 var(--sans);
          padding: 0.45rem 0.6rem;
          border-radius: 6px;
          border: 1px solid var(--line-2);
          background: var(--bg-2);
          color: var(--ink);
        }
        .pfx,
        .sfx {
          font: 500 0.963rem/1 var(--mono);
          color: var(--ink-3);
        }
        .ok {
          color: var(--accent);
          font: 600 0.902rem/1 var(--mono);
        }
        .runnerList {
          list-style: none;
          margin: 0 0 0.9rem;
          padding: 0;
          border: 1px solid var(--line);
          border-radius: 6px;
          overflow: hidden;
        }
        .runnerList li {
          display: flex;
          align-items: center;
          gap: 0.6rem;
          padding: 0.55rem 0.8rem;
          border-bottom: 1px solid var(--line);
          font-size: 0.9rem;
        }
        .runnerList li:last-child {
          border-bottom: none;
        }
        .ink3 {
          color: var(--ink-3);
          font-size: 0.86rem;
        }
        .pairBox {
          background: var(--bg-2);
          border: 1px solid var(--line-2);
          border-radius: 6px;
          padding: 0.9rem 1rem;
          margin-bottom: 0.9rem;
        }
        .pairLabel {
          font-size: 0.9rem;
          margin: 0 0 0.4rem;
        }
        .pairCode {
          display: block;
          font: 700 1.3rem/1 var(--mono);
          letter-spacing: 0.08em;
          color: var(--accent);
          margin-bottom: 0.7rem;
        }
        .pairBox pre {
          font: 400 0.86rem/1.5 var(--mono);
          background: var(--bg);
          border: 1px solid var(--line);
          border-radius: 4px;
          padding: 0.6rem 0.8rem;
          overflow-x: auto;
          margin: 0 0 0.6rem;
        }
        .pairBox .hint {
          font-size: 0.82rem;
          color: var(--ink-3);
          line-height: 1.5;
          margin: 0 0 0.7rem;
        }
      `}</style>
    </div>
  );
}
