'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { get } from '@/lib/api';
import { AppShell } from '@/components/AppShell';

interface ProjectSummary {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  repoCount: number;
  vcsProvider: string | null;
  trackerKind: string;
  specsInReview: number;
  specsBuilding: number;
  spendCents: number;
  spendCapCents: number;
  knowledgeHealth: number;
}

export default function DashboardPage() {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    get<ProjectSummary[]>('/projects')
      .then(setProjects)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Failed to load'));
  }, []);

  return (
    <AppShell
      crumb={<b>Projects</b>}
      actions={
        <Link href="/setup" className="btn sm">
          + New project
        </Link>
      }
    >
      {error && <div className="err">{error}</div>}
      {!projects && !error && <div className="empty">Loading…</div>}

      {projects && projects.length === 0 && (
        <div className="firstrun card">
          <h2>Nothing here yet.</h2>
          <p>
            A project owns your repositories, connections, board and knowledge index. Setting one
            up takes about twenty minutes and ends with a setup PR you can actually read.
          </p>
          <Link href="/setup" className="btn primary">
            Start your setup
          </Link>
        </div>
      )}

      {projects && projects.length > 0 && (
        <div className="grid">
          {projects.map((p) => {
            const spendPct = p.spendCapCents
              ? Math.min(100, (p.spendCents / p.spendCapCents) * 100)
              : 0;
            const stale = p.knowledgeHealth > 0 && p.knowledgeHealth < 70;
            return (
              <Link key={p.id} href={`/p/${p.slug}`} className="pj">
                <h4>{p.name}</h4>
                <p className="meta">
                  {p.repoCount} repo{p.repoCount === 1 ? '' : 's'} ·{' '}
                  {p.trackerKind === 'jira' ? 'Jira' : 'built-in board'}
                  {p.vcsProvider ? ` · ${p.vcsProvider}` : ''}
                </p>

                <div className="row">
                  <span>Specs in review</span>
                  <b>{p.specsInReview}</b>
                </div>
                <div className="row">
                  <span>Building</span>
                  <b>{p.specsBuilding}</b>
                </div>
                <div className="row">
                  <span>Agent spend</span>
                  <b>
                    €{(p.spendCents / 100).toFixed(2)} / €{(p.spendCapCents / 100).toFixed(0)}
                  </b>
                </div>
                <div className={`meter ${spendPct > 80 ? 'warn' : ''}`}>
                  <i style={{ width: `${spendPct}%` }} />
                </div>

                <div className="row top">
                  <span>
                    Knowledge health {stale && <span className="pill warn">⚠ stale</span>}
                  </span>
                  <b>{p.knowledgeHealth}%</b>
                </div>
                <div className={`meter ${stale ? 'warn' : ''}`}>
                  <i style={{ width: `${p.knowledgeHealth}%` }} />
                </div>
              </Link>
            );
          })}
          <Link href="/setup" className="pj new">
            <span>＋ New project</span>
          </Link>
        </div>
      )}

      <style jsx>{`
        .grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(17rem, 1fr));
          gap: 1rem;
        }
        .pj {
          display: block;
          background: var(--panel);
          border: 1px solid var(--line);
          border-radius: var(--radius);
          padding: 1rem 1.1rem 1.1rem;
          color: inherit;
        }
        .pj:hover {
          border-color: var(--accent);
          text-decoration: none;
        }
        .pj h4 {
          font: 600 1rem/1.2 var(--serif);
          margin: 0 0 0.25rem;
        }
        .meta {
          font: 500 0.68rem/1.5 var(--mono);
          color: var(--ink-3);
          margin: 0 0 0.9rem;
        }
        .row {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 0.5rem;
          font-size: 0.78rem;
          color: var(--ink-2);
          margin-bottom: 0.35rem;
        }
        .row.top {
          margin-top: 0.9rem;
        }
        .row b {
          color: var(--ink);
          font-variant-numeric: tabular-nums;
        }
        .new {
          display: flex;
          align-items: center;
          justify-content: center;
          border-style: dashed;
          color: var(--ink-3);
          font-size: 0.85rem;
          min-height: 12rem;
        }
        .firstrun {
          max-width: 34rem;
          text-align: left;
        }
        .firstrun h2 {
          font: 600 1.25rem/1.2 var(--serif);
          margin: 0 0 0.5rem;
        }
        .firstrun p {
          color: var(--ink-2);
          font-size: 0.86rem;
          line-height: 1.7;
          margin: 0 0 1.2rem;
        }
      `}</style>
    </AppShell>
  );
}
