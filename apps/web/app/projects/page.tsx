'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { get } from '@/lib/api';
import { AppShell } from '@/components/AppShell';
import styles from './projects.module.css';

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
    // No action in the shell: "New project" lives on the group it creates into,
    // not in the chrome. One button, where the thing it makes will appear.
    <AppShell crumb={<b>Projects</b>}>
      {error && <div className="err">{error}</div>}
      {!projects && !error && <div className="empty">Loading…</div>}

      {projects && projects.length === 0 && (
        <div className={`${styles.firstrun} card`}>
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
        <div className={styles.group}>
          <div className={styles.grouphead}>
            <h2>Your projects</h2>
            <span className={styles.count}>{projects.length}</span>
            <span className={styles.flex} />
            <Link href="/setup" className="btn primary">
              + New project
            </Link>
          </div>

          <div className={styles.grid}>
            {projects.map((p) => {
              const spendPct = p.spendCapCents
                ? Math.min(100, (p.spendCents / p.spendCapCents) * 100)
                : 0;
              const stale = p.knowledgeHealth > 0 && p.knowledgeHealth < 70;
              return (
                <Link key={p.id} href={`/p/${p.slug}`} className={styles.pj}>
                  <h4>{p.name}</h4>
                  <p className={styles.meta}>
                    {p.repoCount} repo{p.repoCount === 1 ? '' : 's'} ·{' '}
                    {p.trackerKind === 'jira' ? 'Jira' : 'built-in board'}
                    {p.vcsProvider ? ` · ${p.vcsProvider}` : ''}
                  </p>

                  <div className={styles.row}>
                    <span>Specs in review</span>
                    <b>{p.specsInReview}</b>
                  </div>
                  <div className={styles.row}>
                    <span>Building</span>
                    <b>{p.specsBuilding}</b>
                  </div>
                  <div className={styles.row}>
                    <span>Agent spend</span>
                    <b>
                      €{(p.spendCents / 100).toFixed(2)} / €{(p.spendCapCents / 100).toFixed(0)}
                    </b>
                  </div>
                  <div className={`meter ${spendPct > 80 ? 'warn' : ''}`}>
                    <i style={{ width: `${spendPct}%` }} />
                  </div>

                  <div className={`${styles.row} ${styles.top}`}>
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
          </div>
        </div>
      )}
    </AppShell>
  );
}
