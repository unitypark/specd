'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { del, get } from '@/lib/api';
import { AppShell } from '@/components/AppShell';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import type { ProjectSummary } from '@/lib/types';
import styles from './projects.module.css';

export default function DashboardPage() {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState<ProjectSummary | null>(null);
  const [discardBusy, setDiscardBusy] = useState(false);
  const [discardError, setDiscardError] = useState<string | null>(null);

  const load = useCallback(() => {
    get<ProjectSummary[]>('/projects')
      .then(setProjects)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Failed to load'));
  }, []);

  useEffect(load, [load]);

  async function discard(p: ProjectSummary) {
    setDiscardBusy(true);
    setDiscardError(null);
    try {
      await del(`/projects/${p.slug}`);
      setConfirmDiscard(null);
      load();
    } catch (err) {
      setDiscardError(err instanceof Error ? err.message : 'Failed to discard');
    } finally {
      setDiscardBusy(false);
    }
  }

  // A draft is a wizard that never finished — not a project yet. It gets a
  // resume/discard row, never a project card pretending to be real.
  const drafts = projects?.filter((p) => !p.setupComplete) ?? [];
  const live = projects?.filter((p) => p.setupComplete) ?? [];

  return (
    // No action in the shell: "New project" lives on the group it creates into,
    // not in the chrome. One button, where the thing it makes will appear.
    <AppShell crumb={<b>Projects</b>}>
      {error && <div className="err">{error}</div>}
      {!projects && !error && (
        <div aria-hidden>
          <span className="skeleton" style={{ height: '1.3rem', width: '22%', marginBottom: '1rem' }} />
          <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
            {[0, 1, 2].map((i) => (
              <span key={i} className="skeleton" style={{ height: '11rem', flex: '1 1 16rem' }} />
            ))}
          </div>
        </div>
      )}

      {projects && live.length === 0 && drafts.length === 0 && (
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

      {drafts.length > 0 && (
        <div className={styles.group}>
          <div className={styles.grouphead}>
            <h2>Setup in progress</h2>
            <span className={styles.count}>{drafts.length}</span>
          </div>
          <ul className={styles.drafts}>
            {drafts.map((p) => (
              <li key={p.id}>
                <div>
                  <b>{p.name}</b>
                  <span className={styles.draftmeta}>
                    {p.repoCount} repo{p.repoCount === 1 ? '' : 's'}
                    {p.vcsProvider ? ` · ${p.vcsProvider}` : ''} · setup never finished
                  </span>
                </div>
                <span className={styles.flex} />
                <Link href={`/setup?resume=${p.slug}`} className="btn sm primary">
                  Resume setup →
                </Link>
                <button
                  type="button"
                  className="btn sm"
                  onClick={() => {
                    setDiscardError(null);
                    setConfirmDiscard(p);
                  }}
                >
                  Discard
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {projects && live.length > 0 && (
        <div className={styles.group}>
          <div className={styles.grouphead}>
            <h2>Your projects</h2>
            <span className={styles.count}>{live.length}</span>
            <span className={styles.flex} />
            <Link href="/setup" className="btn primary">
              + New project
            </Link>
          </div>

          <div className={styles.grid}>
            {live.map((p) => {
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

      {projects && live.length === 0 && drafts.length > 0 && (
        <div className={styles.group}>
          <div className={styles.grouphead}>
            <span className={styles.flex} />
            <Link href="/setup" className="btn primary">
              + New project
            </Link>
          </div>
        </div>
      )}

      {confirmDiscard && (
        <ConfirmDialog
          title={`Discard "${confirmDiscard.name}"?`}
          body={
            <>
              Deletes the unfinished draft and anything attached so far — connections, repositories
              and any onboarding output on the specd side. Your repositories themselves are
              untouched.
            </>
          }
          confirmLabel="Discard draft"
          busy={discardBusy}
          error={discardError}
          onConfirm={() => discard(confirmDiscard)}
          onCancel={() => setConfirmDiscard(null)}
        />
      )}
    </AppShell>
  );
}
