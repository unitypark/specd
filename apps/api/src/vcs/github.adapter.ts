import {
  IGNORED_DIRS,
  MANIFEST_FILES,
  VcsError,
  type ChangeResult,
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
    const res = await fetch(`${this.apiBase}${path}`, {
      ...init,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${this.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
    });

    if (!res.ok) {
      const body = await res.text();
      throw new VcsError(`GitHub ${init.method ?? 'GET'} ${path} → ${res.status}: ${body.slice(0, 300)}`);
    }
    return (await res.json()) as T;
  }

  /** `owner/repo`, which is what we store as the repository name. */
  private slug(repo: RepoTarget): string {
    if (!repo.name.includes('/')) {
      throw new VcsError(`GitHub repository name must be "owner/repo", got "${repo.name}"`);
    }
    return repo.name;
  }

  async snapshot(repo: RepoTarget): Promise<RepoSnapshot> {
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

    const wanted = new Set(MANIFEST_FILES);
    const samples: RepoFile[] = [];
    for (const path of files) {
      if (!wanted.has(path)) continue;
      const [file] = await this.readFiles(repo, [path]);
      if (file) samples.push({ ...file, content: file.content.slice(0, 40_000) });
    }

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
    const snap = await this.snapshot(repo);
    return snap.files.filter((f) => f.startsWith(prefix));
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

    const pr = await this.api<{ html_url: string; number: number }>(`/repos/${slug}/pulls`, {
      method: 'POST',
      body: JSON.stringify({
        title: change.title,
        head: change.branch,
        base,
        body: change.body,
      }),
    });

    return {
      branch: change.branch,
      url: pr.html_url,
      reviewHint: `Opened PR #${pr.number} on ${slug}. Merging is adopting.`,
      filesWritten: change.files.length,
    };
  }

  /**
   * Open a PR for a branch that is *already pushed*.
   *
   * `propose` builds its commit through the API because it has file contents
   * and no checkout. The build station is the other way round: it has a real
   * clone with real commits, pushes them with git, and needs only the review
   * surface. Re-running a build must update the existing PR rather than fail,
   * so an already-open PR for the branch is returned as-is.
   */
  async openPullRequest(
    slug: string,
    pr: { branch: string; base: string; title: string; body: string },
  ): Promise<{ url: string; number: number; existing: boolean }> {
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
      return { url: created.html_url, number: created.number, existing: false };
    } catch (err) {
      // 422 is what GitHub returns when a PR for this head already exists.
      // Finding it is the correct outcome, not a fallback.
      const owner = slug.split('/')[0];
      const open = await this.api<{ html_url: string; number: number }[]>(
        `/repos/${slug}/pulls?head=${encodeURIComponent(`${owner}:${pr.branch}`)}&state=open`,
      ).catch(() => []);

      if (open.length > 0) {
        return { url: open[0]!.html_url, number: open[0]!.number, existing: true };
      }
      throw err;
    }
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
