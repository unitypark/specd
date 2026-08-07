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
 * GitLab adapter (§11). Same contract as GitHub — a branch plus a merge
 * request, never a direct push — with two shapes GitLab actually has instead
 * of GitHub's:
 *
 * A **personal or project access token** (`api` scope), not an App. There is
 * no equivalent of a GitHub App installation to mint short-lived scoped
 * tokens from, so the token is whatever the connection was given, for as long
 * as it is valid — the same trade-off GitHub PATs make, and the reason the
 * GitHub App exists at all. A gitlab.com OAuth app is optional wiring on top
 * of this class, not a change to it, exactly the relationship the GitHub App
 * has to a raw PAT there — and self-managed instances need a token regardless,
 * since an OAuth app would have to be registered per instance.
 *
 * A **self-managed instance URL**, since GitLab is commonly run on-prem
 * behind a VPN. Every request is relative to `{instanceUrl}/api/v4`, and
 * `instanceUrl` defaults to gitlab.com.
 *
 * The token is supplied per call by the caller, which decrypts it from the
 * vault inside the run that needs it (mirrors `GitHubAdapter`) — this class
 * never reads the vault and never holds a credential beyond the request.
 */
export class GitLabAdapter implements VcsAdapter {
  readonly provider = 'gitlab';
  private readonly apiBase: string;

  constructor(
    private readonly token: string,
    readonly instanceUrl = 'https://gitlab.com',
  ) {
    if (!token) {
      throw new VcsError('GitLab is connected but no token is available. Reconnect it in project settings.');
    }
    this.apiBase = `${instanceUrl.replace(/\/+$/, '')}/api/v4`;
  }

  private async api<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${this.apiBase}${path}`, {
      ...init,
      headers: {
        'PRIVATE-TOKEN': this.token,
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
    });

    if (!res.ok) {
      const body = await res.text();
      throw new VcsError(
        `GitLab ${init.method ?? 'GET'} ${path} → ${res.status}: ${body.slice(0, 300)}`,
      );
    }
    // 204 (branch delete) has no body.
    return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
  }

  /** `namespace/project`, which is what we store as the repository name. */
  private id(repo: Pick<RepoTarget, 'name'>): string {
    if (!repo.name.includes('/')) {
      throw new VcsError(`GitLab repository name must be "namespace/project", got "${repo.name}"`);
    }
    return encodeURIComponent(repo.name);
  }

  async snapshot(repo: RepoTarget): Promise<RepoSnapshot> {
    const id = this.id(repo);
    const meta = await this.api<{ default_branch: string }>(`/projects/${id}`);
    const defaultBranch = meta.default_branch || repo.defaultBranch;

    const [commit, tree] = await Promise.all([
      this.api<{ id: string }>(`/projects/${id}/repository/commits/${encodeURIComponent(defaultBranch)}`),
      this.tree(id, defaultBranch),
    ]);

    const files = tree
      .filter((n) => n.type === 'blob')
      .map((n) => n.path)
      .filter((p) => !p.split('/').some((seg) => IGNORED_DIRS.has(seg)));

    const wanted = new Set(MANIFEST_FILES);
    const samples: RepoFile[] = [];
    for (const path of files) {
      if (!wanted.has(path)) continue;
      const [file] = await this.readFilesAt(repo, [path], defaultBranch);
      if (file) samples.push({ ...file, content: file.content.slice(0, 40_000) });
    }

    return { files, samples, defaultBranch, headSha: commit.id };
  }

  /**
   * The repository tree, paginated. GitLab caps a page at 100 entries instead
   * of GitHub's one-call-with-a-truncated-flag, so getting the whole tree
   * means following `X-Next-Page` until it is empty. Capped at 50 pages
   * (5,000 entries) — enough for any repo worth scanning for a manifest file,
   * and a runaway loop is worse than an incomplete scan on the rare monorepo
   * past that.
   */
  private async tree(
    id: string,
    ref: string,
  ): Promise<{ path: string; type: string }[]> {
    const out: { path: string; type: string }[] = [];
    let page = '1';

    for (let i = 0; i < 50 && page; i++) {
      const res = await fetch(
        `${this.apiBase}/projects/${id}/repository/tree` +
          `?recursive=true&per_page=100&page=${page}&ref=${encodeURIComponent(ref)}`,
        { headers: { 'PRIVATE-TOKEN': this.token } },
      );
      if (!res.ok) {
        throw new VcsError(`GitLab GET repository/tree → ${res.status}: ${(await res.text()).slice(0, 300)}`);
      }
      out.push(...((await res.json()) as { path: string; type: string }[]));
      page = res.headers.get('x-next-page') ?? '';
    }

    return out;
  }

  async readFiles(repo: RepoTarget, paths: string[]): Promise<RepoFile[]> {
    return this.readFilesAt(repo, paths, repo.defaultBranch);
  }

  private async readFilesAt(repo: RepoTarget, paths: string[], ref: string): Promise<RepoFile[]> {
    const id = this.id(repo);
    const out: RepoFile[] = [];
    for (const path of paths) {
      try {
        const res = await this.api<{ content?: string; encoding?: string }>(
          `/projects/${id}/repository/files/${encodeURIComponent(path)}?ref=${encodeURIComponent(ref)}`,
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

  private async fileExistsAt(id: string, path: string, ref: string): Promise<boolean> {
    try {
      await this.api(`/projects/${id}/repository/files/${encodeURIComponent(path)}?ref=${encodeURIComponent(ref)}`);
      return true;
    } catch {
      return false;
    }
  }

  private async deleteBranchIfExists(id: string, branch: string): Promise<void> {
    try {
      await this.api(`/projects/${id}/repository/branches/${encodeURIComponent(branch)}`, {
        method: 'DELETE',
      });
    } catch {
      // Nothing to delete, or it never existed — either way the branch we are
      // about to create starts clean.
    }
  }

  async propose(repo: RepoTarget, change: ProposedChange): Promise<ChangeResult> {
    const id = this.id(repo);
    const meta = await this.api<{ default_branch: string }>(`/projects/${id}`);
    const base = meta.default_branch;

    // Reset to the tip of the default branch every time, the same way the
    // GitHub adapter force-resets its ref: a re-run must not layer new
    // content on top of a previous run's commit.
    await this.deleteBranchIfExists(id, change.branch);

    const actions = await Promise.all(
      change.files.map(async (file) => ({
        action: (await this.fileExistsAt(id, file.path, base)) ? ('update' as const) : ('create' as const),
        file_path: file.path,
        content: file.content,
      })),
    );

    await this.api(`/projects/${id}/repository/commits`, {
      method: 'POST',
      body: JSON.stringify({
        branch: change.branch,
        start_branch: base,
        commit_message: `${change.title}\n\n${change.body.split('\n')[0] ?? ''}`,
        actions,
      }),
    });

    const mr = await this.openMergeRequest(repo.name, {
      branch: change.branch,
      base,
      title: change.title,
      body: change.body,
    });

    return {
      branch: change.branch,
      url: mr.url,
      reviewHint: `Opened MR !${mr.iid} on ${repo.name}. Merging is adopting.`,
      filesWritten: change.files.length,
    };
  }

  /**
   * Open an MR for a branch that is *already pushed* — the build station's
   * path (mirrors `GitHubAdapter.openPullRequest`). Re-running a build must
   * update the existing MR rather than fail, so an already-open MR for the
   * branch is returned as-is rather than treated as an error.
   */
  async openMergeRequest(
    name: string,
    mr: { branch: string; base: string; title: string; body: string },
  ): Promise<{ url: string; iid: number; existing: boolean }> {
    const id = encodeURIComponent(name);
    try {
      const created = await this.api<{ web_url: string; iid: number }>(`/projects/${id}/merge_requests`, {
        method: 'POST',
        body: JSON.stringify({
          source_branch: mr.branch,
          target_branch: mr.base,
          title: mr.title,
          description: mr.body,
        }),
      });
      return { url: created.web_url, iid: created.iid, existing: false };
    } catch (err) {
      // GitLab refuses a second open MR for the same source/target — finding
      // it is the correct outcome, not a fallback.
      const open = await this.api<{ web_url: string; iid: number }[]>(
        `/projects/${id}/merge_requests?source_branch=${encodeURIComponent(mr.branch)}&state=opened`,
      ).catch(() => []);

      if (open.length > 0) {
        return { url: open[0]!.web_url, iid: open[0]!.iid, existing: true };
      }
      throw err;
    }
  }

  /** Repo picker source (§6 step 2, §11): what the token can see, searchable. */
  async listRepositories(
    search?: string,
  ): Promise<{ id: string; fullName: string; defaultBranch: string; namespace: string }[]> {
    const qs = new URLSearchParams({
      membership: 'true',
      simple: 'true',
      per_page: '50',
      order_by: 'last_activity_at',
    });
    if (search) qs.set('search', search);

    const res = await this.api<
      { id: number; path_with_namespace: string; default_branch: string | null; namespace: { full_path: string } }[]
    >(`/projects?${qs.toString()}`);

    return res.map((p) => ({
      id: String(p.id),
      fullName: p.path_with_namespace,
      defaultBranch: p.default_branch || 'main',
      namespace: p.namespace?.full_path ?? p.path_with_namespace.split('/').slice(0, -1).join('/'),
    }));
  }

  /**
   * Register specd's webhook on one project. Unlike a GitHub App, there is no
   * account-level hook — every GitLab repository needs its own, created with
   * whatever role the token holds (Maintainer or above). A token without that
   * role gets a 403 here, which the caller surfaces rather than treats as a
   * fatal add-repository error (§11: this degrades gracefully, same as local
   * mode's missing webhook — the repo still works, merges just are not
   * detected until someone fixes the token's role).
   */
  async registerWebhook(name: string, webhookUrl: string, secret: string): Promise<{ id: number }> {
    const id = encodeURIComponent(name);
    return this.api<{ id: number }>(`/projects/${id}/hooks`, {
      method: 'POST',
      body: JSON.stringify({
        url: webhookUrl,
        token: secret,
        push_events: true,
        merge_requests_events: true,
        enable_ssl_verification: true,
      }),
    });
  }
}
