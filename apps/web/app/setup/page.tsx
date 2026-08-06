'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import Link from 'next/link';
import { get, post } from '@/lib/api';
import { AppShell } from '@/components/AppShell';
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
interface OnboardResult {
  repoName: string;
  branch?: string;
  url?: string | null;
  reviewHint?: string;
  fileCount?: number;
  error?: string;
  runId: string;
}

export default function SetupWizard() {
  const router = useRouter();
  const [step, setStep] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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

  // step 3
  const [aiMode, setAiMode] = useState<'api_key' | 'subscription_runner' | 'managed_cloud' | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('claude-opus-5');
  const [capEuros, setCapEuros] = useState('100');
  const [keyCheck, setKeyCheck] = useState<{ ok: boolean; detail: string } | null>(null);

  // step 4
  const [tracker, setTracker] = useState<'board' | 'jira' | null>(null);

  // step 5
  const [onboardResults, setOnboardResults] = useState<OnboardResult[] | null>(null);

  function fail(err: unknown) {
    setError(err instanceof Error ? err.message : String(err));
  }

  async function createProject() {
    setBusy(true);
    setError(null);
    try {
      const created = await post<Project & { slug: string }>('/projects', {
        name,
        description: description || undefined,
        spendCapCents: Math.round(Number(capEuros || '100') * 100),
      });
      setProject(created);
      setStep(2);
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
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
    }
  }

  async function connectVcsAndContinue() {
    if (!project || !vcs) return;
    setBusy(true);
    setError(null);
    try {
      await post(`/projects/${project.slug}/connections/vcs`, { provider: vcs });
      setStep(3);
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
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
      if (res.ok) setStep(4);
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  async function connectTracker() {
    if (!project || !tracker) return;
    setBusy(true);
    setError(null);
    try {
      await post(`/projects/${project.slug}/connections/tracker`, { provider: tracker });
      setStep(5);
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
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

  return (
    <AppShell
      crumb="New project setup"
      pills={<span className="pill">step {step}/6</span>}
      actions={
        <Link href="/projects" className="btn sm">
          Cancel
        </Link>
      }
    >
      <div className={styles.grid}>
        <ol className={styles.steps}>
          {STEPS.map((label, i) => (
            <li
              key={label}
              className={`${styles.step} ${i + 1 === step ? styles.on : ''} ${
                i + 1 < step ? styles.done : ''
              }`}
            >
              <span className={styles.n}>{i + 1 < step ? '✓' : i + 1}</span>
              {label}
            </li>
          ))}
        </ol>

        <div className={styles.panel}>
          {error && <div className="err">{error}</div>}

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
                  {busy ? <span className="spinner" /> : 'Continue →'}
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
                  className={`${styles.choice} ${styles.soon}`}
                  disabled
                >
                  <h5>🦊 GitLab</h5>
                  <p>gitlab.com OAuth — or self-managed via URL + token.</p>
                  <span className={styles.badge}>P2</span>
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

              {vcs === 'github' && (
                <div className={styles.info}>
                  The GitHub adapter is implemented against the same interface as Local mode, but it
                  needs a GitHub App registration and a token before it can open PRs. Use Local mode
                  to walk the loop today.
                </div>
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
                        + Add repository
                      </button>
                    </>
                  )}

                  {repos.length > 0 && (
                    <ul className={styles.repolist}>
                      {repos.map((r) => (
                        <li key={r.id}>
                          <span className="mono">{r.name}</span>
                          {r.isPrimary && <span className="pill on">primary</span>}
                          <span className={styles.path}>{r.localPath}</span>
                        </li>
                      ))}
                    </ul>
                  )}
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
                  disabled={busy || vcs !== 'local' || repos.length === 0}
                  onClick={connectVcsAndContinue}
                >
                  Continue →
                </button>
                {vcs !== 'local' && <span className={styles.hintl}>pick Local to continue</span>}
                {vcs === 'local' && repos.length === 0 && (
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
                  className={`${styles.choice} ${aiMode === 'subscription_runner' ? styles.picked : ''}`}
                  onClick={() => setAiMode('subscription_runner')}
                >
                  <h5>💻 Your subscription, your runner</h5>
                  <p>Run the self-hosted runner where your Claude Code lives — credentials never touch our cloud.</p>
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
                <div className="mutedbox">
                  docker run -d specd/runner --pair XK4-9TR{'\n'}# Runner pairing lands in P2. The
                  platform never holds subscription credentials — that is the whole point.
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
                <button type="button" className={`${styles.choice} ${styles.soon}`} disabled>
                  <h5>🔷 Jira Cloud</h5>
                  <p>Atlassian OAuth. Status ↔ lifecycle mapped; specd comments backlinks.</p>
                  <span className={styles.badge}>P3</span>
                </button>
              </div>
              <div className={styles.nav}>
                <button type="button" className="btn" onClick={() => setStep(3)}>
                  ← Back
                </button>
                <button
                  type="button"
                  className="btn primary"
                  disabled={busy || !tracker}
                  onClick={connectTracker}
                >
                  Continue →
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
                        <span className={styles.path}>scaffold + AGENTS.md + CLAUDE.md</span>
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
                      {r.error ? (
                        <> — {r.error}</>
                      ) : (
                        <>
                          {' '}
                          — {r.fileCount} files on branch <code>{r.branch}</code>
                          <p className={styles.hintq}>{r.reviewHint}</p>
                        </>
                      )}
                    </div>
                  ))}
                  <div className={styles.nav}>
                    <button type="button" className="btn primary" onClick={() => setStep(6)}>
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
    </AppShell>
  );
}
