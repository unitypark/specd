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
  freshness: { ageDays: number | null; stale: boolean; unknown: boolean; reason?: string };
}

interface DocLinks {
  outbound: { kind: string; rawTarget: string; site: string | null; state: string; targetPath: string | null }[];
  backlinks: { kind: string; site: string | null; sourcePath: string; sourceDocId: string }[];
  coupledTo: { codePath: string; commitsTogether: number; commitsSince: number }[];
}

interface Health {
  score: number;
  docCount: number;
  staleCount: number;
  stubCount: number;
  brokenLinks: number;
  danglingAnchors: number;
  orphanDocs: number;
  unknownFreshnessCount: number;
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
  const [openDoc, setOpenDoc] = useState<string | null>(null);
  const [links, setLinks] = useState<Record<string, DocLinks>>({});

  async function toggleDoc(id: string) {
    if (openDoc === id) {
      setOpenDoc(null);
      return;
    }
    setOpenDoc(id);
    if (links[id]) return;
    try {
      const res = await get<DocLinks>(`/projects/${slug}/knowledge/${id}`);
      setLinks((prev) => ({
        ...prev,
        [id]: { outbound: res.outbound, backlinks: res.backlinks, coupledTo: res.coupledTo ?? [] },
      }));
    } catch {
      // A doc whose links will not load still lists; the row just does not expand.
    }
  }

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
          <div key={doc.id}>
            <button type="button" className="row" onClick={() => void toggleDoc(doc.id)}>
              <span className="ic">{ICONS[doc.kind] ?? '📄'}</span>
              <span className="path">{doc.path.replace(/^knowledge\//, '')}</span>
              <span className="flex" />
              {doc.isStub && <span className="pill">stub</span>}
              {doc.hasUnverified && <span className="pill unverified">UNVERIFIED</span>}
              {doc.kind === 'spec' && <span className="pill on">as-built</span>}
              {/* Three states, because "we cannot tell" is not "fresh". */}
              <span
                className={`pill ${doc.freshness.stale ? 'warn' : ''}`}
                title={doc.freshness.reason ?? ''}
              >
                {doc.freshness.stale
                  ? `⚠ ${doc.freshness.reason ?? 'stale'}`
                  : doc.freshness.unknown
                    ? '· age unknown'
                    : 'fresh'}
              </span>
            </button>

            {openDoc === doc.id && (
              <div className="links">
                {(links[doc.id]?.outbound.length ?? 0) === 0 &&
                  (links[doc.id]?.backlinks.length ?? 0) === 0 && (
                    <p className="muted">No links either way — nothing reaches this doc by following anything.</p>
                  )}
                {links[doc.id]?.outbound.map((l, i) => (
                  <p key={`o${i}`} className={l.state === 'resolved' ? 'muted' : 'bad'}>
                    → <b>{l.kind}</b> {l.targetPath?.replace(/^knowledge\//, '') ?? l.rawTarget}
                    {l.state !== 'resolved' && ` — ${l.state.replace('_', ' ')}`}
                  </p>
                ))}
                {links[doc.id]?.backlinks.map((l, i) => (
                  <p key={`b${i}`} className="muted">
                    ← <b>{l.kind}</b> from {l.sourcePath.replace(/^knowledge\//, '')}
                    {l.site && `#${l.site}`}
                  </p>
                ))}
                {/* What history says this doc moves with — the code to read
                    beside it when it looks stale (0013). */}
                {links[doc.id]?.coupledTo.map((c, i) => (
                  <p key={`c${i}`} className={c.commitsSince >= 10 ? 'bad' : 'muted'}>
                    ⇄ <b>{c.codePath}</b> — changed together {c.commitsTogether}×
                    {c.commitsSince > 0 && `, ${c.commitsSince} commits since`}
                  </p>
                ))}
              </div>
            )}
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
            <div className="counts">
              <span className={health?.brokenLinks ? 'bad' : ''}>{health?.brokenLinks ?? 0} broken</span>
              <span className={health?.danglingAnchors ? 'bad' : ''}>
                {health?.danglingAnchors ?? 0} dangling
              </span>
              <span className={health?.orphanDocs ? 'bad' : ''}>{health?.orphanDocs ?? 0} orphaned</span>
              {(health?.unknownFreshnessCount ?? 0) > 0 && (
                <span>{health?.unknownFreshnessCount} unmeasured</span>
              )}
            </div>
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
        .row {
          width: 100%;
          background: none;
          text-align: left;
          cursor: pointer;
          font: inherit;
          color: inherit;
        }
        .row:hover {
          background: var(--panel-2);
        }
        .links {
          padding: 0.35rem 0.9rem 0.6rem 2rem;
          border-bottom: 1px solid var(--line);
          font-family: var(--mono);
          font-size: 0.862rem;
        }
        .links p {
          margin: 0.2rem 0;
        }
        .muted {
          color: var(--ink-3);
        }
        .bad {
          color: var(--danger);
        }
        .counts {
          display: flex;
          flex-wrap: wrap;
          gap: 0.75rem;
          font-family: var(--mono);
          font-size: 0.862rem;
          color: var(--ink-3);
          margin-top: 0.6rem;
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
