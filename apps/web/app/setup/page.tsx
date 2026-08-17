'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { del, get, patch, post } from '@/lib/api';
import { deriveResumeStep, type ResumeConnection } from '@/lib/setup-resume';
import { AppShell } from '@/components/AppShell';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Pipeline } from '@/components/Pipeline';
import styles from './setup.module.css';

/**
 * The six-step wizard (§6). Every step produces a durable object; nothing here
 * is a dead-end form. It ends with a real artifact — a setup branch or PR you
 * can open and read.
 *
 * The wizard and the schematic are two views of the same fixed object graph
 * (D11). Neither is an editor.
 */

const STEPS = [
  'Create project',
  'Connect code',
  'Connect AI',
  'Tracker & board',
  'Knowledge init',
  'Done',
] as const;

interface Project {
  id: string;
  slug: string;
  name: string;
}
interface Repo {
  id: string;
  name: string;
  localPath: string | null;
  isPrimary: boolean;
  setupBranch: string | null;
  setupPrUrl: string | null;
}
interface GitlabRepo {
  id: string;
  fullName: string;
  defaultBranch: string;
  namespace: string;
}
interface GithubRepo {
  id: string;
  fullName: string;
  defaultBranch: string;
  language: string | null;
}
interface GithubStatus {
  configured: boolean;
  reason?: string;
  registerUrl?: string;
  installUrl?: string;
  appSlug?: string;
}
interface JiraProject {
  id: string;
  key: string;
  name: string;
}
interface OnboardResult {
  repoName: string;
  branch?: string;
  url?: string | null;
  reviewHint?: string;
  fileCount?: number;
  error?: string;
  runId: string;
  queued?: boolean;
}

export default function SetupPage() {
  return (
    // useSearchParams needs a Suspense boundary for prerendering.
    <Suspense fallback={null}>
      <SetupWizard />
    </Suspense>
  );
}

function SetupWizard() {
  const router = useRouter();
  const search = useSearchParams();
  const resumeSlug = search.get('resume');
  // 0 renders no step while a draft loads; a fresh wizard starts at 1.
  const [step, setStep] = useState(resumeSlug ? 0 : 1);
  const [maxStep, setMaxStep] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [discardBusy, setDiscardBusy] = useState(false);

  /** Forward moves record how far the wizard has reached — the rail lets you revisit anything up to there. */
  function goTo(n: number) {
    setStep(n);
    setMaxStep((m) => Math.max(m, n));
  }

  // step 1
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [project, setProject] = useState<Project | null>(null);

  // step 2
  const [vcs, setVcs] = useState<'github' | 'gitlab' | 'local' | null>(null);
  const [repoPath, setRepoPath] = useState('');
  const [repoName, setRepoName] = useState('');
  const [pathCheck, setPathCheck] = useState<{ ok: boolean; clean?: boolean; branch?: string; reason?: string } | null>(null);
  const [repos, setRepos] = useState<Repo[]>([]);

  // step 2 · local mode's optional review credential
  const [reviewProvider, setReviewProvider] = useState<'' | 'github' | 'gitlab'>('');
  const [reviewInstanceUrl, setReviewInstanceUrl] = useState('');
  const [reviewToken, setReviewToken] = useState('');
  const [reviewCheck, setReviewCheck] = useState<{ ok: boolean; detail: string } | null>(null);

  // step 2 · GitLab
  const [gitlabToken, setGitlabToken] = useState('');
  const [gitlabInstanceUrl, setGitlabInstanceUrl] = useState('');
  const [gitlabConnected, setGitlabConnected] = useState(false);
  const [gitlabError, setGitlabError] = useState<string | null>(null);
  const [gitlabSearch, setGitlabSearch] = useState('');
  const [gitlabResults, setGitlabResults] = useState<GitlabRepo[]>([]);
  const [gitlabSearching, setGitlabSearching] = useState(false);

  // step 2 · GitHub
  const [githubStatus, setGithubStatus] = useState<GithubStatus | null>(null);
  const [githubInstallationId, setGithubInstallationId] = useState('');
  const [githubConnected, setGithubConnected] = useState(false);
  const [githubError, setGithubError] = useState<string | null>(null);
  const [githubResults, setGithubResults] = useState<GithubRepo[]>([]);

  // step 3
  const [aiMode, setAiMode] = useState<'api_key' | 'subscription_runner' | 'managed_cloud' | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('claude-opus-5');
  const [capEuros, setCapEuros] = useState('100');
  const [keyCheck, setKeyCheck] = useState<{ ok: boolean; detail: string } | null>(null);
  const [aiModes, setAiModes] = useState<Record<string, { ok: boolean; detail: string }> | null>(null);

  // step 4
  const [tracker, setTracker] = useState<'board' | 'jira' | null>(null);

  // step 4 · Jira
  const [jiraSiteUrl, setJiraSiteUrl] = useState('');
  const [jiraEmail, setJiraEmail] = useState('');
  const [jiraToken, setJiraToken] = useState('');
  const [jiraProjectKey, setJiraProjectKey] = useState('');
  const [jiraProjects, setJiraProjects] = useState<JiraProject[]>([]);
  const [jiraConnectedAs, setJiraConnectedAs] = useState<string | null>(null);
  const [jiraError, setJiraError] = useState<string | null>(null);
  const [jiraImport, setJiraImport] = useState(true);
  const [jiraImported, setJiraImported] = useState<{ imported: number; updated: number } | null>(null);

  // step 5
  const [onboardResults, setOnboardResults] = useState<OnboardResult[] | null>(null);

  // Ask the server what this machine can actually do before offering it.
  // Subscription mode only works where specd runs beside Claude Code (D2).
  useEffect(() => {
    if (step !== 3 || aiModes) return;
    get<Record<string, { ok: boolean; detail: string }>>('/projects/ai-modes')
      .then(setAiModes)
      .catch(() => undefined);
  }, [step, aiModes]);

  // Is a GitHub App even registered for this deployment? That is a one-time,
  // operator-level setup distinct from connecting a project to it.
  useEffect(() => {
    if (vcs !== 'github' || githubStatus) return;
    get<GithubStatus>('/github/status')
      .then(setGithubStatus)
      .catch(() => undefined);
  }, [vcs, githubStatus]);

  function fail(err: unknown) {
    setError(err instanceof Error ? err.message : String(err));
  }

  // Resume a draft: connections are the durable trace of progress, so they
  // decide the step; everything else re-seeds the form state.
  useEffect(() => {
    if (!resumeSlug) return;
    let cancelled = false;
    (async () => {
      try {
        const [summary, conns, repoList] = await Promise.all([
          get<{ id: string; slug: string; name: string; description: string | null; spendCapCents: number }>(
            `/projects/${resumeSlug}`,
          ),
          get<ResumeConnection[]>(`/projects/${resumeSlug}/connections`),
          get<Repo[]>(`/projects/${resumeSlug}/repositories`),
        ]);
        if (cancelled) return;
        setProject({ id: summary.id, slug: summary.slug, name: summary.name });
        setName(summary.name);
        setDescription(summary.description ?? '');
        setCapEuros(String(Math.round(summary.spendCapCents / 100)));
        setRepos(repoList);
        const vcsConn = conns.find((c) => c.kind === 'vcs');
        if (vcsConn) {
          setVcs(vcsConn.provider as 'github' | 'gitlab' | 'local');
        } else if (repoList.some((r) => r.localPath)) {
          // Local mode adds repos before its connection exists.
          setVcs('local');
        }
        const resumed = deriveResumeStep(conns);
        setStep(resumed);
        setMaxStep(resumed);
      } catch (err) {
        if (!cancelled) {
          fail(err);
          setStep(1);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resumeSlug]);

  // Reaching Done is what completes setup — from that moment the dashboard
  // stops calling this a draft. One-way; the server keeps the first stamp.
  useEffect(() => {
    if (step !== 6 || !project) return;
    patch(`/projects/${project.slug}`, { setupComplete: true }).catch(() => undefined);
  }, [step, project]);

  async function createProject() {
    setBusy(true);
    setError(null);
    try {
      if (project) {
        // Coming back to step 1 edits the draft in place — it must not mint
        // a second project.
        await patch(`/projects/${project.slug}`, {
          name,
          description: description.trim() ? description : null,
          spendCapCents: Math.round(Number(capEuros || '100') * 100),
        });
        setProject({ ...project, name });
      } else {
        const created = await post<Project & { slug: string }>('/projects', {
          name,
          description: description || undefined,
          spendCapCents: Math.round(Number(capEuros || '100') * 100),
          draft: true,
        });
        setProject(created);
      }
      goTo(2);
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  async function discardProject() {
    if (!project) return;
    setDiscardBusy(true);
    setCancelError(null);
    try {
      await del(`/projects/${project.slug}`);
      router.push('/projects');
    } catch (err) {
      setCancelError(err instanceof Error ? err.message : 'Failed to discard');
      setDiscardBusy(false);
    }
  }

  async function checkPath() {
    if (!project || !repoPath) return;
    setBusy(true);
    try {
      const res = await get<{ ok: boolean; clean?: boolean; branch?: string; reason?: string }>(
        `/projects/${project.slug}/inspect-path?path=${encodeURIComponent(repoPath)}`,
      );
      setPathCheck(res);
      if (res.ok && !repoName) {
        setRepoName(repoPath.replace(/\/+$/, '').split('/').pop() ?? 'repo');
      }
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  async function addRepo() {
    if (!project) return;
    setBusy(true);
    setBusyAction('add-repo');
    setError(null);
    try {
      const repo = await post<Repo>(`/projects/${project.slug}/repositories`, {
        provider: 'local',
        name: repoName,
        localPath: repoPath,
        isPrimary: repos.length === 0,
      });
      setRepos([...repos, repo]);
      setRepoPath('');
      setRepoName('');
      setPathCheck(null);
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
      setBusyAction(null);
    }
  }

  /**
   * Connect GitLab, then immediately try to list repositories with the same
   * token — there is no separate "test connection" call, so this doubles as
   * live validation. A bad token surfaces here, on the form, rather than
   * leaving `gitlabConnected` true with a picker that silently never returns
   * anything (the wizard must not lie — §6 guardrail).
   */
  async function connectGitlab() {
    if (!project || !gitlabToken) return;
    setBusy(true);
    setGitlabError(null);
    try {
      await post(`/projects/${project.slug}/connections/vcs`, {
        provider: 'gitlab',
        token: gitlabToken,
        instanceUrl: gitlabInstanceUrl.trim() || undefined,
      });
      const res = await get<{ repositories: GitlabRepo[] }>(`/gitlab/projects/${project.id}/repositories`);
      setGitlabResults(res.repositories);
      setGitlabConnected(true);
    } catch (err) {
      setGitlabError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function searchGitlabRepos() {
    if (!project) return;
    setGitlabSearching(true);
    try {
      const qs = gitlabSearch ? `?search=${encodeURIComponent(gitlabSearch)}` : '';
      const res = await get<{ repositories: GitlabRepo[] }>(`/gitlab/projects/${project.id}/repositories${qs}`);
      setGitlabResults(res.repositories);
    } catch (err) {
      fail(err);
    } finally {
      setGitlabSearching(false);
    }
  }

  async function addGitlabRepo(r: GitlabRepo) {
    if (!project) return;
    setBusy(true);
    setError(null);
    try {
      const repo = await post<Repo>(`/projects/${project.slug}/repositories`, {
        provider: 'gitlab',
        name: r.fullName,
        externalId: r.id,
        defaultBranch: r.defaultBranch,
        isPrimary: repos.length === 0,
      });
      setRepos([...repos, repo]);
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  /**
   * Record the installation and list what it was granted, in one call — the
   * wizard's live validation for a pasted installation id, same role
   * `connectGitlab` plays for a pasted token.
   */
  async function connectGithub() {
    if (!project || !githubInstallationId.trim()) return;
    setBusy(true);
    setGithubError(null);
    try {
      const res = await post<{ repositories: GithubRepo[] }>(`/github/projects/${project.id}/installation`, {
        installationId: githubInstallationId.trim(),
      });
      setGithubResults(res.repositories);
      setGithubConnected(true);
    } catch (err) {
      setGithubError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function addGithubRepo(r: GithubRepo) {
    if (!project) return;
    setBusy(true);
    setError(null);
    try {
      const repo = await post<Repo>(`/projects/${project.slug}/repositories`, {
        provider: 'github',
        name: r.fullName,
        externalId: r.id,
        defaultBranch: r.defaultBranch,
        isPrimary: repos.length === 0,
      });
      setRepos([...repos, repo]);
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  async function connectVcsAndContinue() {
    if (!project || !vcs) return;
    // GitLab/GitHub already connected the moment the token/installation
    // validated — advancing here would just re-store the same connection
    // under a busy spinner for nothing.
    if (vcs === 'gitlab' || vcs === 'github') {
      goTo(3);
      return;
    }
    setBusy(true);
    setBusyAction('continue-2');
    setError(null);
    try {
      await post(`/projects/${project.slug}/connections/vcs`, localVcsBody());
      goTo(3);
    } catch (err) {
      // A rejected review token must not read as "local mode is broken" — it
      // is the one optional thing on this step.
      fail(err);
    } finally {
      setBusy(false);
      setBusyAction(null);
    }
  }

  /** Local mode's connection, with its optional review credential if given. */
  function localVcsBody() {
    return reviewProvider
      ? {
          provider: 'local',
          reviewProvider,
          token: reviewToken,
          instanceUrl: reviewInstanceUrl.trim() || undefined,
        }
      : { provider: 'local' };
  }

  /**
   * Prove the review token before Continue does, so a bad one is answered on
   * the field rather than as a failure to advance. Storing it here as well is
   * deliberate: this *is* the connect call, and repeating it on Continue is
   * idempotent.
   */
  async function checkReviewCredential() {
    if (!project || !reviewProvider || !reviewToken) return;
    setBusy(true);
    setBusyAction('check-review');
    setReviewCheck(null);
    try {
      const res = await post<{ ok: boolean; connectedAs?: string }>(
        `/projects/${project.slug}/connections/vcs`,
        localVcsBody(),
      );
      setReviewCheck({
        ok: true,
        detail: res.connectedAs
          ? `Token accepted — ${reviewProvider === 'gitlab' ? 'GitLab' : 'GitHub'} knows it as ${res.connectedAs}.`
          : 'Token accepted.',
      });
    } catch (err) {
      setReviewCheck({ ok: false, detail: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
      setBusyAction(null);
    }
  }

  async function connectAi() {
    if (!project || !aiMode) return;
    setBusy(true);
    setError(null);
    setKeyCheck(null);
    try {
      const res = await post<{ ok: boolean; detail: string }>(
        `/projects/${project.slug}/connections/ai`,
        { mode: aiMode, apiKey: apiKey || undefined, model },
      );
      setKeyCheck(res);
      if (res.ok) goTo(4);
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  /**
   * Connect Jira, then immediately list its projects with the same credential.
   *
   * Same shape as `connectGitlab`, and for the same reason: the server
   * validates the token against `/myself` before storing it, and listing
   * projects right afterwards proves the credential can actually see
   * something. A bad token surfaces here, on the form, rather than leaving
   * the wizard claiming a connection that fails later (§6 guardrail — the
   * wizard must not lie).
   */
  async function connectJira() {
    if (!project || !jiraSiteUrl || !jiraEmail || !jiraToken) return;
    setBusy(true);
    setJiraError(null);
    try {
      const res = await post<{ ok: boolean; connectedAs?: string }>(
        `/projects/${project.slug}/connections/tracker`,
        {
          provider: 'jira',
          siteUrl: jiraSiteUrl.trim(),
          email: jiraEmail.trim(),
          apiToken: jiraToken,
        },
      );
      const listed = await get<{ projects: JiraProject[] }>(
        `/projects/${project.slug}/tracker/jira/projects`,
      );
      setJiraProjects(listed.projects);
      setJiraConnectedAs(res.connectedAs ?? jiraEmail.trim());
    } catch (err) {
      setJiraError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function connectTracker() {
    if (!project || !tracker) return;
    setBusy(true);
    setBusyAction('continue-4');
    setError(null);
    try {
      if (tracker === 'jira') {
        // Persist the chosen project key alongside the credential already
        // validated by connectJira().
        await post(`/projects/${project.slug}/connections/tracker`, {
          provider: 'jira',
          siteUrl: jiraSiteUrl.trim(),
          email: jiraEmail.trim(),
          apiToken: jiraToken,
          projectKey: jiraProjectKey,
        });

        if (jiraImport) {
          const result = await post<{ imported: number; updated: number }>(
            `/projects/${project.slug}/tracker/jira/import`,
            {},
          );
          setJiraImported(result);
        }
      } else {
        await post(`/projects/${project.slug}/connections/tracker`, { provider: tracker });
      }
      goTo(5);
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
      setBusyAction(null);
    }
  }

  async function runOnboarding() {
    if (!project) return;
    setBusy(true);
    setError(null);
    try {
      const results = await post<OnboardResult[]>(`/projects/${project.slug}/onboard`, {
        repositoryIds: repos.map((r) => r.id),
      });
      setOnboardResults(results);
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  // Every repo comes back `queued` with no branch/PR yet: grounding is a run
  // the server executes, not something the request waits for (0016). Poll each
  // one until it finishes rather than leaving the wizard showing a result that
  // never arrives.
  useEffect(() => {
    if (!project || !onboardResults?.some((r) => r.queued)) return;
    const id = setInterval(async () => {
      const updated = await Promise.all(
        onboardResults.map(async (r) => {
          if (!r.queued) return r;
          try {
            const { run } = await get<{ run: { status: string; result: Record<string, unknown> | null; error: string | null } }>(
              `/projects/${project.slug}/runs/${r.runId}`,
            );
            if (run.status === 'succeeded' && run.result) {
              return {
                ...r,
                queued: false,
                branch: run.result.branch as string | undefined,
                url: run.result.url as string | null | undefined,
                fileCount: run.result.files as number | undefined,
                reviewHint: 'Opened for review.',
              };
            }
            if (run.status === 'failed') {
              return { ...r, queued: false, error: run.error ?? 'The runner reported a failure.' };
            }
          } catch {
            // Transient — the next tick tries again.
          }
          return r;
        }),
      );
      setOnboardResults(updated);
    }, 4000);
    return () => clearInterval(id);
  }, [project, onboardResults]);

  // Local is always ready; GitLab and GitHub are ready once their respective
  // credential (token, installation id) has validated.
  const canContinueFromCode =
    vcs === 'local' || (vcs === 'gitlab' && gitlabConnected) || (vcs === 'github' && githubConnected);

  return (
    <AppShell
      crumb={resumeSlug ? 'Resume project setup' : 'New project setup'}
      pills={step > 0 ? <span className="pill">step {step}/6</span> : undefined}
      actions={
        project ? (
          <button type="button" className="btn sm" onClick={() => setCancelOpen(true)}>
            Cancel
          </button>
        ) : (
          // Nothing exists yet — leaving needs no ceremony.
          <Link href="/projects" className="btn sm">
            Cancel
          </Link>
        )
      }
    >
      <div className={styles.grid}>
        <ol className={styles.steps}>
          {STEPS.map((label, i) => {
            const n = i + 1;
            // Any step the wizard has reached is revisitable; jumping ahead
            // of the line is not — forward is earned by each step's Continue.
            const navigable = n <= maxStep && n !== step;
            return (
              <li
                key={label}
                className={`${styles.step} ${n === step ? styles.on : ''} ${
                  n < step ? styles.done : ''
                }`}
              >
                {navigable ? (
                  <button type="button" className={styles.stepbtn} onClick={() => setStep(n)}>
                    <span className={styles.n}>{n < step ? '✓' : n}</span>
                    {label}
                  </button>
                ) : (
                  <>
                    <span className={styles.n}>{n < step ? '✓' : n}</span>
                    {label}
                  </>
                )}
              </li>
            );
          })}
        </ol>

        <div className={styles.panel}>
          {error && <div className="err">{error}</div>}

          {step === 0 && (
            <div className="empty">
              <span className="spinner" /> Loading your draft…
            </div>
          )}

          {/* ─── 1 · project ─────────────────────────────────────────────── */}
          {step === 1 && (
            <>
              <h3>Name your project</h3>
              <p className={styles.sub}>
                A project owns repositories, connections, the board and the knowledge index.
              </p>
              <div className="field">
                <label htmlFor="pname">Project name</label>
                <input
                  id="pname"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Aurora CRM"
                  autoFocus
                />
              </div>
              <div className="field">
                <label htmlFor="pdesc">Description (optional)</label>
                <input
                  id="pdesc"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Customer CRM — API, web app and infra"
                />
              </div>
              <div className="field">
                <label htmlFor="cap">Monthly spend cap (€)</label>
                <input id="cap" value={capEuros} onChange={(e) => setCapEuros(e.target.value)} />
                <span className="hint">
                  Enforced before every agent run. Caps are on by default — you can raise it later.
                </span>
              </div>
              <div className={styles.nav}>
                <button
                  type="button"
                  className="btn primary"
                  disabled={!name.trim() || busy}
                  onClick={createProject}
                >
                  {busy ? <span className="spinner" /> : project ? 'Save & continue →' : 'Continue →'}
                </button>
              </div>
            </>
          )}

          {/* ─── 2 · code ────────────────────────────────────────────────── */}
          {step === 2 && (
            <>
              <h3>Connect your code</h3>
              <p className={styles.sub}>
                specd writes via pull requests with short-lived scoped tokens — or, in Local mode,
                via a branch on your own machine.
              </p>

              <div className={styles.choices}>
                <button
                  type="button"
                  className={`${styles.choice} ${vcs === 'github' ? styles.picked : ''} ${styles.soon}`}
                  onClick={() => setVcs('github')}
                >
                  <h5>🐙 GitHub</h5>
                  <p>Install the GitHub App; pick from the repos you granted it.</p>
                  <span className={styles.badge}>needs an App registration</span>
                </button>
                <button
                  type="button"
                  className={`${styles.choice} ${vcs === 'gitlab' ? styles.picked : ''} ${styles.soon}`}
                  onClick={() => setVcs('gitlab')}
                >
                  <h5>🦊 GitLab</h5>
                  <p>gitlab.com or self-managed, via a personal or project access token.</p>
                  <span className={styles.badge}>needs a token</span>
                </button>
                <button
                  type="button"
                  className={`${styles.choice} ${vcs === 'local' ? styles.picked : ''}`}
                  onClick={() => setVcs('local')}
                >
                  <h5>💻 Local</h5>
                  <p>No host account needed. Setup lands as a branch you diff. Code never leaves this machine.</p>
                </button>
              </div>

              {vcs === 'github' && !githubStatus && <span className="spinner" />}

              {vcs === 'github' && githubStatus && !githubStatus.configured && (
                <div className={styles.info}>
                  No GitHub App is registered for this specd deployment yet — that is a one-time,
                  operator-level setup, not something a project connects to on its own.{' '}
                  <a href={githubStatus.registerUrl} target="_blank" rel="noreferrer">
                    Register it
                  </a>{' '}
                  (opens the API), then come back and pick GitHub again. See{' '}
                  <code>docs/github-app.md</code> for the full walkthrough.
                </div>
              )}

              {vcs === 'github' && githubStatus?.configured && !githubConnected && (
                <>
                  <div className="field">
                    <label>1. Install the App on your repositories</label>
                    <a
                      className="btn"
                      href={githubStatus.installUrl}
                      target="_blank"
                      rel="noreferrer"
                      style={{ alignSelf: 'flex-start' }}
                    >
                      Install on GitHub →
                    </a>
                    <span className="hint">
                      Opens GitHub in a new tab. After installing, the URL you land on ends{' '}
                      <code>/installations/&lt;id&gt;</code> — copy that id below.
                    </span>
                  </div>
                  <div className="field">
                    <label htmlFor="ghinstall">2. Installation id</label>
                    <input
                      id="ghinstall"
                      value={githubInstallationId}
                      onChange={(e) => setGithubInstallationId(e.target.value)}
                      placeholder="12345678"
                      spellCheck={false}
                    />
                  </div>
                  {githubError && <div className="err">{githubError}</div>}
                  <button
                    type="button"
                    className="btn"
                    onClick={connectGithub}
                    disabled={busy || !githubInstallationId.trim()}
                  >
                    {busy ? <span className="spinner" /> : 'Connect'}
                  </button>
                </>
              )}

              {vcs === 'github' && githubConnected && (
                <>
                  <div className={styles.good}>
                    ✓ Connected — {githubResults.length} repositor{githubResults.length === 1 ? 'y' : 'ies'}{' '}
                    granted.
                  </div>
                  {githubResults.length === 0 && (
                    <p className={styles.footnote}>
                      The installation has no repositories granted. Add some from the App&apos;s
                      settings on GitHub, then reload this page and reconnect.
                    </p>
                  )}
                  {githubResults.length > 0 && (
                    <ul className={styles.repolist}>
                      {githubResults.map((r) => {
                        const added = repos.some((x) => x.name === r.fullName);
                        return (
                          <li key={r.id}>
                            <span className={`mono ${styles.pickerName}`}>{r.fullName}</span>
                            <button
                              type="button"
                              className="btn sm"
                              disabled={busy || added}
                              onClick={() => addGithubRepo(r)}
                            >
                              {added ? 'added ✓' : '+ Add'}
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </>
              )}

              {vcs === 'gitlab' && !gitlabConnected && (
                <>
                  <div className="field">
                    <label htmlFor="gltoken">Personal or project access token</label>
                    <input
                      id="gltoken"
                      type="password"
                      value={gitlabToken}
                      onChange={(e) => setGitlabToken(e.target.value)}
                      placeholder="glpat-…"
                      spellCheck={false}
                    />
                    <span className="hint">
                      Needs the <code>api</code> scope and at least the Maintainer role — that role
                      is also what lets specd register the webhook that detects merges.
                    </span>
                  </div>
                  <div className="field">
                    <label htmlFor="glurl">Instance URL (self-managed only)</label>
                    <input
                      id="glurl"
                      value={gitlabInstanceUrl}
                      onChange={(e) => setGitlabInstanceUrl(e.target.value)}
                      placeholder="https://gitlab.example.com — leave blank for gitlab.com"
                      spellCheck={false}
                    />
                    <span className="hint">
                      The instance&apos;s origin. specd reaches it from the machine it runs on, so
                      a host behind a VPN needs this machine on that VPN, and an internal CA
                      needs to be trusted here (<code>NODE_EXTRA_CA_CERTS</code>).
                    </span>
                  </div>
                  {gitlabError && <div className="err">{gitlabError}</div>}
                  <button type="button" className="btn" onClick={connectGitlab} disabled={busy || !gitlabToken}>
                    {busy ? <span className="spinner" /> : 'Connect'}
                  </button>
                </>
              )}

              {vcs === 'gitlab' && gitlabConnected && (
                <>
                  <div className={styles.good}>✓ Connected. Search for a repository to add.</div>
                  <div className="field">
                    <label htmlFor="glsearch">Search repositories</label>
                    <input
                      id="glsearch"
                      value={gitlabSearch}
                      onChange={(e) => setGitlabSearch(e.target.value)}
                      onBlur={searchGitlabRepos}
                      placeholder="aurora"
                      spellCheck={false}
                    />
                  </div>
                  {gitlabSearching && <span className="spinner" />}
                  {!gitlabSearching && gitlabResults.length === 0 && (
                    <p className={styles.footnote}>No repositories found — the token may not grant access to any, or try a different search.</p>
                  )}
                  {gitlabResults.length > 0 && (
                    <ul className={styles.repolist}>
                      {gitlabResults.map((r) => {
                        const added = repos.some((x) => x.name === r.fullName);
                        return (
                          <li key={r.id}>
                            <span className={`mono ${styles.pickerName}`}>{r.fullName}</span>
                            <button
                              type="button"
                              className="btn sm"
                              disabled={busy || added}
                              onClick={() => addGitlabRepo(r)}
                            >
                              {added ? 'added ✓' : '+ Add'}
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </>
              )}

              {vcs === 'local' && (
                <>
                  <div className="field">
                    <label htmlFor="rpath">Repository path</label>
                    <input
                      id="rpath"
                      value={repoPath}
                      onChange={(e) => {
                        setRepoPath(e.target.value);
                        setPathCheck(null);
                      }}
                      onBlur={checkPath}
                      placeholder="/Users/you/dev/aurora-api"
                      spellCheck={false}
                    />
                    <span className="hint">
                      Must be the root of a git repository. Run <code>specd connect</code> in a repo
                      to register it from the terminal instead.
                    </span>
                  </div>

                  {pathCheck && (
                    <div className={pathCheck.ok ? styles.good : styles.bad}>
                      {pathCheck.ok ? (
                        <>
                          ✓ git repository on <b>{pathCheck.branch}</b>
                          {pathCheck.clean ? ', working tree clean' : ' — uncommitted changes ⚠'}
                        </>
                      ) : (
                        <>✕ {pathCheck.reason}</>
                      )}
                    </div>
                  )}

                  {pathCheck?.ok && (
                    <>
                      <div className="field">
                        <label htmlFor="rname">Name in specd</label>
                        <input
                          id="rname"
                          value={repoName}
                          onChange={(e) => setRepoName(e.target.value)}
                        />
                      </div>
                      <button type="button" className="btn" onClick={addRepo} disabled={busy}>
                        {busyAction === 'add-repo' && <span className="spinner" />} + Add repository
                      </button>
                    </>
                  )}

                  {/* Optional, and off by default: local mode's promise is that
                      specd holds no key to your host. This is the way to say
                      "open the merge request for me anyway" — used for that and
                      nothing else. */}
                  <div className="field">
                    <label htmlFor="revhost">Open pull/merge requests on (optional)</label>
                    <select
                      id="revhost"
                      value={reviewProvider}
                      onChange={(e) => {
                        setReviewProvider(e.target.value as '' | 'github' | 'gitlab');
                        setReviewCheck(null);
                      }}
                    >
                      <option value="">Nothing — leave me a branch to diff</option>
                      <option value="gitlab">GitLab (gitlab.com or self-managed)</option>
                      <option value="github">GitHub (github.com or Enterprise Server)</option>
                    </select>
                    <span className="hint">
                      specd reads and writes your code on disk either way. A token here is used
                      for one thing — opening the review — and never to fetch a file or push a
                      commit; your own git credentials do the push.
                    </span>
                  </div>

                  {reviewProvider && (
                    <>
                      <div className="field">
                        <label htmlFor="revurl">
                          Instance URL {reviewProvider === 'gitlab' ? '(self-managed only)' : '(Enterprise Server only)'}
                        </label>
                        <input
                          id="revurl"
                          value={reviewInstanceUrl}
                          onChange={(e) => setReviewInstanceUrl(e.target.value)}
                          placeholder={
                            reviewProvider === 'gitlab'
                              ? 'https://gitlab.example.com — blank for gitlab.com'
                              : 'https://github.example.com — blank for github.com'
                          }
                          spellCheck={false}
                        />
                        <span className="hint">
                          The instance root, not a project page. specd reaches it from the machine
                          it runs on, so a host behind a VPN needs this machine on that VPN.
                        </span>
                      </div>
                      <div className="field">
                        <label htmlFor="revtoken">Access token</label>
                        <input
                          id="revtoken"
                          type="password"
                          value={reviewToken}
                          onChange={(e) => setReviewToken(e.target.value)}
                          placeholder={reviewProvider === 'gitlab' ? 'glpat-…' : 'ghp_…'}
                          spellCheck={false}
                        />
                        <span className="hint">
                          {reviewProvider === 'gitlab'
                            ? 'Needs the api scope, and permission to open merge requests on the project.'
                            : 'A token with pull-request write access on the repository.'}
                        </span>
                      </div>
                      {reviewCheck && (
                        <div className={reviewCheck.ok ? styles.good : styles.bad}>
                          {reviewCheck.ok ? <>✓ {reviewCheck.detail}</> : <>✕ {reviewCheck.detail}</>}
                        </div>
                      )}
                      <button
                        type="button"
                        className="btn"
                        onClick={checkReviewCredential}
                        disabled={busy || !reviewToken}
                      >
                        {busyAction === 'check-review' ? <span className="spinner" /> : 'Check token'}
                      </button>
                    </>
                  )}
                </>
              )}

              {repos.length > 0 && (
                <>
                  <ul className={styles.repolist}>
                    {repos.map((r) => (
                      <li key={r.id}>
                        <span className="mono">{r.name}</span>
                        {r.isPrimary && <span className="pill on">primary</span>}
                        {r.localPath && <span className={styles.path}>{r.localPath}</span>}
                      </li>
                    ))}
                  </ul>
                  <p className={styles.footnote}>
                    The <b>primary</b> repo is where cross-repo specs file their as-built copy.
                  </p>
                </>
              )}

              <div className={styles.nav}>
                <button type="button" className="btn" onClick={() => setStep(1)}>
                  ← Back
                </button>
                <button
                  type="button"
                  className="btn primary"
                  disabled={busy || !canContinueFromCode || repos.length === 0}
                  onClick={connectVcsAndContinue}
                >
                  {busyAction === 'continue-2' ? <span className="spinner" /> : 'Continue →'}
                </button>
                {vcs === 'github' && !githubConnected && (
                  <span className={styles.hintl}>
                    {githubStatus && !githubStatus.configured
                      ? 'register the GitHub App first'
                      : 'install the App and connect first'}
                  </span>
                )}
                {vcs === 'gitlab' && !gitlabConnected && (
                  <span className={styles.hintl}>connect with a token first</span>
                )}
                {canContinueFromCode && repos.length === 0 && (
                  <span className={styles.hintl}>add at least one repository</span>
                )}
              </div>
            </>
          )}

          {/* ─── 3 · AI ──────────────────────────────────────────────────── */}
          {step === 3 && (
            <>
              <h3>Connect your AI</h3>
              <p className={styles.sub}>
                Three ways in — pick what your team is comfortable with. Spend caps are on by
                default either way.
              </p>

              <div className={styles.choices}>
                <button
                  type="button"
                  className={`${styles.choice} ${aiMode === 'api_key' ? styles.picked : ''}`}
                  onClick={() => setAiMode('api_key')}
                >
                  <h5>🔑 API key</h5>
                  <p>Bring your Anthropic key. Stored encrypted, validated live.</p>
                </button>
                <button
                  type="button"
                  className={`${styles.choice} ${aiMode === 'subscription_runner' ? styles.picked : ''} ${
                    aiModes && !aiModes.subscription_runner?.ok ? styles.soon : ''
                  }`}
                  onClick={() => setAiMode('subscription_runner')}
                  disabled={Boolean(aiModes && !aiModes.subscription_runner?.ok)}
                >
                  <h5>💻 Your Claude subscription</h5>
                  <p>
                    Drives the Claude Code already signed in on this machine. specd never sees or
                    stores a subscription credential.
                  </p>
                  {aiModes?.subscription_runner && (
                    <span className={styles.badge}>
                      {aiModes.subscription_runner.ok ? 'available here ✓' : 'claude not on PATH'}
                    </span>
                  )}
                </button>
                <button
                  type="button"
                  className={`${styles.choice} ${aiMode === 'managed_cloud' ? styles.picked : ''}`}
                  onClick={() => setAiMode('managed_cloud')}
                >
                  <h5>☁️ Managed cloud</h5>
                  <p>Zero keys: our metered inference, billed per run, hard caps.</p>
                </button>
              </div>

              {aiMode === 'api_key' && (
                <div className="field">
                  <label htmlFor="key">Anthropic API key</label>
                  <input
                    id="key"
                    type="password"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder="sk-ant-api03-…"
                    spellCheck={false}
                  />
                  <span className="hint">
                    Validated with a one-token ping before it is stored, so a bad key fails here and
                    not in your first agent run.
                  </span>
                </div>
              )}

              {aiMode === 'subscription_runner' && (
                <div className={styles.info}>
                  {aiModes?.subscription_runner?.detail ??
                    'Checking whether Claude Code is available on this machine…'}
                  <p style={{ margin: '.6rem 0 0', fontSize: '.74rem' }}>
                    Runs consume your subscription quota, so they are <b>not</b> metered in euros —
                    tokens are still recorded on every run. This mode only exists because specd is
                    running on your machine; a hosted specd could not offer it.
                  </p>
                </div>
              )}

              <div className="field">
                <label htmlFor="model">Default model</label>
                <select id="model" value={model} onChange={(e) => setModel(e.target.value)}>
                  <option value="claude-opus-5">claude-opus-5 · deepest specs</option>
                  <option value="claude-sonnet-5">claude-sonnet-5 · balanced</option>
                  <option value="claude-haiku-4-5">claude-haiku-4-5 · drafts &amp; indexing</option>
                </select>
              </div>

              {keyCheck && !keyCheck.ok && <div className="err">{keyCheck.detail}</div>}

              <div className={styles.nav}>
                <button type="button" className="btn" onClick={() => setStep(2)}>
                  ← Back
                </button>
                <button
                  type="button"
                  className="btn primary"
                  disabled={busy || !aiMode || (aiMode === 'api_key' && !apiKey)}
                  onClick={connectAi}
                >
                  {busy ? <span className="spinner" /> : 'Continue →'}
                </button>
                {!aiMode && <span className={styles.hintl}>choose an AI mode first</span>}
              </div>
            </>
          )}

          {/* ─── 4 · tracker ─────────────────────────────────────────────── */}
          {step === 4 && (
            <>
              <h3>Where do tickets live?</h3>
              <p className={styles.sub}>
                Business asks stay where the business is. Both options drive the same spec
                lifecycle.
              </p>
              <div className={styles.choices}>
                <button
                  type="button"
                  className={`${styles.choice} ${tracker === 'board' ? styles.picked : ''}`}
                  onClick={() => setTracker('board')}
                >
                  <h5>📋 Built-in board</h5>
                  <p>Created instantly: Backlog → Spec draft → In review → Approved → Building → Done.</p>
                </button>
                <button
                  type="button"
                  className={`${styles.choice} ${tracker === 'jira' ? styles.picked : ''}`}
                  onClick={() => setTracker('jira')}
                >
                  <h5>🔷 Jira Cloud</h5>
                  <p>
                    Your issues stay in Jira. specd imports them, comments a backlink when a spec
                    moves, and mirrors status onto your own workflow.
                  </p>
                </button>
              </div>

              {tracker === 'jira' && !jiraConnectedAs && (
                <>
                  <div className="field">
                    <label htmlFor="jirasite">Site URL</label>
                    <input
                      id="jirasite"
                      value={jiraSiteUrl}
                      onChange={(e) => setJiraSiteUrl(e.target.value)}
                      placeholder="https://your-team.atlassian.net"
                      spellCheck={false}
                    />
                    <span className="hint">
                      Jira <strong>Cloud</strong> only. Server and Data Center use different auth
                      and are not supported.
                    </span>
                  </div>
                  <div className="field">
                    <label htmlFor="jiraemail">Atlassian account email</label>
                    <input
                      id="jiraemail"
                      value={jiraEmail}
                      onChange={(e) => setJiraEmail(e.target.value)}
                      placeholder="you@your-team.com"
                      spellCheck={false}
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="jiratoken">API token</label>
                    <input
                      id="jiratoken"
                      type="password"
                      value={jiraToken}
                      onChange={(e) => setJiraToken(e.target.value)}
                      placeholder="ATATT…"
                      spellCheck={false}
                    />
                    <span className="hint">
                      Create one at{' '}
                      <a
                        href="https://id.atlassian.com/manage-profile/security/api-tokens"
                        target="_blank"
                        rel="noreferrer"
                      >
                        id.atlassian.com
                      </a>{' '}
                      → Security → API tokens. Not an OAuth app — a token works immediately, with
                      nothing to register.
                    </span>
                  </div>
                  {jiraError && <div className="err">{jiraError}</div>}
                  <button
                    type="button"
                    className="btn"
                    onClick={connectJira}
                    disabled={busy || !jiraSiteUrl || !jiraEmail || !jiraToken}
                  >
                    {busy ? <span className="spinner" /> : 'Connect'}
                  </button>
                </>
              )}

              {tracker === 'jira' && jiraConnectedAs && (
                <>
                  <div className={styles.good}>✓ Connected as {jiraConnectedAs}.</div>
                  <div className="field">
                    <label htmlFor="jiraproject">Which Jira project?</label>
                    <select
                      id="jiraproject"
                      value={jiraProjectKey}
                      onChange={(e) => setJiraProjectKey(e.target.value)}
                    >
                      <option value="">Select a project…</option>
                      {jiraProjects.map((p) => (
                        <option key={p.id} value={p.key}>
                          {p.key} — {p.name}
                        </option>
                      ))}
                    </select>
                    {jiraProjects.length === 0 && (
                      <span className="hint">
                        This credential can see no projects. Check the account has access to at
                        least one.
                      </span>
                    )}
                  </div>
                  <label className={styles.check}>
                    <input
                      type="checkbox"
                      checked={jiraImport}
                      onChange={(e) => setJiraImport(e.target.checked)}
                    />
                    <span>
                      Import open issues onto the board now. Closed issues are skipped, and each
                      one keeps its Jira key.
                    </span>
                  </label>
                </>
              )}

              <div className={styles.nav}>
                <button type="button" className="btn" onClick={() => setStep(3)}>
                  ← Back
                </button>
                <button
                  type="button"
                  className="btn primary"
                  disabled={
                    busy || !tracker || (tracker === 'jira' && (!jiraConnectedAs || !jiraProjectKey))
                  }
                  onClick={connectTracker}
                >
                  {busyAction === 'continue-4' ? (
                    <>
                      <span className="spinner" />
                      {tracker === 'jira' && jiraImport ? ' Importing issues…' : null}
                    </>
                  ) : (
                    'Continue →'
                  )}
                </button>
              </div>
            </>
          )}

          {/* ─── 5 · knowledge ───────────────────────────────────────────── */}
          {step === 5 && (
            <>
              <h3>Initialize the knowledge base</h3>
              <p className={styles.sub}>
                The onboarding agent scans your repos read-only and drafts the scaffold. Everything
                ships as a <b>draft</b> for review — merging is adopting.
              </p>

              <div className={styles.warn}>
                <b>The wizard will not lie to you.</b> Generated docs carry a{' '}
                <code>DRAFT — review before trusting</code> banner, and every claim the agent could
                not ground in your code is marked <code>UNVERIFIED</code>. Read them like a new
                hire’s first write-up.
              </div>

              {!onboardResults && (
                <>
                  <ul className={styles.repolist}>
                    {repos.map((r) => (
                      <li key={r.id}>
                        <span className="mono">{r.name}</span>
                        {r.isPrimary && <span className="pill on">primary</span>}
                        <span className={styles.path}>
                          scaffold + AGENTS.md + CLAUDE.md (yours are kept, ours appended)
                        </span>
                      </li>
                    ))}
                  </ul>
                  <div className={styles.nav}>
                    <button type="button" className="btn" onClick={() => setStep(4)}>
                      ← Back
                    </button>
                    <button
                      type="button"
                      className="btn primary"
                      onClick={runOnboarding}
                      disabled={busy}
                    >
                      {busy ? (
                        <>
                          <span className="spinner" /> Scanning &amp; drafting…
                        </>
                      ) : (
                        `Run setup on ${repos.length} repo${repos.length === 1 ? '' : 's'}`
                      )}
                    </button>
                  </div>
                </>
              )}

              {onboardResults && (
                <>
                  {onboardResults.map((r) => (
                    <div key={r.runId} className={r.error ? styles.bad : styles.good}>
                      <b>{r.repoName}</b>
                      {r.queued ? (
                        <>
                          {' '}
                          — <span className="spinner" /> queued — reading the repository and
                          drafting the scaffold…
                        </>
                      ) : r.error ? (
                        <> — {r.error}</>
                      ) : (
                        <>
                          {' '}
                          — {r.fileCount} files on branch <code>{r.branch}</code>
                          {r.url && (
                            <>
                              {' '}
                              <a
                                className="btn sm"
                                href={r.url}
                                target="_blank"
                                rel="noreferrer"
                              >
                                Review the PR →
                              </a>
                            </>
                          )}
                          <p className={styles.hintq}>{r.reviewHint}</p>
                        </>
                      )}
                    </div>
                  ))}
                  <div className={styles.nav}>
                    <button type="button" className="btn" onClick={() => setStep(4)}>
                      ← Back
                    </button>
                    <button type="button" className="btn primary" onClick={() => goTo(6)}>
                      Continue →
                    </button>
                  </div>
                </>
              )}
            </>
          )}

          {/* ─── 6 · done ────────────────────────────────────────────────── */}
          {step === 6 && project && (
            <>
              <h3>{project.name} is spec-driven</h3>
              <p className={styles.sub}>Three things left:</p>
              <ol className={styles.checklist}>
                <li>
                  <b>Review and merge the setup branch.</b> Merging is how you adopt it — specd
                  tracks that as the moment the project goes live.
                </li>
                <li>
                  <b>Write your first ticket</b> on the board, in plain business language.
                </li>
                <li>
                  <b>Generate your first spec</b> — then read it critically and stamp it.
                </li>
              </ol>
              <div className={styles.nav}>
                <button
                  type="button"
                  className="btn primary"
                  onClick={() => router.push(`/p/${project.slug}`)}
                >
                  Go to project →
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      <div className={styles.schematic}>
        <p className={styles.schemnote}>
          The same setup, seen as the line it configures. Stations cannot be added, skipped or
          removed — only station 01 takes configuration.
        </p>
        <Pipeline />
      </div>

      {cancelOpen && project && (
        <ConfirmDialog
          title="Leave setup?"
          body={
            <>
              <b>{project.name}</b> stays as a draft — the dashboard offers to resume it exactly
              where you stopped — or discard it now and nothing is kept.
            </>
          }
          confirmLabel="Discard project"
          altLabel="Keep draft & leave"
          onAlt={() => router.push('/projects')}
          busy={discardBusy}
          error={cancelError}
          onConfirm={discardProject}
          onCancel={() => setCancelOpen(false)}
        />
      )}
    </AppShell>
  );
}
