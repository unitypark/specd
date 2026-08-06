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
  const [openRun, setOpenRun] = useState<string | null>(null);
  const [lines, setLines] = useState<string[]>([]);
  const abort = useRef<AbortController | null>(null);

  const load = useCallback(() => {
    get<RunsPayload>(`/projects/${slug}/runs`).then(setData).catch(() => undefined);
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

  if (!data) return <div className="empty">Loading…</div>;

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
          font: 500 0.7rem/1 var(--mono);
          color: var(--ink-3);
        }
        .note {
          font-size: 0.74rem;
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
          background: var(--accent);
        }
        .st.failed {
          background: var(--danger);
        }
        .st.running {
          background: var(--accent);
          animation: pulse 1.2s ease-in-out infinite;
        }
        @keyframes pulse {
          50% {
            opacity: 0.25;
          }
        }
        .kind {
          font: 600 0.78rem/1 var(--mono);
        }
        .flex {
          flex: 1;
        }
        .meta {
          font: 500 0.68rem/1 var(--mono);
          color: var(--ink-3);
        }
        .log {
          margin: 0;
          padding: 0.8rem 0.9rem;
          border-top: 1px solid var(--line);
          background: var(--bg);
          font: 500 0.72rem/1.75 var(--mono);
          color: var(--ink-2);
          white-space: pre-wrap;
          max-height: 22rem;
          overflow-y: auto;
        }
      `}</style>
    </div>
  );
}
