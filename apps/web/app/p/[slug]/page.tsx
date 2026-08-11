'use client';

import { use, useCallback, useEffect, useRef, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { get, post } from '@/lib/api';
import { BoardView } from '@/components/BoardView';
import { KnowledgeView } from '@/components/KnowledgeView';
import { AgentsView } from '@/components/AgentsView';
import { ReposView } from '@/components/ReposView';
import { SettingsView } from '@/components/SettingsView';
import styles from './project.module.css';

import type { ProjectSummary } from '@/lib/types';

const TABS = ['overview', 'board', 'knowledge', 'agents', 'repositories', 'settings'] as const;
type Tab = (typeof TABS)[number];

export default function ProjectPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = use(params);
  const [tab, setTab] = useState<Tab>('overview');
  const [project, setProject] = useState<ProjectSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadedOnce = useRef(false);
  const reload = useCallback(() => {
    get<ProjectSummary>(`/projects/${slug}`)
      .then((p) => {
        loadedOnce.current = true;
        setProject(p);
      })
      .catch((err: unknown) => {
        // Only the first load may take the page over with an error — a failed
        // background refresh after a child's onChange must not replace a
        // perfectly good page with a full-screen failure. The stale data
        // stands; the next successful refresh corrects it.
        if (!loadedOnce.current) {
          setError(err instanceof Error ? err.message : 'Failed to load');
        }
      });
  }, [slug]);

  useEffect(reload, [reload]);

  // Deep link from `specd open <id>`.
  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.has('spec') || url.pathname.endsWith('/board')) setTab('board');
  }, []);

  if (error) {
    return (
      <AppShell crumb="Project">
        <div className="err">{error}</div>
      </AppShell>
    );
  }

  if (!project) {
    return (
      <AppShell crumb="Project">
        <div aria-hidden style={{ maxWidth: '52rem' }}>
          <span className="skeleton" style={{ height: '1.4rem', width: '30%', marginBottom: '1rem' }} />
          <span className="skeleton" style={{ height: '2.4rem', width: '60%', marginBottom: '1.2rem' }} />
          <div style={{ display: 'flex', gap: '0.8rem' }}>
            {[0, 1, 2, 3].map((i) => (
              <span key={i} className="skeleton" style={{ height: '4rem', flex: 1 }} />
            ))}
          </div>
        </div>
      </AppShell>
    );
  }

  const spendPct = project.spendCapCents
    ? Math.min(100, (project.spendCents / project.spendCapCents) * 100)
    : 0;

  return (
    <AppShell
      crumb={
        <>
          <a href="/projects">Projects</a> / <b>{project.name}</b>
        </>
      }
      pills={
        <>
          {project.vcsProvider && <span className="pill on">{project.vcsProvider} ✓</span>}
          <span className="pill">{project.trackerKind === 'jira' ? 'Jira' : 'board'}</span>
        </>
      }
    >
      <nav className={styles.tabs}>
        {TABS.map((t) => (
          <button
            key={t}
            type="button"
            className={`${styles.tab} ${tab === t ? styles.on : ''}`}
            onClick={() => setTab(t)}
          >
            {t[0]!.toUpperCase() + t.slice(1)}
          </button>
        ))}
      </nav>

      {tab === 'overview' && (
        <>
          <div className={styles.kpis}>
            <div className={styles.kpi}>
              <div className={styles.v}>{project.specsInReview}</div>
              <div className={styles.l}>awaiting review</div>
            </div>
            <div className={styles.kpi}>
              <div className={styles.v}>{project.specsBuilding}</div>
              <div className={styles.l}>building</div>
            </div>
            <div className={styles.kpi}>
              <div className={styles.v}>{project.repoCount}</div>
              <div className={styles.l}>repositories</div>
            </div>
            <div className={styles.kpi}>
              <div className={styles.v}>{project.knowledgeHealth}%</div>
              <div className={styles.l}>knowledge health</div>
            </div>
          </div>

          <div className={styles.spend}>
            <div className={styles.spendhead}>
              <span className={styles.amt}>€{(project.spendCents / 100).toFixed(2)}</span>
              <span className={styles.cap}>
                of €{(project.spendCapCents / 100).toFixed(2)} cap · this month
              </span>
            </div>
            <div className={`meter ${spendPct > 80 ? 'warn' : ''}`}>
              <i style={{ width: `${spendPct}%` }} />
            </div>
            <p className={styles.spendnote}>
              Caps are enforced before each run — a run that would start over budget never starts.
            </p>
          </div>
        </>
      )}

      {tab === 'board' && <BoardView slug={slug} onChange={reload} />}
      {tab === 'knowledge' && <KnowledgeView slug={slug} />}
      {tab === 'agents' && <AgentsView slug={slug} />}
      {tab === 'repositories' && <ReposView slug={slug} projectId={project.id} onChange={reload} />}
      {tab === 'settings' && <SettingsView slug={slug} project={project} onChange={reload} />}
    </AppShell>
  );
}
