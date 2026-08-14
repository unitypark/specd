'use client';

import { use, useCallback, useEffect, useRef, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { get } from '@/lib/api';
import { BoardView } from '@/components/BoardView';
import { KnowledgeView } from '@/components/KnowledgeView';
import { AgentsView } from '@/components/AgentsView';
import { ReposView } from '@/components/ReposView';
import { SettingsView } from '@/components/SettingsView';
import styles from './project.module.css';

import type { ProjectSummary } from '@/lib/types';

/**
 * Overview is not a tab of its own. Its four counters and its spend meter were
 * a screen you passed through on the way to the board — and two of the four
 * (awaiting review, building) are lane counts the board prints anyway. Folded
 * into a strip above the board, they are read where the work is instead of one
 * click away from it, and the project opens on the thing people came for.
 *
 * `?tab=overview` from an old link no longer matches, and an unmatched tab
 * already falls through to the default — which is now the board. No alias
 * needed; the link lands where its owner was going.
 */
const TABS = ['board', 'knowledge', 'agents', 'repositories', 'settings'] as const;
type Tab = (typeof TABS)[number];

export default function ProjectPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = use(params);
  const [tab, setTab] = useState<Tab>('board');
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

  // Deep links: `specd open <id>` lands on the board; `?tab=` lands anywhere
  // (the dashboard's card menu uses it to reach Settings directly).
  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.has('spec') || url.pathname.endsWith('/board')) setTab('board');
    const t = url.searchParams.get('tab');
    if (t && (TABS as readonly string[]).includes(t)) setTab(t as Tab);
  }, []);

  if (error) {
    return (
      <AppShell crumb="Project" wide>
        <div className="err">{error}</div>
      </AppShell>
    );
  }

  if (!project) {
    return (
      <AppShell crumb="Project" wide>
        {/* Shaped like what is about to arrive — the tab strip, then the
            summary row above the board — so the page settles rather than
            rearranges when it does. */}
        <div aria-hidden>
          <span className="skeleton" style={{ height: '1.4rem', width: '22rem', marginBottom: '1.3rem' }} />
          <span className="skeleton" style={{ height: '2.4rem', marginBottom: '0.85rem' }} />
        </div>
      </AppShell>
    );
  }

  const spendPct = project.spendCapCents
    ? Math.min(100, (project.spendCents / project.spendCapCents) * 100)
    : 0;

  return (
    <AppShell
      wide
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

      {tab === 'board' && (
        <div className={styles.boardtab}>
          <div className={styles.summary}>
            <div className={styles.stat}>
              <span className={styles.v}>{project.specsInReview}</span>
              <span className={styles.l}>awaiting review</span>
            </div>
            <div className={styles.stat}>
              <span className={styles.v}>{project.specsBuilding}</span>
              <span className={styles.l}>building</span>
            </div>
            <div className={styles.stat}>
              <span className={styles.v}>{project.repoCount}</span>
              <span className={styles.l}>repositories</span>
            </div>
            <div className={styles.stat}>
              <span className={styles.v}>{project.knowledgeHealth}%</span>
              <span className={styles.l}>knowledge health</span>
            </div>

            {/* The sentence this strip has no room for, kept where it is still
                reachable — a cap that silently refuses a run needs to say so
                somewhere. */}
            <div
              className={styles.spend}
              title="Caps are enforced before each run — a run that would start over budget never starts."
            >
              <span className={styles.amt}>€{(project.spendCents / 100).toFixed(2)}</span>
              <span className={styles.cap}>
                of €{(project.spendCapCents / 100).toFixed(2)} · this month
              </span>
              <div className={`meter ${spendPct > 80 ? 'warn' : ''} ${styles.spendmeter}`}>
                <i style={{ width: `${spendPct}%` }} />
              </div>
            </div>
          </div>

          <BoardView slug={slug} onChange={reload} />
        </div>
      )}
      {tab === 'knowledge' && <KnowledgeView slug={slug} />}
      {tab === 'agents' && <AgentsView slug={slug} />}
      {tab === 'repositories' && <ReposView slug={slug} projectId={project.id} onChange={reload} />}
      {tab === 'settings' && <SettingsView slug={slug} project={project} onChange={reload} />}
    </AppShell>
  );
}
