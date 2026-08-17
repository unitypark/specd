import { collectSamples } from './scan-targets.js';
import {
  IGNORED_DIRS,
  VcsError,
  describeNonJsonBody,
  describeTransportFailure,
  reviewHint,
  type ChangeResult,
  type OpenedReview,
  type ProposedChange,
  type RepoFile,
  type RepoSnapshot,
  type RepoTarget,
  type VcsAdapter,
} from './vcs.types.js';

/**
 * GitHub adapter (§11). Same interface as local mode, different review
 * surface: a branch plus a pull request, written with a short-lived scoped
 * token. Never a direct push to the default branch — the write path is PRs
 * only, and that is the answer to "an agent with write access to our repos?"
 * (§15).
 *
 * The token is supplied per call by the caller, which decrypts it from the
 * vault inside the run that needs it. This class never reads the vault and
 * never holds a credential beyond the request.
 *
 * P1 uses a PAT or installation token directly. The GitHub App install flow
 * (which mints installation tokens per run) is P1-scope wiring on top of this
 * class, not a change to it.
 */
/** The origin of an API base, for an error message. Falls back to the raw value. */
function hostOf(apiBase: string): string {
  try {
    return new URL(apiBase).origin;
  } catch {
    return apiBase;
  }
}

export class GitHubAdapter implements VcsAdapter {
  readonly provider = 'github';

  constructor(
    private readonly token: string,
    private readonly apiBase = 'https://api.github.com',
  ) {
    if (!token) {
      throw new VcsError(
        'GitHub is connected but no token is available. Reconnect the GitHub App in project settings.',
      );
    }
  }

  private async api<T>(path: string, init: RequestInit = {}): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.apiBase}${path}`, {
        ...init,
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${this.token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json',
          ...(init.headers ?? {}),
        },
      });
    } catch (err) {
      // As in the GitLab adapter: a request that never reached the host
      // rejects with a TypeError, which is not an HttpException and so
      // reaches the caller as an opaque 500. Rare against api.github.com,
      // routine against an Enterprise Server behind a VPN.
      const explained = describeTransportFailure(err, hostOf(this.apiBase));
      if (explained) throw new VcsError(explained, err);
      throw err;
    }

    if (!res.ok) {
      const body = await res.text();
      throw new VcsError(`GitHub ${init.method ?? 'GET'} ${path} → ${res.status}: ${body.slice(0, 300)}`);
    }

    // As in the GitLab adapter: an unguarded `res.json()` turns an SSO portal's
    // login page — served at 200 in front of an Enterprise Server — into a
    // SyntaxError, which is not an HttpException and reaches a user as a 500.
    const body = await res.text();
    try {
      return JSON.parse(body) as T;
    } catch {
      throw new VcsError(describeNonJsonBody(`${hostOf(this.apiBase)}${path.split('?')[0]}`, body));
    }
  }

  /** `owner/repo`, which is what we store as the repository name. */
  private slug(repo: RepoTarget): string {
    if (!repo.name.includes('/')) {
      throw new VcsError(`GitHub repository name must be "owner/repo", got "${repo.name}"`);
    }
    return repo.name;
  }

  /** The visible file tree at the tip of the default branch. */
  private async tree(
    repo: RepoTarget,
  ): Promise<{ files: string[]; defaultBranch: string; headSha: string }> {
    const slug = this.slug(repo);
    const meta = await this.api<{ default_branch: string }>(`/repos/${slug}`);
    const defaultBranch = meta.default_branch || repo.defaultBranch;

    const ref = await this.api<{ object: { sha: string } }>(
      `/repos/${slug}/git/ref/heads/${defaultBranch}`,
    );
    const headSha = ref.object.sha;

    const tree = await this.api<{ tree: { path: string; type: string }[]; truncated: boolean }>(
      `/repos/${slug}/git/trees/${headSha}?recursive=1`,
    );

    const files = tree.tree
      .filter((n) => n.type === 'blob')
      .map((n) => n.path)
      .filter((p) => !p.split('/').some((seg) => IGNORED_DIRS.has(seg)));

    return { files, defaultBranch, headSha };
  }

  async snapshot(repo: RepoTarget): Promise<RepoSnapshot> {
    const { files, defaultBranch, headSha } = await this.tree(repo);

    const samples = await collectSamples(files, async (target) => {
      const [file] = await this.readFiles(repo, [target.path]);
      return file ?? null;
    });

    return { files, samples, defaultBranch, headSha };
  }

  async readFiles(repo: RepoTarget, paths: string[]): Promise<RepoFile[]> {
    const slug = this.slug(repo);
    const out: RepoFile[] = [];
    for (const path of paths) {
      try {
        const res = await this.api<{ content?: string; encoding?: string }>(
          `/repos/${slug}/contents/${encodeURI(path)}`,
        );
        if (res.content && res.encoding === 'base64') {
          out.push({ path, content: Buffer.from(res.content, 'base64').toString('utf8') });
        }
      } catch {
        // Missing file — the caller's list is a request, not a guarantee.
      }
    }
    return out;
  }

  async listFiles(repo: RepoTarget, prefix: string): Promise<string[]> {
    // Deliberately the tree, not `snapshot()`: listing paths must not drag in
    // the scan's file reads, which the indexer would pay for on every run.
    const { files } = await this.tree(repo);
    return files.filter((f) => f.startsWith(prefix));
  }

  async listFilesWithSha(
    repo: RepoTarget,
    prefix: string,
  ): Promise<{ path: string; sha: string }[]> {
    const slug = this.slug(repo);
    const meta = await this.api<{ default_branch: string }>(`/repos/${slug}`);
    const branch = meta.default_branch || repo.defaultBranch;
    const ref = await this.api<{ object: { sha: string } }>(
      `/repos/${slug}/git/ref/heads/${branch}`,
    );
    const tree = await this.api<{ tree: { path: string; type: string; sha: string }[] }>(
      `/repos/${slug}/git/trees/${ref.object.sha}?recursive=1`,
    );
    return tree.tree
      .filter((n) => n.type === 'blob' && n.path.startsWith(prefix))
      .filter((n) => !n.path.split('/').some((seg) => IGNORED_DIRS.has(seg)))
      .map((n) => ({ path: n.path, sha: n.sha }));
  }

  async propose(repo: RepoTarget, change: ProposedChange): Promise<ChangeResult> {
    const slug = this.slug(repo);
    const meta = await this.api<{ default_branch: string }>(`/repos/${slug}`);
    const base = meta.default_branch;

    const baseRef = await this.api<{ object: { sha: string } }>(
      `/repos/${slug}/git/ref/heads/${base}`,
    );

    // Branch from the tip of the default branch, creating or resetting it.
    try {
      await this.api(`/repos/${slug}/git/refs`, {
        method: 'POST',
        body: JSON.stringify({ ref: `refs/heads/${change.branch}`, sha: baseRef.object.sha }),
      });
    } catch {
      await this.api(`/repos/${slug}/git/refs/heads/${change.branch}`, {
        method: 'PATCH',
        body: JSON.stringify({ sha: baseRef.object.sha, force: true }),
      });
    }

    // One commit carrying every file, built as a tree so the PR reads as a
    // single reviewable change rather than a stream of per-file commits.
    const blobs = await Promise.all(
      change.files.map(async (file) => {
        const blob = await this.api<{ sha: string }>(`/repos/${slug}/git/blobs`, {
          method: 'POST',
          body: JSON.stringify({
            content: Buffer.from(file.content, 'utf8').toString('base64'),
            encoding: 'base64',
          }),
        });
        return { path: file.path, mode: '100644' as const, type: 'blob' as const, sha: blob.sha };
      }),
    );

    const tree = await this.api<{ sha: string }>(`/repos/${slug}/git/trees`, {
      method: 'POST',
      body: JSON.stringify({ base_tree: baseRef.object.sha, tree: blobs }),
    });

    const commit = await this.api<{ sha: string }>(`/repos/${slug}/git/commits`, {
      method: 'POST',
      body: JSON.stringify({
        message: `${change.title}\n\n${change.body.split('\n')[0] ?? ''}`,
        tree: tree.sha,
        parents: [baseRef.object.sha],
      }),
    });

    await this.api(`/repos/${slug}/git/refs/heads/${change.branch}`, {
      method: 'PATCH',
      body: JSON.stringify({ sha: commit.sha, force: true }),
    });

    // Goes through `openPullRequest` rather than posting one directly: the
    // branch above was force-reset, so if a PR is already open for it that PR
    // now shows the new commit and wants returning, not repeating. Posting
    // directly meant re-grounding a repository died on GitHub's 422 with the
    // scaffold already written and the branch already moved.
    const pr = await this.openPullRequest(slug, {
      branch: change.branch,
      base,
      title: change.title,
      body: change.body,
    });

    return {
      branch: change.branch,
      url: pr.url,
      reviewHint: reviewHint('PR', slug, pr),
      filesWritten: change.files.length,
    };
  }

  /**
   * Open a PR for `branch`, or update the one already open for it.
   *
   * Shared by both write paths, which arrive from opposite directions: the
   * build station has a real clone whose commits it pushed with git, while
   * `propose` has file contents and builds its commit through the API. Both
   * end at the same place, and for both a re-run must update the open PR
   * rather than fail on it — GitHub answers 422 to a second PR for one head.
   *
   * Updating includes the description, because both callers write one that
   * describes *this* run and no other: onboarding states a file count, an
   * UNVERIFIED count and whether a model drafted anything at all; a build
   * states the commit count and whether verify passed. Leaving the first run's
   * description over the second run's branch tells a reviewer verify passed
   * when this time it did not — the exact misreading `buildPrBody` is written
   * to prevent.
   */
  async openPullRequest(
    slug: string,
    pr: { branch: string; base: string; title: string; body: string },
  ): Promise<OpenedReview> {
    try {
      const created = await this.api<{ html_url: string; number: number }>(
        `/repos/${slug}/pulls`,
        {
          method: 'POST',
          body: JSON.stringify({
            title: pr.title,
            head: pr.branch,
            base: pr.base,
            body: pr.body,
          }),
        },
      );
      return { url: created.html_url, number: created.number, existing: false, descriptionStale: false };
    } catch (err) {
      // 422 is what GitHub returns when a PR for this head already exists.
      // Finding it is the correct outcome, not a fallback.
      const owner = slug.split('/')[0];
      const open = await this.api<{ html_url: string; number: number }[]>(
        `/repos/${slug}/pulls?head=${encodeURIComponent(`${owner}:${pr.branch}`)}&state=open`,
      ).catch(() => []);

      const found = open[0];
      if (!found) throw err;

      // Best-effort on purpose. The branch is already published and the PR
      // already exists, so throwing here would fail a run over its last and
      // least consequential call — the shape of failure this method was
      // extracted to stop. The caller says so instead.
      const descriptionStale = await this.api(`/repos/${slug}/pulls/${found.number}`, {
        method: 'PATCH',
        body: JSON.stringify({ title: pr.title, body: pr.body }),
      }).then(
        () => false,
        () => true,
      );

      return { url: found.html_url, number: found.number, existing: true, descriptionStale };
    }
  }

  /**
   * Prove a token, and say who it belongs to.
   *
   * Only meaningful for a user token — an App installation token has no user,
   * and the App path proves itself by listing what it was granted instead.
   * Used at connect time by local mode's review credential.
   */
  async verify(): Promise<{ username: string; name: string }> {
    const me = await this.api<{ login: string; name: string | null }>('/user');
    return { username: me.login, name: me.name ?? me.login };
  }

  /** Repo picker source: exactly what the installation was granted (§6 step 2). */
  async listInstallationRepositories(): Promise<
    { id: string; fullName: string; defaultBranch: string; language: string | null }[]
  > {
    const res = await this.api<{
      repositories: { id: number; full_name: string; default_branch: string; language: string | null }[];
    }>('/installation/repositories?per_page=100');

    return res.repositories.map((r) => ({
      id: String(r.id),
      fullName: r.full_name,
      defaultBranch: r.default_branch,
      language: r.language,
    }));
  }
}
