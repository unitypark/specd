'use client';

import { useCallback, useEffect, useState } from 'react';
import { get, post, streamRun } from '@/lib/api';

interface Doc {
  id: string;
  path: string;
  kind: string;
  title: string | null;
  hasUnverified: boolean;
  isStub: boolean;
  freshness: { ageDays: number; stale: boolean; reason?: string };
}

interface Health {
  score: number;
  docCount: number;
  staleCount: number;
  stubCount: number;
  asBuiltCount: number;
  notes: { icon: string; text: string }[];
}

const ICONS: Record<string, string> = {
  doc: '📖',
  adr: '⚖️',
  runbook: '🧰',
  spec: '📗',
};

export function KnowledgeView({ slug }: { slug: string }) {
  const [docs, setDocs] = useState<Doc[]>([]);
  const [health, setHealth] = useState<Health | null>(null);
  const [grounding, setGrounding] = useState<{ avgCitations: number; avgUnverified: number; sample: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await get<{ docs: Doc[]; health: Health; grounding: typeof grounding }>(
      `/projects/${slug}/knowledge`,
    );
    setDocs(res.docs);
    setHealth(res.health);
    setGrounding(res.grounding);
  }, [slug]);

  useEffect(() => {
    load().catch((err: unknown) => setError(err instanceof Error ? err.message : 'Failed'));
  }, [load]);

  async function reindex() {
    setBusy(true);
    setError(null);
    setProgress(null);
    try {
      // The re-index is queued, not done, when this returns (0012) — so follow
      // the run's log to the end instead of reporting success before the work
      // has started.
      const { runId } = await post<{ runId: string }>(`/projects/${slug}/reindex`, {});
      await streamRun(slug, runId, (line) => {
        if (line.message) setProgress(line.message);
        if (line.type === 'end' && line.status && line.status !== 'succeeded') {
          setError(`Re-index ${line.status}`);
        }
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Re-index failed');
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  return (
    <div className="grid">
      {error && <div className="err">{error}</div>}

      <div className="left card">
        <div className="head">
          <span>
            knowledge/ — {docs.length} doc{docs.length === 1 ? '' : 's'}
          </span>
          <button type="button" className="btn sm" onClick={reindex} disabled={busy}>
            {busy ? <span className="spinner" /> : '↻ Re-index'}
          </button>
        </div>

        {progress && <div className="progress">{progress}</div>}

        {docs.length === 0 && (
          <div className="empty">
            Nothing indexed yet. Merge the setup branch, then re-index — git is the source of truth,
            so specd only sees what you have adopted.
          </div>
        )}

        {docs.map((doc) => (
          <div key={doc.id} className="row">
            <span className="ic">{ICONS[doc.kind] ?? '📄'}</span>
            <span className="path">{doc.path.replace(/^knowledge\//, '')}</span>
            <span className="flex" />
            {doc.isStub && <span className="pill">stub</span>}
            {doc.hasUnverified && <span className="pill unverified">UNVERIFIED</span>}
            {doc.kind === 'spec' && <span className="pill on">as-built</span>}
            <span className={`pill ${doc.freshness.stale ? 'warn' : ''}`}>
              {doc.freshness.stale ? `⚠ ${doc.freshness.ageDays}d` : 'fresh'}
            </span>
          </div>
        ))}
      </div>

      <div className="right">
        <div className="card">
          <div className="head">
            <span>Health</span>
          </div>
          <div className="pad">
            <span className="score">{Math.round(health?.score ?? 0)}%</span>
            <div className={`meter ${(health?.score ?? 0) < 70 ? 'warn' : ''}`}>
              <i style={{ width: `${health?.score ?? 0}%` }} />
            </div>
            {(health?.notes ?? []).map((n, i) => (
              <p key={i} className="note">
                <span>{n.icon}</span> {n.text}
              </p>
            ))}
            {health && health.notes.length === 0 && (
              <p className="note">
                <span>✓</span> Nothing rotting. Keep docs riding the change that describes them.
              </p>
            )}
          </div>
        </div>

        <div className="card">
          <div className="head">
            <span>Grounding quality · last {grounding?.sample ?? 0} specs</span>
          </div>
          <div className="pad small">
            Avg <b>{(grounding?.avgCitations ?? 0).toFixed(1)} citations</b> per spec ·{' '}
            <b>{(grounding?.avgUnverified ?? 0).toFixed(1)} UNVERIFIED</b> claims.
            <p>
              An UNVERIFIED marker is not a defect — it is the agent telling you exactly what to
              check. Watch the ratio, not the count.
            </p>
          </div>
        </div>
      </div>

      <style jsx>{`
        .grid {
          display: grid;
          grid-template-columns: 1.4fr 1fr;
          gap: 1rem;
          align-items: start;
        }
        @media (max-width: 900px) {
          .grid {
            grid-template-columns: 1fr;
          }
        }
        .card {
          padding: 0;
          overflow: hidden;
          margin-bottom: 1rem;
        }
        .head {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 0.6rem 0.9rem;
          border-bottom: 1px solid var(--line);
          font: 600 0.862rem/1 var(--mono);
          letter-spacing: 0.06em;
          color: var(--ink-3);
          background: var(--panel-2);
        }
        .row {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          padding: 0.5rem 0.9rem;
          border-bottom: 1px solid var(--line);
          font-size: 0.963rem;
        }
        .row:last-child {
          border-bottom: none;
        }
        .flex {
          flex: 1;
        }
        .path {
          font-family: var(--mono);
          font-size: 0.922rem;
          color: var(--ink);
        }
        .pad {
          padding: 0.9rem;
        }
        .small {
          font-size: 0.953rem;
          color: var(--ink-2);
          line-height: 1.7;
        }
        .small p {
          color: var(--ink-3);
          font-size: 0.912rem;
          margin: 0.6rem 0 0;
        }
        .score {
          font: 600 1.8rem/1 var(--serif);
          display: block;
          margin-bottom: 0.5rem;
        }
        .progress {
          padding: 0.5rem 0.9rem;
          border-bottom: 1px solid var(--line);
          font-family: var(--mono);
          font-size: 0.872rem;
          color: var(--ink-3);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .note {
          display: flex;
          gap: 0.5rem;
          font-size: 0.932rem;
          line-height: 1.6;
          color: var(--ink-2);
          margin: 0.7rem 0 0;
        }
      `}</style>
    </div>
  );
}
