'use client';

import { useState } from 'react';
import { get, post } from '@/lib/api';

/**
 * The connection cards, now with the half that was missing: change. Every
 * form here drives the same endpoints the wizard drives — connections are
 * one row per kind and a re-POST replaces the row — so settings and setup
 * cannot drift apart. Validation is live for the same reason it is in the
 * wizard: a stored credential that was never exercised is a lie waiting for
 * a run to expose it.
 */

export interface Connection {
  id: string;
  kind: string;
  provider: string;
  label: string | null;
  settings: Record<string, unknown> | null;
  status: string;
  hasSecret: boolean;
  lastValidatedAt: string | null;
}

interface ModeInfo {
  ok: boolean;
  detail: string;
}

interface GithubStatus {
  configured: boolean;
  reason?: string;
  registerUrl?: string;
  installUrl?: string;
}

const KIND_META: Record<string, { icon: string; title: string }> = {
  vcs: { icon: '🐙', title: 'Code' },
  ai: { icon: '🔑', title: 'AI provider' },
  tracker: { icon: '📋', title: 'Tracker' },
};

const KINDS = ['vcs', 'ai', 'tracker'] as const;
type Kind = (typeof KINDS)[number];

export function ConnectionCards({
  slug,
  projectId,
  connections,
  onChange,
}: {
  slug: string;
  projectId: string;
  connections: Connection[];
  onChange: () => void;
}) {
  const [editing, setEditing] = useState<Kind | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  // AI
  const [aiModes, setAiModes] = useState<Record<string, ModeInfo> | null>(null);
  const [mode, setMode] = useState<'api_key' | 'subscription_runner' | 'managed_cloud'>(
    'subscription_runner',
  );
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('claude-opus-5');

  // VCS
  const [provider, setProvider] = useState<'local' | 'github' | 'gitlab'>('local');
  const [githubStatus, setGithubStatus] = useState<GithubStatus | null>(null);
  const [installationId, setInstallationId] = useState('');
  const [gitlabToken, setGitlabToken] = useState('');
  const [gitlabInstanceUrl, setGitlabInstanceUrl] = useState('');

  // Tracker
  const [tracker, setTracker] = useState<'board' | 'jira'>('board');
  const [jiraSiteUrl, setJiraSiteUrl] = useState('');
  const [jiraEmail, setJiraEmail] = useState('');
  const [jiraToken, setJiraToken] = useState('');
  const [jiraProjectKey, setJiraProjectKey] = useState('');

  const byKind = (kind: Kind) => connections.find((c) => c.kind === kind);

  function openEdit(kind: Kind) {
    setErr(null);
    setNote(null);
    setEditing(kind);
    const existing = byKind(kind);
    if (kind === 'ai') {
      const s = (existing?.settings ?? {}) as { mode?: string; model?: string };
      if (s.mode === 'api_key' || s.mode === 'subscription_runner' || s.mode === 'managed_cloud') {
        setMode(s.mode);
      }
      get<Record<string, ModeInfo>>('/projects/ai-modes').then(setAiModes).catch(() => undefined);
    }
    if (kind === 'vcs') {
      if (existing?.provider === 'local' || existing?.provider === 'github' || existing?.provider === 'gitlab') {
        setProvider(existing.provider);
      }
      const s = (existing?.settings ?? {}) as { installationId?: string; instanceUrl?: string };
      if (s.installationId) setInstallationId(s.installationId);
      if (s.instanceUrl) setGitlabInstanceUrl(s.instanceUrl);
      get<GithubStatus>('/github/status').then(setGithubStatus).catch(() => undefined);
    }
    if (kind === 'tracker' && (existing?.provider === 'board' || existing?.provider === 'jira')) {
      setTracker(existing.provider);
    }
  }

  /** Runs a save; the fn returns the success message or throws with the reason. */
  async function run(fn: () => Promise<string>) {
    setBusy(true);
    setErr(null);
    setNote(null);
    try {
      const detail = await fn();
      setNote(detail);
      setEditing(null);
      onChange();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to save the connection');
    } finally {
      setBusy(false);
    }
  }

  const saveAi = () =>
    run(async () => {
      const res = await post<{ ok: boolean; detail: string }>(`/projects/${slug}/connections/ai`, {
        mode,
        apiKey: apiKey || undefined,
        model,
      });
      if (!res.ok) throw new Error(res.detail);
      setApiKey('');
      return res.detail || 'AI connection updated.';
    });

  const saveVcs = () =>
    run(async () => {
      if (provider === 'local') {
        await post(`/projects/${slug}/connections/vcs`, { provider: 'local' });
        return 'Switched to local mode.';
      }
      if (provider === 'gitlab') {
        await post(`/projects/${slug}/connections/vcs`, {
          provider: 'gitlab',
          token: gitlabToken,
          instanceUrl: gitlabInstanceUrl.trim() || undefined,
        });
        // Same live validation the wizard does: list with the stored token,
        // so a bad credential fails here on the form, not on the next run.
        const listed = await get<{ repositories: unknown[] }>(
          `/gitlab/projects/${projectId}/repositories`,
        );
        setGitlabToken('');
        return `GitLab connected — ${listed.repositories.length} repositories visible.`;
      }
      const res = await post<{ repositories: unknown[] }>(
        `/github/projects/${projectId}/installation`,
        { installationId: installationId.trim() },
      );
      return `Installation recorded — ${res.repositories.length} repositories granted.`;
    });

  const saveTracker = () =>
    run(async () => {
      if (tracker === 'board') {
        await post(`/projects/${slug}/connections/tracker`, { provider: 'board' });
        return 'Using the built-in board.';
      }
      await post(`/projects/${slug}/connections/tracker`, {
        provider: 'jira',
        siteUrl: jiraSiteUrl.trim(),
        email: jiraEmail.trim(),
        apiToken: jiraToken,
        projectKey: jiraProjectKey.trim() || undefined,
      });
      const listed = await get<{ projects: unknown[] }>(`/projects/${slug}/tracker/jira/projects`);
      setJiraToken('');
      return `Jira connected — ${listed.projects.length} projects visible.`;
    });

  function summary(kind: Kind, c: Connection | undefined): string {
    if (!c) return 'not connected';
    if (kind === 'ai') {
      const s = (c.settings ?? {}) as { mode?: string };
      return s.mode ? `${c.provider} · ${s.mode.replace('_', ' ')}` : c.provider;
    }
    if (kind === 'vcs' && c.provider === 'github') {
      const s = (c.settings ?? {}) as { installationId?: string };
      return s.installationId ? `github · installation ${s.installationId}` : 'github';
    }
    return c.provider + (c.label ? ` · ${c.label}` : '');
  }

  return (
    <>
      {err && <div className="err">{err}</div>}
      {note && <div className="okbox">{note}</div>}

      {KINDS.map((kind) => {
        const meta = KIND_META[kind]!;
        const c = byKind(kind);
        return (
          <div key={kind} className="card">
            <div className="row">
              <span className="ic">{meta.icon}</span>
              <div>
                <h5>{meta.title}</h5>
                <p>
                  {summary(kind, c)}
                  {c?.hasSecret ? ' · credential stored (encrypted)' : ''}
                </p>
              </div>
              <span className="flex" />
              {c && <span className="pill on">{c.status}</span>}
              <button
                type="button"
                className="btn sm"
                onClick={() => (editing === kind ? setEditing(null) : openEdit(kind))}
              >
                {editing === kind ? 'Close' : c ? 'Change' : 'Connect'}
              </button>
            </div>

            {editing === kind && kind === 'ai' && (
              <div className="form">
                <div className="field">
                  <label htmlFor="cc-mode">Mode</label>
                  <select
                    id="cc-mode"
                    value={mode}
                    onChange={(e) => setMode(e.target.value as typeof mode)}
                  >
                    <option value="subscription_runner">
                      Claude subscription (runs on a machine with Claude Code)
                    </option>
                    <option value="api_key">Anthropic API key (metered per token)</option>
                    <option value="managed_cloud">Managed cloud</option>
                  </select>
                  {aiModes?.[mode] && (
                    <span className="hint">
                      {aiModes[mode].ok ? '✓ ' : '✗ '}
                      {aiModes[mode].detail}
                    </span>
                  )}
                </div>
                {mode === 'api_key' && (
                  <div className="field">
                    <label htmlFor="cc-key">API key</label>
                    <input
                      id="cc-key"
                      type="password"
                      value={apiKey}
                      onChange={(e) => setApiKey(e.target.value)}
                      placeholder="sk-ant-…"
                      autoComplete="off"
                    />
                    <span className="hint">
                      Validated against the API before it is stored, then encrypted in the vault.
                    </span>
                  </div>
                )}
                <div className="field">
                  <label htmlFor="cc-model">Default model</label>
                  <select id="cc-model" value={model} onChange={(e) => setModel(e.target.value)}>
                    <option value="claude-opus-5">claude-opus-5 · deepest specs</option>
                    <option value="claude-sonnet-5">claude-sonnet-5 · balanced</option>
                    <option value="claude-haiku-4-5">claude-haiku-4-5 · drafts &amp; indexing</option>
                  </select>
                </div>
                <button
                  type="button"
                  className="btn primary"
                  disabled={busy || (mode === 'api_key' && !apiKey)}
                  onClick={saveAi}
                >
                  {busy && <span className="spinner" />} Save AI connection
                </button>
              </div>
            )}

            {editing === kind && kind === 'vcs' && (
              <div className="form">
                <div className="field">
                  <label htmlFor="cc-provider">Provider</label>
                  <select
                    id="cc-provider"
                    value={provider}
                    onChange={(e) => setProvider(e.target.value as typeof provider)}
                  >
                    <option value="local">Local — repositories on this machine</option>
                    <option value="github">GitHub — via the GitHub App</option>
                    <option value="gitlab">GitLab — via an access token</option>
                  </select>
                  <span className="hint">
                    Repositories keep the provider they were added with. After switching, remove
                    the ones that no longer match and re-add them in the Repositories tab.
                  </span>
                </div>

                {provider === 'github' && githubStatus && !githubStatus.configured && (
                  <p className="warnnote">
                    No GitHub App is registered for this deployment — a one-time, operator-level
                    setup, not a project setting.{' '}
                    {githubStatus.registerUrl && (
                      <a href={githubStatus.registerUrl} target="_blank" rel="noreferrer">
                        Register it
                      </a>
                    )}{' '}
                    — see <code>docs/github-app.md</code>. Until then, local and GitLab modes work
                    without it.
                  </p>
                )}
                {provider === 'github' && githubStatus?.configured && (
                  <div className="field">
                    <label htmlFor="cc-inst">Installation id</label>
                    <input
                      id="cc-inst"
                      value={installationId}
                      onChange={(e) => setInstallationId(e.target.value)}
                      placeholder="e.g. 151704134"
                    />
                    <span className="hint">
                      {githubStatus.installUrl && (
                        <>
                          <a href={githubStatus.installUrl} target="_blank" rel="noreferrer">
                            Install the App
                          </a>{' '}
                          — the URL you land on ends /installations/&lt;id&gt;.
                        </>
                      )}
                    </span>
                  </div>
                )}
                {provider === 'gitlab' && (
                  <>
                    <div className="field">
                      <label htmlFor="cc-gltoken">Access token</label>
                      <input
                        id="cc-gltoken"
                        type="password"
                        value={gitlabToken}
                        onChange={(e) => setGitlabToken(e.target.value)}
                        placeholder="glpat-…"
                        autoComplete="off"
                      />
                      <span className="hint">Personal or project token with `api` scope.</span>
                    </div>
                    <div className="field">
                      <label htmlFor="cc-glurl">Instance URL (self-managed only)</label>
                      <input
                        id="cc-glurl"
                        value={gitlabInstanceUrl}
                        onChange={(e) => setGitlabInstanceUrl(e.target.value)}
                        placeholder="https://gitlab.example.com — empty for gitlab.com"
                      />
                    </div>
                  </>
                )}
                <button
                  type="button"
                  className="btn primary"
                  disabled={
                    busy ||
                    (provider === 'gitlab' && !gitlabToken) ||
                    (provider === 'github' &&
                      (!githubStatus?.configured || !installationId.trim()))
                  }
                  onClick={saveVcs}
                >
                  {busy && <span className="spinner" />} Save code connection
                </button>
              </div>
            )}

            {editing === kind && kind === 'tracker' && (
              <div className="form">
                <div className="field">
                  <label htmlFor="cc-tracker">Tracker</label>
                  <select
                    id="cc-tracker"
                    value={tracker}
                    onChange={(e) => setTracker(e.target.value as typeof tracker)}
                  >
                    <option value="board">Built-in board</option>
                    <option value="jira">Jira</option>
                  </select>
                </div>
                {tracker === 'jira' && (
                  <>
                    <div className="field">
                      <label htmlFor="cc-jurl">Site URL</label>
                      <input
                        id="cc-jurl"
                        value={jiraSiteUrl}
                        onChange={(e) => setJiraSiteUrl(e.target.value)}
                        placeholder="https://your-team.atlassian.net"
                      />
                    </div>
                    <div className="field">
                      <label htmlFor="cc-jmail">Email</label>
                      <input
                        id="cc-jmail"
                        value={jiraEmail}
                        onChange={(e) => setJiraEmail(e.target.value)}
                      />
                    </div>
                    <div className="field">
                      <label htmlFor="cc-jtoken">API token</label>
                      <input
                        id="cc-jtoken"
                        type="password"
                        value={jiraToken}
                        onChange={(e) => setJiraToken(e.target.value)}
                        autoComplete="off"
                      />
                    </div>
                    <div className="field">
                      <label htmlFor="cc-jkey">Project key</label>
                      <input
                        id="cc-jkey"
                        value={jiraProjectKey}
                        onChange={(e) => setJiraProjectKey(e.target.value)}
                        placeholder="AUR"
                      />
                    </div>
                  </>
                )}
                <button
                  type="button"
                  className="btn primary"
                  disabled={
                    busy || (tracker === 'jira' && (!jiraSiteUrl || !jiraEmail || !jiraToken))
                  }
                  onClick={saveTracker}
                >
                  {busy && <span className="spinner" />} Save tracker
                </button>
              </div>
            )}
          </div>
        );
      })}

      <style jsx>{`
        .row {
          display: flex;
          align-items: center;
          gap: 0.9rem;
        }
        .ic {
          font-size: 1.2rem;
        }
        .flex {
          flex: 1;
        }
        h5 {
          font: 600 1.058rem/1.2 var(--sans);
          margin: 0 0 0.2rem;
        }
        p {
          font-size: 0.943rem;
          color: var(--ink-3);
          margin: 0;
          line-height: 1.6;
        }
        .form {
          margin-top: 1rem;
          padding-top: 1rem;
          border-top: 1px solid var(--line);
        }
        .okbox {
          font: 500 0.92rem/1.6 var(--sans);
          background: var(--bg-2);
          border: 1px solid var(--line-2);
          border-radius: 6px;
          padding: 0.7rem 0.85rem;
          margin: 0 0 0.8rem;
        }
        .warnnote {
          font-size: 0.9rem;
          color: var(--ink-2);
          background: var(--warn-soft);
          border: 1px solid var(--line-2);
          border-radius: 6px;
          padding: 0.7rem 0.85rem;
          line-height: 1.6;
          margin: 0 0 0.9rem;
        }
      `}</style>
    </>
  );
}
