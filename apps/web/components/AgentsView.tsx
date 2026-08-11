'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { get, streamRun } from '@/lib/api';

interface Run {
  id: string;
  kind: string;
  status: string;
  model: string | null;
  runner: string;
  triggeredBy: string | null;
  costCents: number;
  inputTokens: number;
  outputTokens: number;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  error: string | null;
}

interface RunsPayload {
  spend: { spentCents: number; capCents: number; display: string; paused: boolean };
  runs: Run[];
}

export function AgentsView({ slug }: { slug: string }) {
  const [data, setData] = useState<RunsPayload | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [openRun, setOpenRun] = useState<string | null>(null);
  const [lines, setLines] = useState<string[]>([]);
  const abort = useRef<AbortController | null>(null);

  const load = useCallback(() => {
    setLoadError(null);
    get<RunsPayload>(`/projects/${slug}/runs`)
      .then(setData)
      .catch((err: unknown) =>
        setLoadError(err instanceof Error ? err.message : 'Failed to load agent runs'),
      );
  }, [slug]);

  useEffect(load, [load]);

  const toggle = useCallback(
    async (runId: string) => {
      abort.current?.abort();
      if (openRun === runId) {
        setOpenRun(null);
        return;
      }
      setOpenRun(runId);
      setLines([]);

      const controller = new AbortController();
      abort.current = controller;

      // Replays what already happened, then follows — a viewer that opens
      // mid-run still sees the whole story.
      await streamRun(
        slug,
        runId,
        (line) => {
          if (line.type === 'end') {
            setLines((prev) => [...prev, `— run ${line.status} —`]);
            load();
            return;
          }
          if (line.message) setLines((prev) => [...prev, line.message!]);
        },
        controller.signal,
      ).catch(() => undefined);
    },
    [openRun, slug, load],
  );

  useEffect(() => () => abort.current?.abort(), []);

  if (loadError) {
    return (
      <div className="err">
        {loadError}{' '}
        <button type="button" className="btn sm" onClick={load}>
          Retry
        </button>
      </div>
    );
  }

  if (!data) {
    return (
      <div aria-hidden>
        <div className="card" style={{ maxWidth: '26rem', marginBottom: '1.2rem' }}>
          <span className="skeleton" style={{ height: '1.3rem', width: '40%', marginBottom: '0.6rem' }} />
          <span className="skeleton" style={{ height: '0.5rem' }} />
        </div>
        {[0, 1, 2].map((i) => (
          <div key={i} className="card" style={{ marginBottom: '0.5rem', padding: '0.65rem 0.9rem' }}>
            <span className="skeleton" style={{ height: '0.95rem' }} />
          </div>
        ))}
      </div>
    );
  }

  const pct = data.spend.capCents ? Math.min(100, (data.spend.spentCents / data.spend.capCents) * 100) : 0;

  return (
    <div>
      <div className="spend card">
        <div className="head">
          <span className="amt">€{(data.spend.spentCents / 100).toFixed(2)}</span>
          <span className="cap">of {data.spend.display.split(' of ')[1]} · this month</span>
        </div>
        <div className={`meter ${pct > 80 ? 'warn' : ''}`}>
          <i style={{ width: `${pct}%` }} />
        </div>
        <p className="note">
          Caps are enforced before each run. {data.spend.paused && <b>Agents are paused.</b>}
        </p>
      </div>

      {data.runs.length === 0 && <div className="empty">No agent runs yet.</div>}

      {data.runs.map((run) => (
        <div key={run.id} className="run card">
          <button type="button" className="runhead" onClick={() => toggle(run.id)}>
            <span className={`st ${run.status}`} />
            <span className="kind">{run.kind}</span>
            <span className={`pill ${run.status === 'succeeded' ? 'on' : run.status === 'failed' ? 'bad' : ''}`}>
              {run.status}
            </span>
            <span className="flex" />
            <span className="meta">
              {run.runner === 'self_hosted' ? 'self-hosted' : 'hosted'}
              {run.model ? ` · ${run.model}` : ''}
              {run.durationMs != null ? ` · ${(run.durationMs / 1000).toFixed(1)}s` : ''}
              {' · €'}
              {(run.costCents / 100).toFixed(2)}
            </span>
          </button>

          {openRun === run.id && (
            <pre className="log">
              {lines.length === 0 ? 'connecting…' : lines.join('\n')}
              {run.error ? `\n\nerror: ${run.error}` : ''}
            </pre>
          )}
        </div>
      ))}

      <style jsx>{`
        .spend {
          max-width: 26rem;
          margin-bottom: 1.2rem;
        }
        .head {
          display: flex;
          justify-content: space-between;
          align-items: baseline;
          margin-bottom: 0.5rem;
        }
        .amt {
          font: 600 1.3rem/1 var(--serif);
        }
        .cap {
          font: 500 0.862rem/1 var(--mono);
          color: var(--ink-3);
        }
        .note {
          font-size: 0.902rem;
          color: var(--ink-3);
          margin: 0.6rem 0 0;
        }
        .note b {
          color: var(--warn);
        }
        .run {
          padding: 0;
          overflow: hidden;
          margin-bottom: 0.5rem;
        }
        .runhead {
          display: flex;
          align-items: center;
          gap: 0.6rem;
          width: 100%;
          background: none;
          border: none;
          color: inherit;
          padding: 0.65rem 0.9rem;
          cursor: pointer;
          text-align: left;
        }
        .runhead:hover {
          background: var(--panel-2);
        }
        .st {
          width: 7px;
          height: 7px;
          border-radius: 50%;
          background: var(--ink-3);
          flex: none;
        }
        .st.succeeded {
          /* Solid ink dot. succeeded and running were already the same
             colour, distinguished only by the pulse animation below — losing
             the point-color fill loses nothing here. */
          background: var(--ink);
        }
        .st.failed {
          background: var(--danger);
        }
        .st.running {
          background: var(--ink);
          animation: pulse 1.2s ease-in-out infinite;
        }
        @keyframes pulse {
          50% {
            opacity: 0.25;
          }
        }
        .kind {
          font: 600 0.943rem/1 var(--mono);
        }
        .flex {
          flex: 1;
        }
        .meta {
          font: 500 0.868rem/1 var(--mono);
          color: var(--ink-3);
        }
        .log {
          margin: 0;
          padding: 0.8rem 0.9rem;
          border-top: 1px solid var(--line);
          background: var(--bg);
          font: 500 0.882rem/1.75 var(--mono);
          color: var(--ink-2);
          white-space: pre-wrap;
          max-height: 22rem;
          overflow-y: auto;
        }
      `}</style>
    </div>
  );
}
