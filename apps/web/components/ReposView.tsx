'use client';

import { useCallback, useEffect, useState } from 'react';
import { get, post } from '@/lib/api';

interface Repo {
  id: string;
  name: string;
  provider: string;
  localPath: string | null;
  isPrimary: boolean;
  setupBranch: string | null;
  setupPrUrl: string | null;
  setupState: string;
  kbStatus: string;
  webhookStatus: string;
  lastIndexedAt: string | null;
}
interface Connection {
  kind: string;
  provider: string;
  status: string;
}

/**
 * Does specd actually get told when this repository's setup/spec branch
 * merges? GitHub does as long as the App installation behind it is still
 * live — `connections.status` moves to `revoked`/`suspended` the moment
 * GitHub's own `installation` webhook says so
 * (`GitHubWebhookService.onInstallation`), and a dead installation delivers
 * nothing, however confidently the UI claimed otherwise a moment ago. GitLab
 * only watches when its own per-repository registration succeeded — a token
 * below Maintainer, or a missing `GITLAB_WEBHOOK_SECRET`, leaves it exactly
 * where local mode already is.
 */
function hasWebhook(r: Repo, vcsConnectionStatus: string | undefined): boolean {
  if (r.provider === 'github') return vcsConnectionStatus === 'connected';
  return r.provider === 'gitlab' && r.webhookStatus === 'registered';
}

export function ReposView({ slug, onChange }: { slug: string; onChange: () => void }) {
  const [repos, setRepos] = useState<Repo[]>([]);
  const [vcsConnectionStatus, setVcsConnectionStatus] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    get<Repo[]>(`/projects/${slug}/repositories`).then(setRepos).catch(() => undefined);
    get<Connection[]>(`/projects/${slug}/connections`)
      .then((cs) => setVcsConnectionStatus(cs.find((c) => c.kind === 'vcs')?.status))
      .catch(() => undefined);
  }, [slug]);

  useEffect(load, [load]);

  async function act(id: string, fn: () => Promise<unknown>) {
    setBusy(id);
    setError(null);
    try {
      await fn();
      load();
      onChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      {error && <div className="err">{error}</div>}

      <table>
        <thead>
          <tr>
            <th>Repository</th>
            <th>Provider</th>
            <th>Setup</th>
            <th>Knowledge</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {repos.map((r) => (
            <tr key={r.id}>
              <td>
                <span className="mono">{r.name}</span>{' '}
                {r.isPrimary && <span className="pill on">primary</span>}
                {r.localPath && <div className="path">{r.localPath}</div>}
              </td>
              <td>{r.provider}</td>
              <td>
                {r.setupState === 'merged' ? (
                  <span className="pill on">merged ✓</span>
                ) : r.setupBranch ? (
                  <span
                    className="pill warn"
                    title={
                      hasWebhook(r, vcsConnectionStatus)
                        ? 'specd is watching for the merge — the webhook records it and re-indexes'
                        : r.provider === 'gitlab'
                          ? 'No working GitLab webhook for this repository — tell specd once you have merged'
                          : r.provider === 'github'
                            ? `The GitHub App installation is ${vcsConnectionStatus ?? 'not connected'} — tell specd once you have merged`
                            : 'Local repositories have no webhook, so tell specd once you have merged'
                    }
                  >
                    on {r.setupBranch}
                  </span>
                ) : (
                  <span className="pill">not run</span>
                )}
              </td>
              <td>
                {r.kbStatus === 'indexed' ? (
                  <span className="pill on">indexed</span>
                ) : (
                  <span className="pill">none</span>
                )}
              </td>
              <td className="right">
                {/*
                  A repo with a working webhook needs no button: the webhook
                  sees the merge and records it. Asking for a click as well
                  would be asking someone to confirm something specd already
                  knows — and letting them claim a merge that never happened.
                  Local repos, and GitLab repos whose webhook registration
                  failed, have no other signal — there the button is it.
                */}
                {r.setupBranch && r.setupState !== 'merged' && !hasWebhook(r, vcsConnectionStatus) && (
                  <button
                    type="button"
                    className="btn sm"
                    disabled={busy === r.id}
                    onClick={() =>
                      act(r.id, () => post(`/projects/${slug}/repositories/${r.id}/setup-merged`))
                    }
                    title="No webhook for this repository — tell specd once you have merged the setup branch"
                  >
                    I merged it
                  </button>
                )}
                {!r.isPrimary && (
                  <button
                    type="button"
                    className="btn sm"
                    disabled={busy === r.id}
                    onClick={() =>
                      act(r.id, () => post(`/projects/${slug}/repositories/${r.id}/primary`))
                    }
                  >
                    Make primary
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {repos.length === 0 && <div className="empty">No repositories connected yet.</div>}

      <p className="foot">
        The <b>primary</b> repository is where cross-repo specs file their as-built copy. specd
        writes to branches and pull requests — never directly to your default branch.
      </p>

      <style jsx>{`
        table {
          width: 100%;
          border-collapse: collapse;
          border: 1px solid var(--line);
          border-radius: var(--radius);
          overflow: hidden;
          font-size: 0.958rem;
        }
        th {
          text-align: left;
          font: 600 0.848rem/1 var(--mono);
          letter-spacing: 0.08em;
          text-transform: uppercase;
          color: var(--ink-3);
          padding: 0.6rem 0.8rem;
          background: var(--panel-2);
          border-bottom: 1px solid var(--line);
        }
        td {
          padding: 0.65rem 0.8rem;
          border-bottom: 1px solid var(--line);
          vertical-align: top;
        }
        tr:last-child td {
          border-bottom: none;
        }
        .right {
          text-align: right;
          white-space: nowrap;
        }
        .right :global(button) {
          margin-left: 0.35rem;
        }
        .path {
          font: 500 0.868rem/1.5 var(--mono);
          color: var(--ink-3);
          margin-top: 0.25rem;
        }
        .foot {
          font-size: 0.932rem;
          color: var(--ink-3);
          line-height: 1.7;
          margin-top: 1rem;
        }
        .foot b {
          color: var(--ink-2);
        }
      `}</style>
    </div>
  );
}
